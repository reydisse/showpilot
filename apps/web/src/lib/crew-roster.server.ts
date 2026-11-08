import { z } from "zod";
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
class CrewRequestCancelled extends TeamCommandError {
  constructor() {
    super(
      409,
      "This crew request was cancelled before it applied. Review your draft before sending a new request.",
    );
  }
}
async function crewAuthority(
  db: CrewProfileDatabase,
  actor: Actor,
  orgId: string,
) {
  const access = await readTeamAuthority(db, actor, { orgId, kind: "crew" });
  const result = teamAuthorityGuard(actor, orgId, access);
  result.guard.push(
    "NOT EXISTS(SELECT 1 FROM app_setting WHERE orgId=? AND key='organization-deleting')",
  );
  result.params.push(orgId);
  return result;
}
const reviewedReceiptSchema = z.object({
  fingerprint: z.string(),
  id: z.string(),
  kind: z.enum(["create", "update", "delete"]),
  requestId: z.string(),
  outcome: z.enum(["applied", "cancelled"]),
});
async function readRequest(
  db: CrewProfileDatabase,
  actor: Actor,
  command: CrewProfileCommand,
  requestId: string,
  hash: string,
  authority: { guard: string[]; params: (string | number | null)[] },
) {
  const saved = await db
    .prepare(
      `SELECT fingerprint,crewId AS id,kind,requestId,outcome FROM crew_write_receipt WHERE orgId=? AND actorId=? AND requestId=? AND ${authority.guard.join(" AND ")}`,
    )
    .bind(command.orgId, actor.userId, requestId, ...authority.params)
    .first();
  if (!saved) return null;
  const result = reviewedReceiptSchema.parse(saved);
  if (result.fingerprint !== hash)
    throw new TeamCommandError(
      409,
      "This request belongs to different crew changes. Review the roster before saving another draft.",
    );
  return result;
}
export async function reviewCrewProfile(
  db: CrewProfileDatabase,
  actor: Actor,
  raw: CrewProfileCommand,
) {
  const command = crewProfileCommandSchema.parse(raw);
  if (!command.requestId)
    throw new TeamCommandError(400, "Review the original crew request.");
  const authority = await crewAuthority(db, actor, command.orgId),
    hash = await fingerprint(command);
  // An empty crewId is a cancellation marker for a create that never made a row.
  await db
    .prepare(
      `INSERT INTO crew_write_receipt(orgId,actorId,requestId,fingerprint,crewId,kind,createdAt,precondition,outcome)
    SELECT ?,?,?,?,?,?,?,1,'cancelled' WHERE ${authority.guard.join(" AND ")}
    ON CONFLICT(orgId,actorId,requestId) DO NOTHING`,
    )
    .bind(
      command.orgId,
      actor.userId,
      command.requestId,
      hash,
      command.kind === "create" ? "" : command.id,
      command.kind,
      Date.now(),
      ...authority.params,
    )
    .run();
  markDatabaseWrite();
  const receipt = await readRequest(
    db,
    actor,
    command,
    command.requestId,
    hash,
    authority,
  );
  if (!receipt)
    throw new TeamCommandError(
      403,
      "Your crew management authority changed. Reopen the roster.",
    );
  return {
    id: receipt.id || null,
    kind: receipt.kind,
    requestId: receipt.requestId,
    outcome: receipt.outcome,
  };
}
export async function recoverCrewProfile(
  db: CrewProfileDatabase,
  actor: Actor,
  command: CrewProfileCommand,
  review: boolean,
) {
  if (!review) {
    try {
      return {
        ...(await writeCrewProfile(db, actor, command)),
        outcome: "applied" as const,
      };
    } catch (error) {
      if (!(error instanceof CrewRequestCancelled)) throw error;
    }
  }
  return reviewCrewProfile(db, actor, command);
}
export async function readCrewProfile(
  db: CrewProfileDatabase,
  actor: Actor,
  orgId: string,
  id: string,
) {
  const authority = await crewAuthority(db, actor, orgId);
  const row = await db
    .prepare(
      `SELECT * FROM crew_member WHERE orgId=? AND id=? AND ${authority.guard.join(" AND ")}`,
    )
    .bind(orgId, id, ...authority.params)
    .first();
  if (
    !(await db
      .prepare(`SELECT 1 WHERE ${authority.guard.join(" AND ")}`)
      .bind(...authority.params)
      .first())
  )
    throw new TeamCommandError(
      403,
      "Your crew management authority changed. Reopen the roster.",
    );
  return row ? crewRosterMemberSchema.parse(row) : null;
}

/** The receipt and profile change commit together. Receipt replay acknowledges
 * the old command and never restores an older profile or reused badge identity. */
export async function writeCrewProfile(
  db: CrewProfileDatabase,
  actor: Actor,
  raw: CrewProfileCommand,
): Promise<CrewProfileResult> {
  const command = crewProfileCommandSchema.parse(raw);
  const authority = await crewAuthority(db, actor, command.orgId);
  const requestId = command.requestId ?? crypto.randomUUID(),
    hash = await fingerprint(command);
  const receipt = async () => {
    const saved = await readRequest(
      db,
      actor,
      command,
      requestId,
      hash,
      authority,
    );
    if (saved?.outcome === "cancelled") throw new CrewRequestCancelled();
    return saved ? crewProfileResultSchema.parse(saved) : null;
  };
  const previous = await receipt();
  if (previous) return previous;
  const guard = [...authority.guard],
    params = [...authority.params];
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
  const saved = await receipt();
  if (!saved)
    throw new TeamCommandError(
      403,
      "Your crew management authority changed. Reopen the roster.",
    );
  return saved;
}
