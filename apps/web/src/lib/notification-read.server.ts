import { getAuth } from "./auth";
import { getD1 } from "./d1";
import { z } from "zod";

const authority = `EXISTS (SELECT 1 FROM member m JOIN session s ON s.userId=m.userId
  WHERE m.organizationId=? AND m.userId=? AND s.id=? AND
  (CASE WHEN typeof(s.expiresAt) IN ('integer','real') THEN s.expiresAt
    ELSE (julianday(s.expiresAt)-2440587.5)*86400000 END)>(julianday('now')-2440587.5)*86400000)`;

export async function markInboxRead(
  headers: Headers,
  command: { orgId: string; requestId: string; notificationId: string | null },
) {
  const session = await getAuth().api.getSession({
    headers,
    query: { disableCookieCache: true },
  });
  if (!session)
    throw new Error("Sign in before marking notifications as read.");
  const { orgId, requestId, notificationId } = command;
  const key = [orgId, session.user.id, requestId];
  const actor = [orgId, session.user.id, session.session.id];
  const db = getD1();
  const [, result] = await db.batch([
    db
      .prepare(
        `INSERT INTO notification_read_receipt (orgId,userId,requestId,notificationId)
      SELECT ?,?,?,? WHERE ${authority}
      ON CONFLICT(orgId,userId,requestId) DO NOTHING`,
      )
      .bind(...key, notificationId, ...actor),
    db
      .prepare(
        `SELECT notificationId,readAt FROM notification_read_receipt
      WHERE orgId=? AND userId=? AND requestId=? AND ${authority}`,
      )
      .bind(...key, ...actor),
  ]);
  const row = result.results[0];
  if (!row)
    throw new Error(
      "Your session or workspace membership is no longer active.",
    );
  const receipt = z
    .object({ notificationId: z.string().nullable(), readAt: z.string() })
    .parse(row);
  if (receipt.notificationId !== notificationId)
    throw new Error("This request belongs to a different notification action.");
  return { ok: true as const, requestId, readAt: receipt.readAt };
}
