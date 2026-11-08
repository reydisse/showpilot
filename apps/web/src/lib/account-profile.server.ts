import { z } from "zod";
import { getAuth } from "./auth";
import { getD1 } from "./d1";
import {
  profileCommandSchema,
  profileStateSchema,
  type ProfileCommand,
} from "./account-profile-contract";

export class AccountProfileError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 409 | 413,
    message: string,
  ) {
    super(message);
  }
}
export async function profileActor(headers: Headers) {
  const session = await getAuth().api.getSession({
    headers,
    query: { disableCookieCache: true },
  });
  if (!session)
    throw new AccountProfileError(401, "Sign in before updating your profile.");
  return { userId: session.user.id, sessionId: session.session.id };
}
const authority = `EXISTS(SELECT 1 FROM session s WHERE s.userId=? AND s.id=? AND
  (CASE WHEN typeof(s.expiresAt) IN ('integer','real') THEN s.expiresAt
  ELSE (julianday(s.expiresAt)-2440587.5)*86400000 END)>(julianday('now')-2440587.5)*86400000)`;
const stateSql = `SELECT u.id AS userId,u.name,u.image,COALESCE(r.revision,0) AS revision FROM user u
  LEFT JOIN user_profile_revision r ON r.userId=u.id WHERE u.id=? AND ${authority}`;
const denied = () =>
  new AccountProfileError(
    401,
    "Your sign-in is no longer active. Sign in again before updating your profile.",
  );
export const profilePhotoKey = (userId: string, hash: string) =>
  `avatars/${userId}/${hash}.jpg`;
export const profilePhotoPath = (userId: string, hash: string) =>
  `/api/user/avatar/${userId}/${hash}.jpg`;

export async function readAccountProfile(headers: Headers) {
  const actor = await profileActor(headers);
  const row = await getD1()
    .prepare(stateSql)
    .bind(actor.userId, actor.userId, actor.sessionId)
    .first();
  if (!row) throw denied();
  return profileStateSchema.parse(row);
}
function fingerprint(command: ProfileCommand) {
  return JSON.stringify([
    command.expectedRevision,
    command.kind,
    command.kind === "name" ? command.name : command.hash,
  ]);
}
export async function checkProfileRequest(
  actor: Awaited<ReturnType<typeof profileActor>>,
  command: ProfileCommand,
) {
  if (actor.userId !== command.userId)
    throw new AccountProfileError(
      409,
      "Your account changed. Reopen your profile before saving.",
    );
  const row = await getD1()
    .prepare(
      "SELECT fingerprint FROM user_profile_receipt WHERE userId=? AND requestId=?",
    )
    .bind(actor.userId, command.requestId)
    .first<{ fingerprint: string }>();
  if (row && row.fingerprint !== fingerprint(command))
    throw new AccountProfileError(
      409,
      "This request belongs to a different profile change.",
    );
}

/** The value, revision trigger and receipt commit in one D1 transaction. */
export async function writeAccountProfile(
  headers: Headers,
  input: ProfileCommand,
) {
  const command = profileCommandSchema.parse(input);
  const actor = await profileActor(headers);
  await checkProfileRequest(actor, command);
  const db = getD1(),
    claimId = crypto.randomUUID(),
    key = [actor.userId, command.requestId],
    auth = [actor.userId, actor.sessionId];
  const value =
    command.kind === "name"
      ? command.name
      : profilePhotoPath(actor.userId, command.hash);
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO user_profile_receipt(userId,requestId,fingerprint,claimId,outcome,revision)
      SELECT ?,?,?,?,CASE WHEN COALESCE((SELECT revision FROM user_profile_revision WHERE userId=?),0)=?
      THEN 'applied' ELSE 'conflict' END,? WHERE ${authority}
      ON CONFLICT(userId,requestId) DO NOTHING`,
      )
      .bind(
        ...key,
        fingerprint(command),
        claimId,
        actor.userId,
        command.expectedRevision,
        command.expectedRevision + 1,
        ...auth,
      ),
    // Only the column name varies, from a closed discriminant. Values stay bound.
    db
      .prepare(
        command.kind === "name"
          ? `UPDATE user SET name=?,updatedAt=? WHERE id=? AND EXISTS(SELECT 1 FROM user_profile_receipt WHERE userId=? AND requestId=? AND claimId=? AND outcome='applied')`
          : `UPDATE user SET image=?,updatedAt=? WHERE id=? AND EXISTS(SELECT 1 FROM user_profile_receipt WHERE userId=? AND requestId=? AND claimId=? AND outcome='applied')`,
      )
      .bind(value, new Date().toISOString(), actor.userId, ...key, claimId),
    db
      .prepare(
        `SELECT fingerprint,outcome,revision FROM user_profile_receipt WHERE userId=? AND requestId=? AND ${authority}`,
      )
      .bind(...key, ...auth),
    db.prepare(stateSql).bind(actor.userId, ...auth),
  ]);
  const row = results[2].results[0],
    current = results[3].results[0];
  if (!row || !current) throw denied();
  const receipt = z
    .object({
      fingerprint: z.string(),
      outcome: z.enum(["applied", "conflict"]),
      revision: z.number().int(),
    })
    .parse(row);
  if (receipt.fingerprint !== fingerprint(command))
    throw new AccountProfileError(
      409,
      "This request belongs to a different profile change.",
    );
  const state = profileStateSchema.parse(current);
  return {
    requestId: command.requestId,
    outcome:
      receipt.outcome === "conflict"
        ? "conflict"
        : state.revision === receipt.revision
          ? "applied"
          : "superseded",
    state,
  };
}
