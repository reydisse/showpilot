export const PERSONAL_NOTIFICATION_COUNT_EVENT = "showpilot-personal-notification-count";

export interface PersonalNotificationCountDetail {
  orgId: string;
  unread: number;
}

function normalizeUnreadCount(unread: number): number {
  return Number.isFinite(unread) ? Math.max(0, Math.trunc(unread)) : 0;
}

export function announcePersonalNotificationCount(orgId: string, unread: number) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<PersonalNotificationCountDetail>(
    PERSONAL_NOTIFICATION_COUNT_EVENT,
    { detail: { orgId, unread: normalizeUnreadCount(unread) } },
  ));
}

export function readPersonalNotificationCount(event: Event): PersonalNotificationCountDetail | null {
  if (!(event instanceof CustomEvent)) return null;
  const detail: unknown = event.detail;
  if (!detail || typeof detail !== "object") return null;
  const { orgId, unread } = detail as Partial<PersonalNotificationCountDetail>;
  if (typeof orgId !== "string" || !orgId || typeof unread !== "number" || !Number.isFinite(unread)) return null;
  return { orgId, unread: normalizeUnreadCount(unread) };
}
