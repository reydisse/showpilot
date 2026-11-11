import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import {
  type NotificationCategory,
  type NotificationPreference,
} from "@showpilot/shared";
import { z } from "zod";
import { getD1 } from "@/lib/d1";
import { getPrisma } from "@/lib/db";
import {
  readNotificationPreferences,
  writeNotificationPreference,
  readPreferenceActor,
} from "@/lib/notification-preferences.server";
import { notificationPreferenceCommandSchema } from "./notification-preference-contract";
import { idSchema, parseOrThrow } from "@/lib/validation";
import { markInboxRead } from "./notification-read.server";
import { readNotificationTimeZone, writeNotificationTimeZone } from "./notification-timezone.server";
import { notificationTimeZoneCommandSchema } from "./notification-timezone-contract";

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

export interface NotificationCursor {
  createdAt: string;
  id: string;
}

const notificationPageInput = z.object({
  orgId: idSchema,
  cursor: z.object({ createdAt: z.string().min(1).max(64), id: idSchema }).optional(),
});

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
  .inputValidator((data: unknown) => parseOrThrow(notificationPageInput, data))
  .handler(async ({ data }): Promise<{ notifications: PersonalNotification[]; unread: number; nextCursor: NotificationCursor | null }> => {
    const userId = await assertInboxAccess(data.orgId);
    const db = getD1();
    const [rows, unreadRow] = await Promise.all([
      db.prepare(
        `SELECT id, type, severity, title, message, actionUrl, source, createdAt, readAt, category
         FROM notification
         WHERE orgId = ? AND userId = ? AND dismissed = 0
           ${data.cursor ? "AND (julianday(createdAt) < julianday(?) OR (julianday(createdAt) = julianday(?) AND id < ?))" : ""}
         ORDER BY julianday(createdAt) DESC, id DESC LIMIT 31`,
      ).bind(
        data.orgId,
        userId,
        ...(data.cursor ? [data.cursor.createdAt, data.cursor.createdAt, data.cursor.id] : []),
      ).all<PersonalNotification>(),
      db.prepare(
        `SELECT CAST(COUNT(*) AS INTEGER) AS count
         FROM notification
         WHERE orgId = ? AND userId = ? AND dismissed = 0 AND readAt IS NULL`,
      ).bind(data.orgId, userId).first<{ count: number }>(),
    ]);
    const page = rows.results ?? [];
    const notifications = page.slice(0, 30);
    const last = notifications.at(-1);
    return {
      notifications,
      unread: unreadRow?.count ?? 0,
      nextCursor: page.length > 30 && last ? { createdAt: last.createdAt, id: last.id } : null,
    };
  });

export const getPersonalNotificationCount = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }) => {
    const userId = await assertInboxAccess(data.orgId);
    const row = await getD1().prepare(
      `SELECT CAST(COUNT(*) AS INTEGER) AS unread FROM notification
       WHERE orgId=? AND userId=? AND dismissed=0 AND readAt IS NULL`,
    ).bind(data.orgId, userId).first();
    return z.object({ unread: z.number().int().nonnegative() }).parse(row);
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
         ORDER BY julianday(createdAt) DESC, id DESC LIMIT 30`,
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

export const getPersonalNotificationTimeZone = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }) => readNotificationTimeZone(getRequestHeaders(), data.orgId));

/** Remember the active device zone without replaying over a newer save. */
export const savePersonalNotificationTimeZone = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(notificationTimeZoneCommandSchema, data))
  .handler(async ({ data }) => writeNotificationTimeZone(getRequestHeaders(), data));

export const updatePersonalNotificationPreference = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(notificationPreferenceCommandSchema, data))
  .handler(async ({ data }) => writeNotificationPreference({
    command: data, actor: await readPreferenceActor(getRequestHeaders()),
  }));

export const markPersonalNotificationRead = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema, id: idSchema, requestId: z.string().uuid() }).strict(), data))
  .handler(async ({ data }) => markInboxRead(getRequestHeaders(), { ...data, notificationId: data.id }));

export const markAllPersonalNotificationsRead = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema, requestId: z.string().uuid() }).strict(), data))
  .handler(async ({ data }) => markInboxRead(getRequestHeaders(), { ...data, notificationId: null }));
