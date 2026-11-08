import { getD1 } from "./d1";
import { markDatabaseWrite } from "./request-database.server";
import { crewScheduleTokenSchema } from "./crew-response-contract";
export const crewLinkDenied =
  "This schedule link is invalid, revoked or has expired. Ask your team leader for a new link.";
export async function resolveCrewScheduleAccess(
  token: string,
  db: Pick<D1Database, "prepare"> = getD1(),
) {
  const parsed = crewScheduleTokenSchema.parse(token);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(parsed),
  );
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const live = `a.revokedAt IS NULL AND julianday(a.expiresAt)>julianday('now')
   AND NOT EXISTS(SELECT 1 FROM app_setting WHERE orgId=a.orgId AND key='organization-deleting')`;
  const row = await db
    .prepare(
      `SELECT a.id,a.orgId,a.crewMemberId,a.assignmentId FROM crew_schedule_access a
   JOIN crew_member c ON c.orgId=a.orgId AND c.id=a.crewMemberId
   WHERE a.tokenHash=? AND ${live}`,
    )
    .bind(hash)
    .first<{
      id: string;
      orgId: string;
      crewMemberId: string;
      assignmentId: string | null;
    }>();
  if (!row) throw new Error(crewLinkDenied);
  const guard = `EXISTS(SELECT 1 FROM crew_schedule_access a JOIN crew_member c ON c.orgId=a.orgId AND c.id=a.crewMemberId
   WHERE a.id=? AND a.orgId=? AND a.crewMemberId=? AND a.tokenHash=? AND ${live})`;
  const guardArgs = [row.id, row.orgId, row.crewMemberId, hash];
  await db
    .prepare(
      `UPDATE crew_schedule_access SET lastUsedAt=CURRENT_TIMESTAMP WHERE id=? AND ${guard}`,
    )
    .bind(row.id, ...guardArgs)
    .run();
  markDatabaseWrite();
  return { ...row, guard, guardArgs };
}
export async function assertCrewScheduleAccess(
  access: Awaited<ReturnType<typeof resolveCrewScheduleAccess>>,
  db: Pick<D1Database, "prepare"> = getD1(),
) {
  if (
    !(await db
      .prepare(`SELECT 1 WHERE ${access.guard}`)
      .bind(...access.guardArgs)
      .first())
  )
    throw new Error(crewLinkDenied);
}
