export type NotificationFailure = { message: string; at: number };
export type NotificationDeliveryStage =
  | { kind: "ready" }
  | { kind: "working"; previousFailure: NotificationFailure | null }
  | { kind: "failed"; failure: NotificationFailure };
export type NotificationDeliveryChannel = "inbox" | "actions";
export type DesktopNotificationState =
  | { kind: "starting"; previousFailure: NotificationFailure | null }
  | { kind: "load-failed"; failure: NotificationFailure }
  | {
      kind: "running";
      inbox: NotificationDeliveryStage;
      actions: NotificationDeliveryStage;
    };
