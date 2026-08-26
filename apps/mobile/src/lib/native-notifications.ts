import Constants from "expo-constants";
import * as Device from "expo-device";
import { Platform } from "react-native";

export type NativeNotificationPermissionState = {
  status: "granted" | "denied" | "undetermined" | "unsupported";
  canAskAgain: boolean;
};

function projectId() {
  return Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
}

export async function getNativePushToken() {
  if (!Device.isDevice) return null;
  const id = projectId();
  if (!id) return null;
  const Notifications = await import("expo-notifications");
  const token = await Notifications.getExpoPushTokenAsync({ projectId: id });
  return token.data;
}

export async function getNativeNotificationPermissionState(): Promise<NativeNotificationPermissionState> {
  if (Platform.OS !== "ios" && Platform.OS !== "android") {
    return { status: "unsupported", canAskAgain: false };
  }
  if (!Device.isDevice) return { status: "unsupported", canAskAgain: false };

  try {
    const Notifications = await import("expo-notifications");
    const permission = await Notifications.getPermissionsAsync();
    const status = permission.status === "granted"
      ? "granted"
      : permission.status === "denied"
        ? "denied"
        : "undetermined";
    return { status, canAskAgain: permission.canAskAgain };
  } catch {
    return { status: "unsupported", canAskAgain: false };
  }
}

export async function enableNativeNotifications() {
  if (!Device.isDevice) throw new Error("Push notifications require a physical device.");
  const Notifications = await import("expo-notifications");

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("show-operations", {
      name: "Show operations",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 180, 90, 180],
      lightColor: "#FFC107",
    });
  }

  const current = await Notifications.getPermissionsAsync();
  const permission = current.status === "granted" ? current : await Notifications.requestPermissionsAsync();
  if (permission.status !== "granted") throw new Error("Notification permission was not granted.");

  const token = await getNativePushToken();
  if (!token) {
    return { granted: true as const, token: null };
  }
  return { granted: true as const, token };
}
