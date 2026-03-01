export type NotificationSeverity = "info" | "warning" | "critical";

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
