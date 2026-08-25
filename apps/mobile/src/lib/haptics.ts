import * as ExpoHaptics from "expo-haptics";
import { Platform } from "react-native";

export const NotificationFeedbackType = ExpoHaptics.NotificationFeedbackType;

export async function selectionAsync(): Promise<void> {
  if (Platform.OS === "web") return;
  await ExpoHaptics.selectionAsync();
}

export async function notificationAsync(
  type: ExpoHaptics.NotificationFeedbackType,
): Promise<void> {
  if (Platform.OS === "web") return;
  await ExpoHaptics.notificationAsync(type);
}
