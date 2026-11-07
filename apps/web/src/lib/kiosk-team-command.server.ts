import { getD1 } from "./d1";
import { hasPermission } from "./app-permissions";
import {
  kioskTeamResultSchema,
  type KioskTeamCommand,
} from "./kiosk-team-contract";
export type KioskTeamDatabase = Pick<D1Database, "prepare" | "batch">;
type Actor = { userId: string; sessionId: string };
const liveSession = `(CASE WHEN typeof(s.expiresAt) IN ('integer','real') THEN s.expiresAt ELSE (julianday(s.expiresAt)-2440587.5)*86400000 END)>(julianday('now')-2440587.5)*86400000`;
const notDeleting = `NOT EXISTS(SELECT 1 FROM app_setting WHERE orgId=m.organizationId AND key='organization-deleting')`;
export async function executeKioskTeamCommand(
  command: KioskTeamCommand,
  actor: Actor,
  database: KioskTeamDatabase = getD1(),
) {
  const member = await database
    .prepare(
      `SELECT m.id,m.role,m.managementRevision FROM member m JOIN session s ON s.userId=m.userId WHERE m.organizationId=? AND m.userId=? AND s.id=? AND ${liveSession} AND ${notDeleting}`,
    )
    .bind(command.orgId, actor.userId, actor.sessionId)
    .first<{ id: string; role: string; managementRevision: number }>();
  if (!member || !hasPermission(member.role, "settings:members"))
    throw new Error(
      "Your session or permission to edit kiosk teams is no longer active.",
    );
  const guard = `EXISTS(SELECT 1 FROM member m JOIN session s ON s.userId=m.userId WHERE m.organizationId=? AND m.id=? AND m.userId=? AND m.role=? AND m.managementRevision=? AND s.id=? AND ${liveSession} AND ${notDeleting})`;
  const guardArgs = [
    command.orgId,
    member.id,
    actor.userId,
    member.role,
    member.managementRevision,
    actor.sessionId,
  ];
  const fingerprint = JSON.stringify(command),
    claimId = crypto.randomUUID();
  const teamId = command.action === "create" ? crypto.randomUUID() : command.id;
  const scope = [command.orgId, actor.userId, command.requestId];
  const existing = await database
    .prepare(
      `SELECT teamId,fingerprint,outcome FROM kiosk_team_command_receipt WHERE orgId=? AND actorId=? AND requestId=? AND ${guard}`,
    )
    .bind(...scope, ...guardArgs)
    .first<{ teamId: string; fingerprint: string; outcome: string }>();
  if (existing) {
    if (existing.fingerprint !== fingerprint)
      throw new Error(
        "This request already belongs to a different team command.",
      );
    return kioskTeamResultSchema.parse({
      id: existing.teamId,
      requestId: command.requestId,
      outcome: existing.outcome,
    });
  }
  const owns = `EXISTS(SELECT 1 FROM kiosk_team_command_receipt WHERE orgId=? AND actorId=? AND requestId=? AND claimId=? AND outcome='applied')`;
  const ownsArgs = [...scope, claimId];
  const reviewed =
    command.action === "create"
      ? "1"
      : "EXISTS(SELECT 1 FROM team WHERE orgId=? AND id=? AND revision=?)";
  const reviewedArgs =
    command.action === "create"
      ? []
      : [command.orgId, command.id, command.revision];
  // A person must still be in this org when the transaction commits.
  const person =
    command.action === "set-member"
      ? "EXISTS(SELECT 1 FROM member WHERE organizationId=? AND userId=?)"
      : "1";
  const personArgs =
    command.action === "set-member" ? [command.orgId, command.userId] : [];
  const statements = [
    database
      .prepare(
        `INSERT INTO kiosk_team_command_receipt(orgId,actorId,requestId,fingerprint,claimId,teamId,outcome)
  SELECT ?,?,?,?,?,?,CASE WHEN ${reviewed} AND ${person} THEN 'applied' ELSE 'conflict' END WHERE ${guard}
  ON CONFLICT(orgId,actorId,requestId) DO NOTHING`,
      )
      .bind(
        ...scope,
        fingerprint,
        claimId,
        teamId,
        ...reviewedArgs,
        ...personArgs,
        ...guardArgs,
      ),
  ];
  switch (command.action) {
    case "create":
      statements.push(
        database
          .prepare(
            `INSERT INTO team(id,orgId,name,color,sortOrder) SELECT ?,?,?,?,(SELECT COALESCE(MAX(sortOrder),0)+1 FROM team WHERE orgId=?) WHERE ${owns}`,
          )
          .bind(
            teamId,
            command.orgId,
            command.name,
            command.color,
            command.orgId,
            ...ownsArgs,
          ),
      );
      break;
    case "delete":
      statements.push(
        database
          .prepare(`DELETE FROM team WHERE orgId=? AND id=? AND ${owns}`)
          .bind(command.orgId, teamId, ...ownsArgs),
      );
      break;
    case "update":
      statements.push(
        database
          .prepare(
            `UPDATE team SET name=?,color=?,revision=revision+1 WHERE orgId=? AND id=? AND ${owns}`,
          )
          .bind(
            command.name,
            command.color,
            command.orgId,
            teamId,
            ...ownsArgs,
          ),
      );
      break;
    case "set-member":
      statements.push(
        database
          .prepare(
            `UPDATE team SET revision=revision+1 WHERE orgId=? AND id=? AND ${owns}`,
          )
          .bind(command.orgId, teamId, ...ownsArgs),
      );
      if (command.role === "lead")
        statements.push(
          database
            .prepare(
              `UPDATE team_member SET role='member' WHERE teamId=? AND role='lead' AND ${owns}`,
            )
            .bind(teamId, ...ownsArgs),
        );
      statements.push(
        database
          .prepare(
            `INSERT INTO team_member(teamId,userId,role,sortOrder)
    SELECT ?,?,?,COALESCE((SELECT sortOrder FROM team_member WHERE teamId=? AND userId=?),(SELECT COALESCE(MAX(sortOrder),0)+1 FROM team_member WHERE teamId=?)) WHERE ${owns}
    ON CONFLICT(teamId,userId) DO UPDATE SET role=excluded.role`,
          )
          .bind(
            teamId,
            command.userId,
            command.role,
            teamId,
            command.userId,
            teamId,
            ...ownsArgs,
          ),
      );
      break;
    case "remove-member":
      statements.push(
        database
          .prepare(
            `UPDATE team SET revision=revision+1 WHERE orgId=? AND id=? AND ${owns}`,
          )
          .bind(command.orgId, teamId, ...ownsArgs),
      );
      statements.push(
        database
          .prepare(
            `DELETE FROM team_member WHERE teamId=? AND userId=? AND ${owns}`,
          )
          .bind(teamId, command.userId, ...ownsArgs),
      );
      break;
  }
  await database.batch(statements);
  const receipt = await database
    .prepare(
      `SELECT teamId,fingerprint,outcome FROM kiosk_team_command_receipt WHERE orgId=? AND actorId=? AND requestId=? AND ${guard}`,
    )
    .bind(...scope, ...guardArgs)
    .first<{ teamId: string; fingerprint: string; outcome: string }>();
  if (!receipt)
    throw new Error(
      "Your access changed before this team command was confirmed. Review access and retry.",
    );
  if (receipt.fingerprint !== fingerprint)
    throw new Error(
      "This request already belongs to a different team command.",
    );
  return kioskTeamResultSchema.parse({
    id: receipt.teamId,
    requestId: command.requestId,
    outcome: receipt.outcome,
  });
}
