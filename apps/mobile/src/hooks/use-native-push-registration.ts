import { useEffect } from "react";
import type { NotificationResponse } from "expo-notifications";
import { Platform } from "react-native";
import { saveMobilePushToken } from "@/lib/mobile-api";
import { getNativePushToken } from "@/lib/native-notifications";
import { openNotificationDestination } from "@/lib/notification-destination";

export function useNativePushRegistration(orgId?: string) {
  const nativePlatform = Platform.OS === "ios" || Platform.OS === "android" ? Platform.OS : null;
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
    let removeListener: (() => void) | undefined;
    const openNotification = (response: NotificationResponse) => {
      openNotificationDestination(response.notification.request.content.data?.url);
    };
    void import("expo-notifications").then(async (Notifications) => {
      if (disposed) return;
      const subscription = Notifications.addNotificationResponseReceivedListener(openNotification);
      removeListener = () => subscription.remove();
      const response = await Notifications.getLastNotificationResponseAsync();
      if (!response || disposed) return;
      openNotification(response);
      await Notifications.clearLastNotificationResponseAsync();
    }).catch(() => {
      // Native notification routing is best-effort during app startup.
    });
    return () => {
      disposed = true;
      removeListener?.();
    };
  }, [nativePlatform]);
}
