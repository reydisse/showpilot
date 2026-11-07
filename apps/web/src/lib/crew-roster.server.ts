import { getAuth } from "./auth";
import {
  crewProfileCommandSchema,
  crewProfileResultSchema,
  crewRosterMemberSchema,
  type CrewProfileCommand,
  type CrewProfileResult,
} from "./crew-roster-contract";
import {
  readTeamAuthority,
  teamAuthorityGuard,
  TeamCommandError,
} from "./team-command.server";
import { markDatabaseWrite } from "./request-database.server";
import type {
  ChecklistWriteDatabase,
  ChecklistWriteStatement,
} from "./checklist-write.server";
interface CrewStatement extends ChecklistWriteStatement {
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
}
export interface CrewProfileDatabase extends ChecklistWriteDatabase {
  prepare(sql: string): { bind(...params: unknown[]): CrewStatement };
}
type Actor = { userId: string; sessionId: string };
export async function crewActor(headers: Headers) {
  const session = await getAuth().api.getSession({
    headers,
    query: { disableCookieCache: true },
  });
  if (!session)
    throw new TeamCommandError(401, "Sign in before changing the crew roster.");
  return { userId: session.user.id, sessionId: session.session.id };
}
export async function readCrewRoster(db: CrewProfileDatabase, orgId: string) {
  const result = await db
    .prepare("SELECT * FROM crew_member WHERE orgId=? ORDER BY name,id")
    .bind(orgId)
    .all();
  return (result.results ?? []).map((row) => crewRosterMemberSchema.parse(row));
}
async function fingerprint(command: CrewProfileCommand) {
  const intent = { ...command };
  delete intent.requestId;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(intent)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
/** The receipt and profile change commit together. Receipt replay acknowledges
 * the old command and never restores an older profile or reused badge identity. */
export async function writeCrewProfile(
  db: CrewProfileDatabase,
  actor: Actor,
  raw: CrewProfileCommand,
): Promise<CrewProfileResult> {
  const command = crewProfileCommandSchema.parse(raw);
  const access = await readTeamAuthority(db, actor, {
    orgId: command.orgId,
    kind: "crew",
  });
  const requestId = command.requestId ?? crypto.randomUUID(),
    hash = await fingerprint(command);
  const receipt = async () => {
    const saved = await db
      .prepare(
        "SELECT fingerprint,crewId AS id,kind,requestId FROM crew_write_receipt WHERE orgId=? AND actorId=? AND requestId=?",
      )
      .bind(command.orgId, actor.userId, requestId)
      .first<{
        fingerprint: string;
        id: string;
        kind: string;
        requestId: string;
      }>();
    if (saved && saved.fingerprint !== hash)
      throw new TeamCommandError(
        409,
        "This request belongs to different crew changes. Review the roster before saving another draft.",
      );
    return saved ? crewProfileResultSchema.parse(saved) : null;
  };
  const previous = await receipt();
  if (previous) return previous;
  const { guard, params } = teamAuthorityGuard(actor, command.orgId, access);
  let statement: CrewStatement, id: string;
  if (command.kind === "create") {
    id = crypto.randomUUID();
    statement = db
      .prepare(
        "INSERT INTO crew_member(id,orgId,memberId,name,role,email,photoUrl,isOnline,createdAt) VALUES(?,?,?,?,?,?,?,0,?)",
      )
      .bind(
        id,
        command.orgId,
        command.memberId,
        command.name,
        command.role,
        command.email,
        command.photoUrl,
        new Date().toISOString(),
      );
  } else {
    id = command.id;
    const row = await db
      .prepare("SELECT * FROM crew_member WHERE orgId=? AND id=?")
      .bind(command.orgId, id)
      .first();
    if (!row)
      throw new TeamCommandError(
        404,
        "This crew member is no longer in the roster. Refresh before making another change.",
      );
    const current = crewRosterMemberSchema.parse(row);
    if (
      command.expectedRevision !== undefined &&
      command.expectedRevision !== current.profileRevision
    )
      throw new TeamCommandError(
        409,
        "This crew profile changed. Review the roster before saving your draft.",
      );
    guard.push(
      "EXISTS(SELECT 1 FROM crew_member WHERE orgId=? AND id=? AND profileRevision=?)",
    );
    params.push(command.orgId, id, current.profileRevision);
    if (command.kind === "delete")
      statement = db
        .prepare("DELETE FROM crew_member WHERE orgId=? AND id=?")
        .bind(command.orgId, id);
    else {
      const next = { ...current, ...command.updates };
      statement = db
        .prepare(
          "UPDATE crew_member SET memberId=?,name=?,role=?,email=?,photoUrl=? WHERE orgId=? AND id=?",
        )
        .bind(
          next.memberId,
          next.name,
          next.role,
          next.email,
          next.photoUrl,
          command.orgId,
          id,
        );
    }
  }
  markDatabaseWrite();
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO crew_write_receipt(orgId,actorId,requestId,fingerprint,crewId,kind,createdAt,precondition) VALUES(?,?,?,?,?,?,?,CASE WHEN ${guard.join(" AND ")} THEN 1 ELSE 0 END)`,
        )
        .bind(
          command.orgId,
          actor.userId,
          requestId,
          hash,
          id,
          command.kind,
          Date.now(),
          ...params,
        ),
      statement,
    ]);
  } catch (error) {
    const saved = await receipt();
    if (saved) return saved;
    const message = error instanceof Error ? error.message : "";
    if (message.includes("crew_write_precondition"))
      throw new TeamCommandError(
        409,
        "The crew profile or your authority changed. Refresh before saving again.",
      );
    if (
      message.includes(
        "UNIQUE constraint failed: crew_member.orgId, crew_member.memberId",
      )
    )
      throw new TeamCommandError(
        409,
        "That badge ID is already in use. Review the crew roster.",
      );
    throw new TeamCommandError(
      500,
      "The crew change could not be confirmed. Retry the same request.",
    );
  }
  return { id, kind: command.kind, requestId };
}
