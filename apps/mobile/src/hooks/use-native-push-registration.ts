import { useEffect } from "react";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { saveMobilePushToken } from "@/lib/mobile-api";
import { getNativePushToken } from "@/lib/native-notifications";
import { openNotificationDestination } from "@/lib/notification-destination";

export function useNativePushRegistration(orgId?: string) {
  const nativePlatform = Platform.OS === "ios" || Platform.OS === "android" ? Platform.OS : null;
  useEffect(() => {
    if (!orgId || !nativePlatform) return;
    let disposed = false;

    void Notifications.getPermissionsAsync().then(async (permission) => {
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
    const openNotification = (response: Notifications.NotificationResponse) => {
      openNotificationDestination(response.notification.request.content.data?.url);
    };
    const subscription = Notifications.addNotificationResponseReceivedListener(openNotification);
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (!response) return;
      openNotification(response);
      void Notifications.clearLastNotificationResponseAsync();
    });
    return () => subscription.remove();
  }, []);
}
