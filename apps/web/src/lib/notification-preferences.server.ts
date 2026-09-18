import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
  type NotificationPreference,
} from "@showpilot/shared";
import { getD1 } from "@/lib/d1";

interface PreferenceRow {
  userId?: string;
  category: string;
  deviceAlerts: number | boolean;
}

function isNotificationCategory(value: string): value is NotificationCategory {
  return (NOTIFICATION_CATEGORIES as readonly string[]).includes(value);
}

export async function readNotificationPreferences(
  orgId: string,
  userId: string,
): Promise<NotificationPreference[]> {
  const result = await getD1().prepare(
    `SELECT category, deviceAlerts
     FROM notification_preference
     WHERE orgId = ? AND userId = ?`,
  ).bind(orgId, userId).all<PreferenceRow>();
  const saved = new Map(
    (result.results ?? [])
      .filter((row): row is PreferenceRow & { category: NotificationCategory } =>
        isNotificationCategory(row.category),
      )
      .map((row) => [row.category, Boolean(row.deviceAlerts)]),
  );
  return DEFAULT_NOTIFICATION_PREFERENCES.map((preference) => ({
    category: preference.category,
    deviceAlerts: saved.get(preference.category) ?? preference.deviceAlerts,
  }));
}

export async function saveNotificationPreference(
  orgId: string,
  userId: string,
  category: NotificationCategory,
  deviceAlerts: boolean,
): Promise<void> {
  await getD1().prepare(
    `INSERT INTO notification_preference
       (id, orgId, userId, category, deviceAlerts, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(orgId, userId, category) DO UPDATE SET
       deviceAlerts = excluded.deviceAlerts,
       updatedAt = CURRENT_TIMESTAMP`,
  ).bind(
    crypto.randomUUID(),
    orgId,
    userId,
    category,
    deviceAlerts ? 1 : 0,
  ).run();
}

export async function readRecipientNotificationPreferences(
  orgId: string,
  userIds: readonly string[],
  category: NotificationCategory,
): Promise<Map<string, boolean>> {
  const preferences = new Map<string, boolean>();
  for (const userId of userIds) preferences.set(userId, true);
  if (userIds.length === 0) return preferences;

  const placeholders = userIds.map(() => "?").join(",");
  const result = await getD1().prepare(
    `SELECT userId, category, deviceAlerts
     FROM notification_preference
     WHERE orgId = ? AND category = ? AND userId IN (${placeholders})`,
  ).bind(orgId, category, ...userIds).all<PreferenceRow>();
  for (const row of result.results ?? []) {
    if (row.userId) preferences.set(row.userId, Boolean(row.deviceAlerts));
  }
  return preferences;
}
