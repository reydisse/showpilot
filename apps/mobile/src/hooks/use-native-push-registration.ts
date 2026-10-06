import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { NotificationResponse } from "expo-notifications";
import { router } from "expo-router";
import { AppState, Platform } from "react-native";
import { authClient } from "@/lib/auth-client";
import { markNotificationRead, saveMobilePushToken } from "@/lib/mobile-api";
import { registerNativeNotifications, isNativePushConfigured } from "@/lib/native-notifications";
import { openNotificationDestination } from "@/lib/notification-destination";

export function useNativePushRegistration(orgId?: string) {
  const queryClient = useQueryClient();
  const { data: session } = authClient.useSession();
  const userId = session?.user.id;
  const activeOrgId = useRef(orgId);
  const nativePlatform = (Platform.OS === "ios" || Platform.OS === "android") && isNativePushConfigured()
    ? Platform.OS
    : null;
  useEffect(() => {
    activeOrgId.current = orgId;
  }, [orgId]);
  useEffect(() => {
    if (!orgId || !nativePlatform || !userId) return;
    const registrationOrgId = orgId;
    const registrationPlatform = nativePlatform;
    let disposed = false;
    let registering = false;
    let refreshQueued = false;
    let failures = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let removeTokenListener: (() => void) | undefined;

    async function register() {
      if (disposed || AppState.currentState !== "active") return;
      if (registering) { refreshQueued = true; return; }
      registering = true;
      clearTimeout(retryTimer);
      try {
        const token = await registerNativeNotifications(true);
        if (!disposed && token) await saveMobilePushToken(registrationOrgId, token, registrationPlatform);
        failures = 0;
      } catch (error) {
        // A temporary network/APNs failure should recover without an app restart.
        if (!disposed && failures < 3) {
          retryTimer = setTimeout(() => void register(), [1_000, 5_000, 15_000][failures++]);
        }
        console.warn("[push] Device registration failed", { message: error instanceof Error ? error.message : "Unknown registration error" });
      } finally {
        registering = false;
        if (!disposed && refreshQueued) { refreshQueued = false; void register(); }
      }
    }
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") { failures = 0; void register(); }
    });
    void import("expo-notifications").then((Notifications) => {
      if (disposed) return;
      const subscription = Notifications.addPushTokenListener(() => { void register(); });
      removeTokenListener = () => subscription.remove();
    }).catch(() => undefined);
    void register();
    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      appState.remove();
      removeTokenListener?.();
    };
  }, [nativePlatform, orgId, userId]);

  useEffect(() => {
    if (!nativePlatform) return;
    let disposed = false;
    const removeListeners: (() => void)[] = [];
    const refreshOrganization = (targetOrgId: unknown) => {
      if (typeof targetOrgId !== "string" || !targetOrgId) return;
      void queryClient.invalidateQueries({ queryKey: ["mobile-bootstrap"] });
      void queryClient.invalidateQueries({ queryKey: ["mobile-chat-unread"] });
    };
    const openNotification = async (response: NotificationResponse) => {
      const data = response.notification.request.content.data;
      const targetOrgId = typeof data?.orgId === "string" ? data.orgId : activeOrgId.current;
      const notificationId = typeof data?.notificationId === "string" ? data.notificationId : null;
      if (targetOrgId && targetOrgId !== activeOrgId.current) {
        const active = await authClient.organization.setActive({ organizationId: targetOrgId });
        if (active.error) {
          if (!disposed) router.push("/organizations");
          return;
        }
      }
      if (targetOrgId && notificationId) {
        await markNotificationRead(targetOrgId, notificationId).catch(() => undefined);
      }
      if (targetOrgId) {
        await queryClient.invalidateQueries({ queryKey: ["mobile-bootstrap"] });
      }
      if (!disposed) openNotificationDestination(data?.url);
    };
    void import("expo-notifications").then(async (Notifications) => {
      if (disposed) return;
      const receivedSubscription = Notifications.addNotificationReceivedListener((notification) => {
        refreshOrganization(notification.request.content.data?.orgId);
      });
      const responseSubscription = Notifications.addNotificationResponseReceivedListener((response) => {
        void openNotification(response).catch(() => {
          if (!disposed) router.push("/inbox");
        });
      });
      removeListeners.push(
        () => receivedSubscription.remove(),
        () => responseSubscription.remove(),
      );
      const response = await Notifications.getLastNotificationResponseAsync();
      if (!response || disposed) return;
      await openNotification(response);
      await Notifications.clearLastNotificationResponseAsync();
    }).catch(() => {
      // Native notification routing is best-effort during app startup.
    });
    return () => {
      disposed = true;
      for (const remove of removeListeners) remove();
    };
  }, [nativePlatform, queryClient]);
}
