import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { NotificationResponse } from "expo-notifications";
import { router } from "expo-router";
import { Platform } from "react-native";
import { authClient } from "@/lib/auth-client";
import { markNotificationRead, saveMobilePushToken } from "@/lib/mobile-api";
import { getNativePushToken, isNativePushConfigured } from "@/lib/native-notifications";
import { openNotificationDestination } from "@/lib/notification-destination";

export function useNativePushRegistration(orgId?: string) {
  const queryClient = useQueryClient();
  const activeOrgId = useRef(orgId);
  const nativePlatform = (Platform.OS === "ios" || Platform.OS === "android") && isNativePushConfigured()
    ? Platform.OS
    : null;
  useEffect(() => {
    activeOrgId.current = orgId;
  }, [orgId]);
  useEffect(() => {
    if (!orgId || !nativePlatform) return;
    let disposed = false;

    void import("expo-notifications").then(async (Notifications) => {
      const permission = await Notifications.getPermissionsAsync();
      if (disposed || permission.status !== "granted") return;
      const token = await getNativePushToken();
      if (!disposed && token) await saveMobilePushToken(orgId, token, nativePlatform);
    }).catch(() => {
      // Registration is retried on the next authenticated launch. It must not
      // block access to the app when notification services are unavailable.
    });

    return () => {
      disposed = true;
    };
  }, [nativePlatform, orgId]);

  useEffect(() => {
    if (!nativePlatform) return;
    let disposed = false;
    const removeListeners: (() => void)[] = [];
    const refreshOrganization = (targetOrgId: unknown) => {
      if (typeof targetOrgId !== "string" || !targetOrgId) return;
      void queryClient.invalidateQueries({ queryKey: ["mobile-bootstrap", targetOrgId] });
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
        await queryClient.invalidateQueries({ queryKey: ["mobile-bootstrap", targetOrgId] });
      }
      if (!disposed) openNotificationDestination(data?.url);
    };
    void import("expo-notifications").then(async (Notifications) => {
      if (disposed) return;
      const receivedSubscription = Notifications.addNotificationReceivedListener((notification) => {
        refreshOrganization(notification.request.content.data?.orgId);
      });
      const responseSubscription = Notifications.addNotificationResponseReceivedListener((response) => {
        void openNotification(response);
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
