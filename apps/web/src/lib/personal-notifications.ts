import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import {
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
  type NotificationPreference,
} from "@showpilot/shared";
import { z } from "zod";
import { getD1 } from "@/lib/d1";
import { getPrisma } from "@/lib/db";
import {
  readNotificationPreferences,
  saveNotificationPreference,
} from "@/lib/notification-preferences.server";
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
  category: NotificationCategory;
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
        `SELECT id, type, severity, title, message, actionUrl, source, createdAt, readAt, category
         FROM notification
         WHERE orgId = ? AND userId = ? AND dismissed = 0
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

export const getPersonalDeviceNotifications = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }): Promise<{ notifications: PersonalNotification[]; unread: number }> => {
    const userId = await assertInboxAccess(data.orgId);
    const [rows, unreadRow] = await Promise.all([
      getD1().prepare(
        `SELECT id, type, severity, title, message, actionUrl, source, createdAt, readAt, category
         FROM notification
         WHERE orgId = ? AND userId = ? AND dismissed = 0 AND deviceAlertEnabled = 1
         ORDER BY createdAt DESC LIMIT 30`,
      ).bind(data.orgId, userId).all<PersonalNotification>(),
      getD1().prepare(
        `SELECT CAST(COUNT(*) AS INTEGER) AS count
         FROM notification
         WHERE orgId = ? AND userId = ? AND dismissed = 0 AND readAt IS NULL`,
      ).bind(data.orgId, userId).first<{ count: number }>(),
    ]);
    return { notifications: rows.results ?? [], unread: unreadRow?.count ?? 0 };
  });

export const getPersonalNotificationPreferences = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }): Promise<NotificationPreference[]> => {
    const userId = await assertInboxAccess(data.orgId);
    return readNotificationPreferences(data.orgId, userId);
  });

const updateNotificationPreferenceSchema = z.object({
  orgId: idSchema,
  category: z.enum(NOTIFICATION_CATEGORIES),
  deviceAlerts: z.boolean(),
});

export const updatePersonalNotificationPreference = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(updateNotificationPreferenceSchema, data))
  .handler(async ({ data }): Promise<{ preference: NotificationPreference }> => {
    const userId = await assertInboxAccess(data.orgId);
    await saveNotificationPreference(data.orgId, userId, data.category, data.deviceAlerts);
    return {
      preference: {
        category: data.category,
        deviceAlerts: data.deviceAlerts,
      },
    };
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
