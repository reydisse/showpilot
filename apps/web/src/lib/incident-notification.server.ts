import { waitUntil } from "cloudflare:workers";
import { notifyOperationalEvent, type OperationalNotification } from "./operational-notifications.server";

/** Preserve existing best-effort inbox/push delivery without holding a committed
 * save open. Only the request that claimed the receipt schedules this work. */
export function scheduleIncidentNotification(notification: OperationalNotification): void {
  waitUntil(notifyOperationalEvent(notification));
}
