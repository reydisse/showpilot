import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
  type NotificationPreference,
} from "@showpilot/shared";
import { getD1 } from "@/lib/d1";
import { getAuth } from "./auth";
import type {
  ChecklistWriteDatabase,
  ChecklistWriteStatement,
} from "./checklist-write.server";
import type {
  NotificationPreferenceCommand,
  NotificationPreferenceResult,
} from "./notification-preference-contract";
interface PreferenceStatement extends ChecklistWriteStatement {
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results?: T[] }>;
}
export interface NotificationPreferenceDatabase extends ChecklistWriteDatabase {
  prepare(sql: string): { bind(...params: unknown[]): PreferenceStatement };
}
export class NotificationPreferenceError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function readPreferenceActor(headers: Headers) {
  const session = await getAuth().api.getSession({
    headers,
    query: { disableCookieCache: true },
  });
  if (!session)
    throw new NotificationPreferenceError(
      401,
      "Sign in before changing notification preferences.",
    );
  return { userId: session.user.id, sessionId: session.session.id };
}

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
  database: NotificationPreferenceDatabase = getD1(),
): Promise<NotificationPreference[]> {
  const result = await database
    .prepare(
      `SELECT category, deviceAlerts
     FROM notification_preference
     WHERE orgId = ? AND userId = ?`,
    )
    .bind(orgId, userId)
    .all<PreferenceRow>();
  const saved = new Map(
    (result.results ?? [])
      .filter(
        (row): row is PreferenceRow & { category: NotificationCategory } =>
          isNotificationCategory(row.category),
      )
      .map((row) => [row.category, Boolean(row.deviceAlerts)]),
  );
  return DEFAULT_NOTIFICATION_PREFERENCES.map((preference) => ({
    category: preference.category,
    deviceAlerts: saved.get(preference.category) ?? preference.deviceAlerts,
  }));
}

const currentAuthority = `EXISTS (SELECT 1 FROM member m JOIN session s ON s.userId=m.userId
  WHERE m.organizationId=? AND m.userId=? AND s.id=? AND
  (CASE WHEN typeof(s.expiresAt) IN ('integer','real') THEN s.expiresAt
    ELSE (julianday(s.expiresAt)-2440587.5)*86400000 END)>(julianday('now')-2440587.5)*86400000)`;

/** Commit a preference and its receipt together; a replay only reads current state. */
export async function writeNotificationPreference({
  command,
  actor,
  database = getD1(),
}: {
  command: NotificationPreferenceCommand;
  actor: { userId: string; sessionId: string };
  database?: NotificationPreferenceDatabase;
}): Promise<NotificationPreferenceResult> {
  const { orgId, category, deviceAlerts, expectedDeviceAlerts } = command;
  const requestId = command.requestId ?? crypto.randomUUID();
  const fingerprint = JSON.stringify([
    category,
    deviceAlerts,
    expectedDeviceAlerts ?? null,
  ]);
  const claimId = crypto.randomUUID();
  const defaultAlerts =
    DEFAULT_NOTIFICATION_PREFERENCES.find((p) => p.category === category)
      ?.deviceAlerts ?? true;
  const authority = [orgId, actor.userId, actor.sessionId];
  const key = [orgId, actor.userId, requestId];
  await database.batch([
    database
      .prepare(
        `INSERT OR IGNORE INTO notification_preference_receipt
      (orgId,userId,requestId,fingerprint,claimId,outcome)
      SELECT ?,?,?,?,?,CASE WHEN ? IS NULL OR
        COALESCE((SELECT deviceAlerts FROM notification_preference WHERE orgId=? AND userId=? AND category=?),?) IN (?,?)
        THEN 'applied' ELSE 'conflict' END WHERE ${currentAuthority}`,
      )
      .bind(
        ...key,
        fingerprint,
        claimId,
        expectedDeviceAlerts ?? null,
        orgId,
        actor.userId,
        category,
        defaultAlerts ? 1 : 0,
        expectedDeviceAlerts ?? null,
        deviceAlerts ? 1 : 0,
        ...authority,
      ),
    database
      .prepare(
        `INSERT INTO notification_preference
      (id,orgId,userId,category,deviceAlerts,createdAt,updatedAt)
      SELECT ?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
      WHERE EXISTS (SELECT 1 FROM notification_preference_receipt
        WHERE orgId=? AND userId=? AND requestId=? AND claimId=? AND outcome='applied')
      ON CONFLICT(orgId,userId,category) DO UPDATE SET deviceAlerts=excluded.deviceAlerts,updatedAt=CURRENT_TIMESTAMP`,
      )
      .bind(
        crypto.randomUUID(),
        orgId,
        actor.userId,
        category,
        deviceAlerts ? 1 : 0,
        ...key,
        claimId,
      ),
  ]);
  const receipt = await database
    .prepare(
      `SELECT fingerprint,outcome FROM notification_preference_receipt
    WHERE orgId=? AND userId=? AND requestId=? AND ${currentAuthority}`,
    )
    .bind(...key, ...authority)
    .first<{ fingerprint: string; outcome: "applied" | "conflict" }>();
  if (!receipt)
    throw new NotificationPreferenceError(
      403,
      "Your session or workspace membership is no longer active.",
    );
  if (receipt.fingerprint !== fingerprint)
    throw new NotificationPreferenceError(
      409,
      "This request belongs to a different preference change. Reload preferences before making another change.",
    );
  const current = await database
    .prepare(
      `SELECT deviceAlerts FROM notification_preference WHERE orgId=? AND userId=? AND category=?`,
    )
    .bind(orgId, actor.userId, category)
    .first<{ deviceAlerts: number | boolean }>();
  const preference = {
    category,
    deviceAlerts: current ? Boolean(current.deviceAlerts) : defaultAlerts,
  };
  return {
    outcome:
      receipt.outcome === "conflict"
        ? "conflict"
        : preference.deviceAlerts === deviceAlerts
          ? "applied"
          : "superseded",
    preference,
  };
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
  const result = await getD1()
    .prepare(
      `SELECT userId, category, deviceAlerts
     FROM notification_preference
     WHERE orgId = ? AND category = ? AND userId IN (${placeholders})`,
    )
    .bind(orgId, category, ...userIds)
    .all<PreferenceRow>();
  for (const row of result.results ?? []) {
    if (row.userId) preferences.set(row.userId, Boolean(row.deviceAlerts));
  }
  return preferences;
}
