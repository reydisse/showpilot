import type { NotificationCategory } from "@showpilot/shared";
import { getD1 } from "@/lib/d1";
import { getPrisma } from "@/lib/db";
import { readRecipientNotificationPreferences } from "@/lib/notification-preferences.server";
import { normalizeRole } from "@/lib/permissions";

const LEADERSHIP_ROLES = new Set(["owner", "admin", "td", "cd", "pd", "pm", "sm", "tm"]);

export type OperationalNotification = {
  orgId: string;
  actorId?: string | null;
  recipientIds?: readonly string[];
  includeLeadership?: boolean;
  category: NotificationCategory;
  type: string;
  severity?: "info" | "warning" | "critical";
  title: string;
  message: string;
  actionUrl: string;
  source: string;
  pushTag: string;
  /**
   * Replaces an earlier notification for the same recipient and event instead
   * of creating duplicates when an operation is retried.
   */
  dedupeKey?: string;
};

async function notificationIdFor(
  input: Pick<OperationalNotification, "orgId" | "dedupeKey">,
  userId: string,
) {
  if (!input.dedupeKey) return crypto.randomUUID();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${input.orgId}:${userId}:${input.dedupeKey}`),
  );
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `evt_${hash.slice(0, 48)}`;
}

/**
 * Writes one personal inbox item per recipient and best-effort delivers push.
 * Operational writes must never be rolled back because a browser push endpoint
 * is unavailable, so delivery errors are isolated per recipient.
 */
async function deliverOperationalEvent(input: OperationalNotification) {
  const requestedRecipients = new Set(input.recipientIds ?? []);
  const recipients = new Set<string>();
  if (requestedRecipients.size > 0 || input.includeLeadership) {
    const members = await getPrisma().member.findMany({
      where: {
        organizationId: input.orgId,
        ...(!input.includeLeadership && requestedRecipients.size > 0
          ? { userId: { in: [...requestedRecipients] } }
          : {}),
      },
      select: { userId: true, role: true },
    });
    for (const member of members) {
      const role = normalizeRole(member.role);
      if (
        requestedRecipients.has(member.userId)
        || (input.includeLeadership && role && LEADERSHIP_ROLES.has(role))
      ) {
        recipients.add(member.userId);
      }
    }
  }
  if (input.actorId) recipients.delete(input.actorId);
  if (recipients.size === 0) return { notified: 0 };

  const recipientIds = [...recipients];
  const preferences = await readRecipientNotificationPreferences(
    input.orgId,
    recipientIds,
    input.category,
  );

  const org = await getPrisma().organization.findUnique({
    where: { id: input.orgId },
    select: { slug: true },
  });
  const severity = input.severity ?? "info";
  const url = org?.slug
    ? `/${encodeURIComponent(org.slug)}/${input.actionUrl.replace(/^\/+/, "")}`
    : "/";

  const results = await Promise.all(
    recipientIds.map(async (userId) => {
      try {
        const deviceAlerts = preferences.get(userId) ?? true;
        const notificationId = await notificationIdFor(input, userId);
        await getD1()
          .prepare(
            `INSERT INTO notification
             (id, orgId, userId, type, severity, title, message, target, source, actionUrl,
              category, deviceAlertEnabled, dismissed, createdAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             ON CONFLICT(id) DO UPDATE SET
               type = excluded.type,
               severity = excluded.severity,
               title = excluded.title,
               message = excluded.message,
               target = excluded.target,
               source = excluded.source,
               actionUrl = excluded.actionUrl,
               category = excluded.category,
               deviceAlertEnabled = excluded.deviceAlertEnabled,
               dismissed = 0,
               readAt = NULL,
               createdAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
          )
          .bind(
            notificationId,
            input.orgId,
            userId,
            input.type,
            severity,
            input.title,
            input.message,
            `user:${userId}`,
            input.source,
            input.actionUrl,
            input.category,
            deviceAlerts ? 1 : 0,
          )
          .run();
        if (deviceAlerts) {
          try {
            const { deliverPushToUser } = await import("@/lib/push-delivery.server");
            await deliverPushToUser(input.orgId, userId, {
              title: input.title,
              body: input.message,
              url,
              tag: input.pushTag,
              notificationId,
            });
          } catch (error) {
            console.error("[Notifications] Push delivery failed", error);
          }
        }
        return true;
      } catch (error) {
        console.error("[Notifications] Operational delivery failed", error);
        return false;
      }
    }),
  );
  return { notified: results.filter(Boolean).length };
}

/** Notification work must not change the outcome of an already-saved action. */
export async function notifyOperationalEvent(input: OperationalNotification) {
  try {
    return await deliverOperationalEvent(input);
  } catch (error) {
    console.error("[Notifications] Preparation failed", error);
    return { notified: 0 };
  }
}
