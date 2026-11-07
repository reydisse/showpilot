import { getD1 } from "./d1";
import { hasPermission } from "./app-permissions";
import type { GraphicLibraryReset } from "./graphic-library-reset-contract";
import type { LiveSessionAuthorityClaim } from "./live-rundown-authority.server";

export type GraphicResetDatabase = Pick<D1Database, "prepare" | "batch">;
const activeSession = `(CASE WHEN typeof(s.expiresAt) IN ('integer','real') THEN s.expiresAt ELSE (julianday(s.expiresAt)-2440587.5)*86400000 END)>(julianday('now')-2440587.5)*86400000`;

// Program resolves template IDs from this table. A reset must never erase live output.
// Malformed output pointers also block reset until the operator clears Program.
const programIdle = `NOT EXISTS(SELECT 1 FROM app_setting WHERE orgId=? AND (
  (key='active-graphics' AND CASE WHEN json_valid(value) THEN CASE WHEN json_type(value)='array' THEN json_array_length(value)>0 ELSE 1 END ELSE value<>'' END) OR
  (key='active-graphic' AND value<>'')
))`;

/** Delete templates once, only with Program idle. Saved scenes are separate. */
export async function resetSavedGraphics({ command, authority, database = getD1() }: {
  command: GraphicLibraryReset;
  authority: LiveSessionAuthorityClaim;
  database?: GraphicResetDatabase;
}) {
  if (command.orgId !== authority.orgId) throw new Error("Organization mismatch.");
  const member = await database.prepare(`SELECT m.id,m.role,m.managementRevision,o.name FROM member m
    JOIN organization o ON o.id=m.organizationId JOIN session s ON s.userId=m.userId
    WHERE m.organizationId=? AND m.userId=? AND s.id=? AND ${activeSession}`)
    .bind(command.orgId,authority.userId,authority.sessionId)
    .first<{id:string;role:string;managementRevision:number;name:string}>();
  if (!member || !hasPermission(member.role,"settings:danger_zone"))
    throw new Error("You no longer have permission to reset this organization's saved graphics.");
  const guard = `EXISTS(SELECT 1 FROM member m JOIN session s ON s.userId=m.userId
    WHERE m.organizationId=? AND m.id=? AND m.userId=? AND m.role=? AND m.managementRevision=? AND s.id=? AND ${activeSession})`;
  const guardArgs = [command.orgId,member.id,authority.userId,member.role,member.managementRevision,authority.sessionId];
  const key = [command.orgId,authority.userId,command.requestId];
  const read = () => database.prepare(`SELECT confirmName,deletedCount FROM graphic_library_reset_receipt WHERE orgId=? AND actorId=? AND requestId=? AND ${guard}`)
    .bind(...key,...guardArgs).first<{confirmName:string;deletedCount:number}>();
  let receipt = await read();
  if (!receipt) {
    if (command.confirmName !== member.name) throw new Error("Type the organization's exact name to reset its saved graphics.");
    const idle = await database.prepare(`SELECT 1 AS idle WHERE ${programIdle}`).bind(command.orgId).first();
    if (!idle) throw new Error("Graphics are on air or their output state is unknown. Clear Program in Graphics before resetting saved graphics.");
    const claimId = crypto.randomUUID();
    await database.batch([
      database.prepare(`INSERT OR IGNORE INTO graphic_library_reset_receipt(orgId,actorId,requestId,confirmName,claimId,deletedCount)
        SELECT ?,?,?,?,?,(SELECT COUNT(*) FROM graphic_template WHERE orgId=?)
        WHERE ${guard} AND EXISTS(SELECT 1 FROM organization WHERE id=? AND name=?) AND ${programIdle}`)
        .bind(...key,command.confirmName,claimId,command.orgId,...guardArgs,command.orgId,command.confirmName,command.orgId),
      database.prepare(`DELETE FROM graphic_template WHERE orgId=? AND ${guard}
        AND EXISTS(SELECT 1 FROM graphic_library_reset_receipt WHERE orgId=? AND actorId=? AND requestId=? AND claimId=?)`)
        .bind(command.orgId,...guardArgs,...key,claimId),
    ]);
    receipt = await read();
  }
  if (!receipt) throw new Error("Your access, organization, or Program changed. Review it before resetting saved graphics.");
  if (receipt.confirmName !== command.confirmName) throw new Error("This request already refers to a different confirmation.");
  return {requestId:command.requestId,deletedCount:receipt.deletedCount};
}
