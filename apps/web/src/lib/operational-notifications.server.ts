import { getD1 } from "@/lib/d1";
import { getPrisma } from "@/lib/db";
import { normalizeRole } from "@/lib/permissions";

const LEADERSHIP_ROLES = new Set(["owner", "admin", "td", "cd", "pd", "pm", "sm", "tm"]);

export type OperationalNotification = {
  orgId: string;
  actorId?: string | null;
  recipientIds?: readonly string[];
  includeLeadership?: boolean;
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
export async function notifyOperationalEvent(input: OperationalNotification) {
  const recipients = new Set(input.recipientIds ?? []);
  if (input.includeLeadership) {
    const members = await getPrisma().member.findMany({
      where: { organizationId: input.orgId },
      select: { userId: true, role: true },
    });
    for (const member of members) {
      const role = normalizeRole(member.role);
      if (role && LEADERSHIP_ROLES.has(role)) recipients.add(member.userId);
    }
  }
  if (input.actorId) recipients.delete(input.actorId);
  if (recipients.size === 0) return { notified: 0 };

  const org = await getPrisma().organization.findUnique({
    where: { id: input.orgId },
    select: { slug: true },
  });
  const severity = input.severity ?? "info";
  const url = org?.slug
    ? `/${encodeURIComponent(org.slug)}/${input.actionUrl.replace(/^\/+/, "")}`
    : "/";

  const results = await Promise.all(
    [...recipients].map(async (userId) => {
      try {
        const notificationId = await notificationIdFor(input, userId);
        await getD1()
          .prepare(
            `INSERT INTO notification
             (id, orgId, userId, type, severity, title, message, target, source, actionUrl, dismissed, createdAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
             ON CONFLICT(id) DO UPDATE SET
               type = excluded.type,
               severity = excluded.severity,
               title = excluded.title,
               message = excluded.message,
               target = excluded.target,
               source = excluded.source,
               actionUrl = excluded.actionUrl,
               dismissed = 0,
               readAt = NULL,
               createdAt = CURRENT_TIMESTAMP`,
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
          )
          .run();
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
        return true;
      } catch (error) {
        console.error("[Notifications] Operational delivery failed", error);
        return false;
      }
    }),
  );
  return { notified: results.filter(Boolean).length };
}
