import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { getD1 } from "@/lib/d1";
import { getPrisma } from "@/lib/db";
import { idSchema, parseOrThrow } from "@/lib/validation";

export interface PersonalNotification {
  id: string;
  type: string;
  severity: string;
  title: string;
  message: string;
  actionUrl: string;
  source: string;
  createdAt: string;
  readAt: string | null;
}

async function assertInboxAccess(orgId: string) {
  const { getAuth } = await import("@/lib/auth");
  const session = await getAuth().api.getSession({ headers: getRequestHeaders() });
  if (!session) throw new Error("Unauthorized");
  const member = await getPrisma().member.findFirst({
    where: { organizationId: orgId, userId: session.user.id }, select: { id: true },
  });
  if (!member) throw new Error("Forbidden");
  return session.user.id;
}

export const getPersonalNotifications = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }): Promise<{ notifications: PersonalNotification[]; unread: number }> => {
    const userId = await assertInboxAccess(data.orgId);
    const db = getD1();
    const [rows, unreadRow] = await Promise.all([
      db.prepare(
        `SELECT id, type, severity, title, message, actionUrl, source, createdAt, readAt
         FROM notification WHERE orgId = ? AND userId = ? AND dismissed = 0
         ORDER BY createdAt DESC LIMIT 30`,
      ).bind(data.orgId, userId).all<PersonalNotification>(),
      db.prepare(
        `SELECT CAST(COUNT(*) AS INTEGER) AS count
         FROM notification
         WHERE orgId = ? AND userId = ? AND dismissed = 0 AND readAt IS NULL`,
      ).bind(data.orgId, userId).first<{ count: number }>(),
    ]);
    const notifications = rows.results ?? [];
    return { notifications, unread: unreadRow?.count ?? 0 };
  });

export const markPersonalNotificationRead = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema, id: idSchema }), data))
  .handler(async ({ data }) => {
    const userId = await assertInboxAccess(data.orgId);
    await getD1().prepare(
      `UPDATE notification SET readAt = COALESCE(readAt, CURRENT_TIMESTAMP)
       WHERE id = ? AND orgId = ? AND userId = ?`,
    ).bind(data.id, data.orgId, userId).run();
    return { ok: true as const };
  });

export const markAllPersonalNotificationsRead = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }) => {
    const userId = await assertInboxAccess(data.orgId);
    await getD1().prepare(
      `UPDATE notification SET readAt = CURRENT_TIMESTAMP
       WHERE orgId = ? AND userId = ? AND readAt IS NULL`,
    ).bind(data.orgId, userId).run();
    return { ok: true as const };
  });
