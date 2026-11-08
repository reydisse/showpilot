import { z } from "zod";
import { getAuth } from "./auth";
import { getD1 } from "./d1";
import {
  notificationTimeZoneStateSchema,
  type NotificationTimeZoneCommand,
} from "./notification-timezone-contract";

const authority = `EXISTS (SELECT 1 FROM member m JOIN session s ON s.userId=m.userId
  WHERE m.organizationId=? AND m.userId=? AND s.id=? AND
  (CASE WHEN typeof(s.expiresAt) IN ('integer','real') THEN s.expiresAt
    ELSE (julianday(s.expiresAt)-2440587.5)*86400000 END)>(julianday('now')-2440587.5)*86400000)`;
async function actorFor(headers: Headers) {
  const session = await getAuth().api.getSession({
    headers,
    query: { disableCookieCache: true },
  });
  if (!session) throw new Error("Sign in before checking your alert timezone.");
  return { userId: session.user.id, sessionId: session.session.id };
}
const stateSql = `SELECT
  (SELECT value FROM app_setting WHERE orgId=? AND key=?) AS timeZone,
  COALESCE((SELECT revision FROM notification_timezone_revision WHERE orgId=? AND userId=?),0) AS revision
  WHERE ${authority}`;
const denied = () =>
  new Error("Your session or workspace membership is no longer active.");

export async function readNotificationTimeZone(
  headers: Headers,
  orgId: string,
) {
  const actor = await actorFor(headers);
  const row = await getD1()
    .prepare(stateSql)
    .bind(
      orgId,
      `notification-timezone:${actor.userId}`,
      orgId,
      actor.userId,
      orgId,
      actor.userId,
      actor.sessionId,
    )
    .first();
  if (!row) throw denied();
  return notificationTimeZoneStateSchema.parse(row);
}

export async function writeNotificationTimeZone(
  headers: Headers,
  command: NotificationTimeZoneCommand,
) {
  const actor = await actorFor(headers);
  const { orgId, requestId, expectedRevision, timeZone } = command;
  const key = [orgId, actor.userId, requestId];
  const auth = [orgId, actor.userId, actor.sessionId];
  const settingKey = `notification-timezone:${actor.userId}`;
  const fingerprint = JSON.stringify([expectedRevision, timeZone]);
  const claimId = crypto.randomUUID();
  const db = getD1();
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO notification_timezone_receipt(orgId,userId,requestId,fingerprint,claimId,outcome,revision)
      SELECT ?,?,?,?,?,CASE WHEN COALESCE((SELECT revision FROM notification_timezone_revision WHERE orgId=? AND userId=?),0)=?
        THEN 'applied' ELSE 'conflict' END,? WHERE ${authority}
      ON CONFLICT(orgId,userId,requestId) DO NOTHING`,
      )
      .bind(
        ...key,
        fingerprint,
        claimId,
        orgId,
        actor.userId,
        expectedRevision,
        expectedRevision + 1,
        ...auth,
      ),
    db
      .prepare(
        `INSERT INTO app_setting(id,orgId,key,value)
      SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM notification_timezone_receipt
        WHERE orgId=? AND userId=? AND requestId=? AND claimId=? AND outcome='applied')
      ON CONFLICT(orgId,key) DO UPDATE SET value=excluded.value`,
      )
      .bind(crypto.randomUUID(), orgId, settingKey, timeZone, ...key, claimId),
    db
      .prepare(
        `SELECT fingerprint,outcome,revision FROM notification_timezone_receipt
      WHERE orgId=? AND userId=? AND requestId=? AND ${authority}`,
      )
      .bind(...key, ...auth),
    db.prepare(stateSql).bind(orgId, settingKey, orgId, actor.userId, ...auth),
  ]);
  const receiptRow = results[2].results[0],
    stateRow = results[3].results[0];
  if (!receiptRow || !stateRow) throw denied();
  const receipt = z
    .object({
      fingerprint: z.string(),
      outcome: z.enum(["applied", "conflict"]),
      revision: z.number().int(),
    })
    .parse(receiptRow);
  if (receipt.fingerprint !== fingerprint)
    throw new Error("This request belongs to a different timezone change.");
  const state = notificationTimeZoneStateSchema.parse(stateRow);
  const outcome =
    receipt.outcome === "conflict"
      ? "conflict"
      : state.revision === receipt.revision && state.timeZone === timeZone
        ? "applied"
        : "superseded";
  return { requestId, outcome, state };
}
