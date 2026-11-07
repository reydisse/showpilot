import { z } from "zod";
import { authRoles } from "./auth-access";
import { hasPermission } from "./app-permissions";
import { markDatabaseWrite } from "./request-database.server";

type Database = Pick<D1Database, "prepare" | "batch">;
type Actor = { userId: string; sessionId: string };
type Options = { orgId: string; requestId?: string };
type Command = Options &
  (
    | {
        kind: "role";
        memberId: string;
        role: string | string[];
        expectedRevision?: number;
      }
    | { kind: "remove"; memberIdOrEmail: string; expectedRevision?: number }
    | { kind: "cancel"; invitationId: string }
    | { kind: "report"; reportId: string; status: "resolved" | "dismissed" }
  );
const dateValue = z.union([z.string(), z.number()]);
const memberSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  userId: z.string(),
  role: z.string(),
  createdAt: dateValue,
  managementRevision: z.number().int().nonnegative(),
});
const invitationSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  email: z.string(),
  role: z.string().nullable(),
  status: z.string(),
  expiresAt: dateValue,
  createdAt: dateValue,
  inviterId: z.string(),
});
const resultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("role"), member: memberSchema }),
  z.object({ kind: z.literal("remove"), member: memberSchema }),
  z.object({ kind: z.literal("cancel"), invitation: invitationSchema }),
  z.object({
    kind: z.literal("report"),
    reportId: z.string(),
    status: z.enum(["resolved", "dismissed"]),
  }),
]);
export type TeamCommandResult = z.infer<typeof resultSchema>;
type StoredMember = z.infer<typeof memberSchema>;
type StoredInvitation = z.infer<typeof invitationSchema>;
export class TeamCommandError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 500,
    message: string,
  ) {
    super(message);
  }
}
const roles = (role: string) =>
  role
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
const permissionsSchema = z.record(z.string(), z.array(z.string()));
// This stable SQL expression is also the commit guard for dynamic-role edits.
const policySql = `(SELECT COALESCE(json_group_array(json_object('id',id,'role',role,'permission',permission)),'[]') FROM (SELECT id,role,permission FROM organizationRole WHERE organizationId=? ORDER BY id))`;
export async function readTeamAuthority(db: Database, actor: Actor, command: { orgId: string; kind: Command["kind"] | "invite" }) {
  const member = await db
    .prepare(
      `SELECT m.* FROM member m JOIN session s ON s.userId=m.userId
    WHERE m.organizationId=? AND m.userId=? AND s.id=?
    AND (CASE WHEN typeof(s.expiresAt) IN ('integer','real') THEN s.expiresAt ELSE (julianday(s.expiresAt)-2440587.5)*86400000 END)>? LIMIT 1`,
    )
    .bind(command.orgId, actor.userId, actor.sessionId, Date.now())
    .first<StoredMember>();
  if (!member)
    throw new TeamCommandError(
      403,
      "You no longer have access to manage this team.",
    );
  const policy = await db
    .prepare(`SELECT ${policySql} AS policy`)
    .bind(command.orgId)
    .first<string>("policy");
  if (policy === null)
    throw new TeamCommandError(
      500,
      "The organization's role policy could not be read.",
    );
  const definitions = z
    .array(
      z.object({ id: z.string(), role: z.string(), permission: z.string() }),
    )
    .parse(JSON.parse(policy));
  const dynamic = definitions.map((row) => ({
    role: row.role,
    permissions: permissionsSchema.parse(JSON.parse(row.permission)),
  }));
  const actorRoles = roles(member.role),
    owner = actorRoles.includes("owner");
  const resource = (command.kind === "cancel" || command.kind === "invite") ? "invitation" : "member";
  const action =
    command.kind === "invite" ? "create" : command.kind === "cancel"
      ? "cancel"
      : command.kind === "remove"
        ? "delete"
        : "update";
  // Match Better Auth: one role must grant the action; dynamic permissions add
  // to that role's static statements. App moderation keeps its app permission.
  const allowed =
    command.kind === "report"
      ? hasPermission(member.role, "settings:members")
      : (command.kind === "role" && owner) ||
        actorRoles.some((role) => {
          const staticRole = Object.entries(authRoles).find(
            ([name]) => name === role,
          )?.[1];
          const permissions = permissionsSchema.parse(
            staticRole?.statements ?? {},
          );
          return (
            permissions[resource]?.includes(action) ||
            dynamic.some(
              (row) =>
                row.role === role &&
                row.permissions[resource]?.includes(action),
            )
          );
        });
  if (!allowed)
    throw new TeamCommandError(
      403,
      "You do not have permission to make this team change.",
    );
  return {
    member,
    policy,
    owner,
    knownRoles: new Set([
      ...Object.keys(authRoles),
      ...dynamic.map((row) => row.role),
    ]),
  };
}

/** Called from the existing authenticated endpoint boundary. Both the receipt
 * and mutation commit together; retries only read an already-committed result. */
export async function executeTeamCommand(
  db: Database,
  actor: Actor,
  command: Command,
): Promise<TeamCommandResult> {
  const access = await readTeamAuthority(db, actor, command);
  const requestId = command.requestId ?? crypto.randomUUID();
  if (!z.uuid().safeParse(requestId).success)
    throw new TeamCommandError(400, "Use a valid team change request ID.");
  const canonical =
    command.kind === "role"
      ? {
          ...command,
          role: [
            ...new Set(
              (Array.isArray(command.role)
                ? command.role
                : [command.role]
              ).flatMap(roles),
            ),
          ].join(","),
        }
      : command;
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([
        command.orgId,
        actor.userId,
        requestId,
        canonical.kind,
        canonical.kind === "role"
          ? [
              canonical.memberId,
              canonical.role,
              canonical.expectedRevision ?? null,
            ]
          : canonical.kind === "remove"
            ? [canonical.memberIdOrEmail, canonical.expectedRevision ?? null]
            : canonical.kind === "cancel"
              ? [canonical.invitationId]
              : [canonical.reportId, canonical.status],
      ]),
    ),
  );
  const fingerprint = Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const find = async () => {
    const receipt = await db
      .prepare(
        "SELECT fingerprint,result FROM team_command_receipt WHERE orgId=? AND actorId=? AND requestId=?",
      )
      .bind(command.orgId, actor.userId, requestId)
      .first<{ fingerprint: string; result: string }>();
    if (!receipt) return null;
    if (receipt.fingerprint !== fingerprint)
      throw new TeamCommandError(
        409,
        "This request ID belongs to different team changes. Refresh before making a new change.",
      );
    return resultSchema.parse(JSON.parse(receipt.result));
  };
  const saved = await find();
  if (saved) return saved;
  const { guard, params } = teamAuthorityGuard(actor, command.orgId, access);
  const mutations: D1PreparedStatement[] = [];
  let result: TeamCommandResult;
  if (canonical.kind === "role" || canonical.kind === "remove") {
    const target =
      canonical.kind === "role"
        ? await db
            .prepare("SELECT * FROM member WHERE organizationId=? AND id=?")
            .bind(command.orgId, canonical.memberId)
            .first<StoredMember>()
        : await db
            .prepare(
              `SELECT m.* FROM member m JOIN user u ON u.id=m.userId WHERE m.organizationId=? AND ${canonical.memberIdOrEmail.includes("@") ? "lower(u.email)=lower(?)" : "m.id=?"} LIMIT 1`,
            )
            .bind(command.orgId, canonical.memberIdOrEmail)
            .first<StoredMember>();
    if (!target)
      throw new TeamCommandError(
        404,
        "This membership is no longer available. Refresh the team.",
      );
    if (
      canonical.expectedRevision !== undefined &&
      canonical.expectedRevision !== target.managementRevision
    )
      throw new TeamCommandError(
        409,
        "This member's role changed. Refresh and review it before applying another change.",
      );
    const targetOwner = roles(target.role).includes("owner"),
      newRoles = canonical.kind === "role" ? roles(canonical.role) : [];
    if (
      canonical.kind === "role" &&
      (!newRoles.length ||
        newRoles.some((role) => !access.knownRoles.has(role)))
    )
      throw new TeamCommandError(400, "Choose an existing organization role.");
    if ((targetOwner || newRoles.includes("owner")) && !access.owner)
      throw new TeamCommandError(
        403,
        "Only an owner can change an owner's membership or grant ownership.",
      );
    guard.push(
      "EXISTS(SELECT 1 FROM member WHERE organizationId=? AND id=? AND userId=? AND role=? AND managementRevision=?)",
    );
    params.push(
      command.orgId,
      target.id,
      target.userId,
      target.role,
      target.managementRevision,
    );
    if (targetOwner && !newRoles.includes("owner")) {
      guard.push(
        "(SELECT COUNT(*) FROM member WHERE organizationId=? AND instr(','||replace(role,' ','')||',',',owner,')>0)>1",
      );
      params.push(command.orgId);
    }
    if (canonical.kind === "role") {
      result = {
        kind: "role",
        member: {
          ...target,
          role: canonical.role,
          managementRevision:
            target.managementRevision +
            (target.role === canonical.role ? 0 : 1),
        },
      };
      mutations.push(
        db
          .prepare("UPDATE member SET role=? WHERE organizationId=? AND id=?")
          .bind(canonical.role, command.orgId, target.id),
      );
    } else {
      result = { kind: "remove", member: target };
      mutations.push(
        db
          .prepare("DELETE FROM member WHERE organizationId=? AND id=?")
          .bind(command.orgId, target.id),
      );
      if (target.userId === actor.userId)
        mutations.push(
          db
            .prepare(
              "UPDATE session SET activeOrganizationId=NULL,updatedAt=? WHERE userId=? AND id=? AND activeOrganizationId=?",
            )
            .bind(Date.now(), actor.userId, actor.sessionId, command.orgId),
        );
    }
  } else if (canonical.kind === "cancel") {
    const invitation = await db
      .prepare("SELECT * FROM invitation WHERE organizationId=? AND id=?")
      .bind(command.orgId, canonical.invitationId)
      .first<StoredInvitation>();
    if (!invitation)
      throw new TeamCommandError(
        404,
        "This invitation is no longer available.",
      );
    if (invitation.status !== "pending" && invitation.status !== "canceled")
      throw new TeamCommandError(
        409,
        "This invitation already has a response. Refresh to review its outcome.",
      );
    guard.push(
      "EXISTS(SELECT 1 FROM invitation WHERE organizationId=? AND id=? AND status=?)",
    );
    params.push(command.orgId, invitation.id, invitation.status);
    result = {
      kind: "cancel",
      invitation: { ...invitation, status: "canceled" },
    };
    mutations.push(
      db
        .prepare(
          "UPDATE invitation SET status='canceled' WHERE organizationId=? AND id=? AND status='pending'",
        )
        .bind(command.orgId, invitation.id),
    );
  } else {
    const report = await db
      .prepare("SELECT status FROM content_report WHERE orgId=? AND id=?")
      .bind(command.orgId, canonical.reportId)
      .first<{ status: string }>();
    if (!report)
      throw new TeamCommandError(404, "This report is no longer available.");
    if (!["open", "reviewing", canonical.status].includes(report.status))
      throw new TeamCommandError(
        409,
        "This report already has a different decision. Refresh to review its outcome.",
      );
    guard.push(
      "EXISTS(SELECT 1 FROM content_report WHERE orgId=? AND id=? AND status=?)",
    );
    params.push(command.orgId, canonical.reportId, report.status);
    result = {
      kind: "report",
      reportId: canonical.reportId,
      status: canonical.status,
    };
    mutations.push(
      db
        .prepare(
          "UPDATE content_report SET status=?,reviewedBy=?,reviewedAt=CURRENT_TIMESTAMP WHERE orgId=? AND id=? AND status IN ('open','reviewing')",
        )
        .bind(
          canonical.status,
          actor.userId,
          command.orgId,
          canonical.reportId,
        ),
    );
  }
  markDatabaseWrite();
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO team_command_receipt(orgId,actorId,requestId,fingerprint,result,createdAt,precondition) VALUES(?,?,?,?,?,?,CASE WHEN ${guard.join(" AND ")} THEN 1 ELSE 0 END)`,
        )
        .bind(
          command.orgId,
          actor.userId,
          requestId,
          fingerprint,
          JSON.stringify(result),
          Date.now(),
          ...params,
        ),
      ...mutations,
    ]);
  } catch (error) {
    const raced = await find();
    if (raced) return raced;
    if (
      error instanceof Error &&
      error.message.includes("team_command_precondition")
    )
      throw new TeamCommandError(
        409,
        "The team or your authority changed. Keep at least one owner; refresh and review before retrying.",
      );
    throw new TeamCommandError(
      500,
      "The team change could not be confirmed. Retry the same request.",
    );
  }
  return result;
}

export function teamCommandHeaders(headers: Headers | undefined | null) {
  const key = headers?.get("Idempotency-Key"),
    version = headers?.get("X-ShowPilot-Member-Revision");
  if (key !== null && key !== undefined && !z.uuid().safeParse(key).success)
    throw new TeamCommandError(400, "Use a valid team change request ID.");
  if (
    version !== null &&
    version !== undefined &&
    (!/^\d+$/.test(version) || !Number.isSafeInteger(Number(version)))
  )
    throw new TeamCommandError(400, "Use a valid member revision.");
  return {
    requestId: key ?? undefined,
    expectedRevision: version == null ? undefined : Number(version),
  };
}
export function teamCommandFailure(error: unknown) {
  return error instanceof TeamCommandError
    ? {
        status: error.status,
        code:
          error.status === 500
            ? "TEAM_CHANGE_UNCONFIRMED"
            : "TEAM_CHANGE_REJECTED",
        message: error.message,
      }
    : {
        status: 500 as const,
        code: "TEAM_CHANGE_UNCONFIRMED",
        message:
          "The team change could not be confirmed. Retry the same request.",
      };
}

// Better Auth's in-process API returns an endpoint's JSON value without using
// its HTTP status. Every server-side caller must reject this failure payload.
export function assertTeamCommandSuccess(result: unknown): void {
  const failure = z
    .object({
      code: z.enum(["TEAM_CHANGE_REJECTED", "TEAM_CHANGE_UNCONFIRMED"]),
      status: z.union([
        z.literal(400),
        z.literal(401),
        z.literal(403),
        z.literal(404),
        z.literal(409),
        z.literal(500),
      ]),
      message: z.string(),
    })
    .safeParse(result);
  if (failure.success)
    throw new TeamCommandError(failure.data.status, failure.data.message);
}

export function teamAuthorityGuard(actor: Actor, orgId: string, access: Awaited<ReturnType<typeof readTeamAuthority>>) {
  const guard: string[] = [
    `EXISTS(SELECT 1 FROM member m JOIN session s ON s.userId=m.userId WHERE m.organizationId=? AND m.id=? AND m.userId=? AND m.role=? AND m.managementRevision=? AND s.id=?
    AND (CASE WHEN typeof(s.expiresAt) IN ('integer','real') THEN s.expiresAt ELSE (julianday(s.expiresAt)-2440587.5)*86400000 END)>(julianday('now')-2440587.5)*86400000)`,
    `${policySql}=?`,
  ];
  const params: (string | number | null)[] = [
    orgId,
    access.member.id,
    actor.userId,
    access.member.role,
    access.member.managementRevision,
    actor.sessionId,
    orgId,
    access.policy,
  ];
  return { guard, params };
}
