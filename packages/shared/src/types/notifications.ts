export type NotificationSeverity = "info" | "warning" | "critical";

export const NOTIFICATION_CATEGORIES = [
  "schedule",
  "incidents",
  "chat",
  "reports",
  "system",
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export interface NotificationPreference {
  category: NotificationCategory;
  deviceAlerts: boolean;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: readonly NotificationPreference[] =
  NOTIFICATION_CATEGORIES.map((category) => ({
    category,
    deviceAlerts: true,
  }));

export function notificationCategoryForType(type: string): NotificationCategory {
  if (type === "assignment" || type.startsWith("assignment-")) return "schedule";
  if (
    type.startsWith("incident-")
    || type.startsWith("fault-")
    || type === "comment-reaction"
  ) return "incidents";
  if (type.startsWith("chat-")) return "chat";
  if (type.startsWith("post-show-")) return "reports";
  return "system";
}

export type NotificationTarget =
  | "all"
  | "tech-manager"
  | "audio"
  | "production-manager"
  | "show";

export interface AppNotification {
  id: string;
  type: string;
  severity: NotificationSeverity;
  title: string;
  message: string;
  target: NotificationTarget;
  source: string;
  createdAt: string; // ISO 8601
  dismissed: boolean;
}
