import { z } from "zod";
import { getAuth } from "./auth";
import { resolveAccessGrantAuthorityForAccess } from "./effective-access";
import { getAccessCapability } from "./access-capabilities";
import { normalizeRole } from "./permissions";
import { serviceTimeToIso, getTodayDateString } from "./utils";
import { markDatabaseWrite } from "./request-database.server";
import { refreshOrgReadAuthority } from "./relay-read-invalidation.server";
import {
  accessWriteSchema,
  accessWriteResultSchema,
  accessNoticeSchema,
  type AccessWrite,
  type AccessWriteResult,
} from "./access-write-contract";
import { TeamCommandError } from "./team-command.server";
import type {
  ChecklistWriteDatabase,
  ChecklistWriteStatement,
} from "./checklist-write.server";
interface Statement extends ChecklistWriteStatement {
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
}
export interface AccessWriteDatabase extends ChecklistWriteDatabase {
  prepare(sql: string): { bind(...params: unknown[]): Statement };
}
export type AccessGrantActor = {
  userId: string;
  name: string;
  sessionId: string;
};
export async function readAccessActor(
  headers: Headers,
): Promise<AccessGrantActor> {
  const session = await getAuth().api.getSession({
    headers,
    query: { disableCookieCache: true },
  });
  if (!session)
    throw new TeamCommandError(401, "Sign in before changing access.");
  return {
    userId: session.user.id,
    name: session.user.name,
    sessionId: session.session.id,
  };
}
const memberSchema = z.object({
  id: z.string(),
  role: z.string(),
  managementRevision: z.number().int().nonnegative(),
});
const grantSchema = z.object({
  id: z.string(),
  userId: z.string(),
  capability: z.string(),
  permissions: z.string(),
  startsOn: z.string(),
  expiresOn: z.string().nullable(),
  revokedAt: z.union([z.string(), z.number()]).nullable(),
});
const noticePayloadSchema = z.object({
  title: z.string(),
  message: z.string(),
  actionUrl: z.string(),
});
const receiptSchema = z.object({
  orgId: z.string(),
  actorId: z.string(),
  requestId: z.string(),
  fingerprint: z.string(),
  grantId: z.string(),
  targetId: z.string(),
  kind: z.enum(["grant", "revoke"]),
  notificationId: z.string(),
  notificationPayload: z.string(),
  notificationState: z.enum(["pending", "created", "superseded"]),
  createdAt: z.number(),
});
type Receipt = z.infer<typeof receiptSchema>;
const activeSession = `(CASE WHEN typeof(s.expiresAt) IN ('integer','real') THEN s.expiresAt ELSE (julianday(s.expiresAt)-2440587.5)*86400000 END)>(julianday('now')-2440587.5)*86400000`;
async function readAuthority(
  db: AccessWriteDatabase,
  actor: AccessGrantActor,
  orgId: string,
) {
  const row = await db
    .prepare(
      `SELECT m.id,m.role,m.managementRevision FROM member m JOIN session s ON s.userId=m.userId
    WHERE m.organizationId=? AND m.userId=? AND s.id=? AND ${activeSession}`,
    )
    .bind(orgId, actor.userId, actor.sessionId)
    .first();
  if (!row)
    throw new TeamCommandError(
      403,
      "You no longer have access to manage this organization.",
    );
  const member = memberSchema.parse(row);
  const timezone =
    (
      await db
        .prepare(
          "SELECT value FROM app_setting WHERE orgId=? AND key='org-timezone'",
        )
        .bind(orgId)
        .first<{ value: string }>()
    )?.value ?? "";
  const role = normalizeRole(member.role);
  if (!role)
    throw new TeamCommandError(
      403,
      "Your organization role cannot manage access.",
    );
  const authority = await resolveAccessGrantAuthorityForAccess(
    db,
    actor.userId,
    orgId,
    { role, today: getTodayDateString(timezone || undefined) },
  );
  if (!authority.canManage)
    throw new TeamCommandError(
      403,
      "Only an Owner, Admin, or the on-duty TM can change access.",
    );
  const guard = [
    `EXISTS(SELECT 1 FROM member m JOIN session s ON s.userId=m.userId WHERE m.organizationId=? AND m.id=? AND m.userId=? AND m.role=? AND m.managementRevision=? AND s.id=? AND ${activeSession})`,
    `COALESCE((SELECT value FROM app_setting WHERE orgId=? AND key='org-timezone'),'')=?`,
  ];
  const params: (string | number | null)[] = [
    orgId,
    member.id,
    actor.userId,
    member.role,
    member.managementRevision,
    actor.sessionId,
    orgId,
    timezone,
  ];
  if (authority.kind === "on-duty-tm") {
    guard.push(
      `EXISTS(SELECT 1 FROM roster_assignment a JOIN roster_role r ON r.id=a.roleId AND r.orgId=a.orgId WHERE a.orgId=? AND a.weekStart=? AND a.kind='tech' AND lower(r.code)='tm' AND a.userId=?)`,
    );
    params.push(orgId, authority.weekStart, actor.userId);
  }
  return { authority, timezone, guard, params };
}
async function hashCommand(command: AccessWrite) {
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
async function receiptFor(
  db: AccessWriteDatabase,
  orgId: string,
  actorId: string,
  requestId: string,
) {
  const row = await db
    .prepare(
      "SELECT * FROM access_write_receipt WHERE orgId=? AND actorId=? AND requestId=?",
    )
    .bind(orgId, actorId, requestId)
    .first();
  return row ? receiptSchema.parse(row) : null;
}
async function currentGrant(
  db: AccessWriteDatabase,
  orgId: string,
  id: string,
) {
  const row = await db
    .prepare("SELECT * FROM member_permission_grant WHERE orgId=? AND id=?")
    .bind(orgId, id)
    .first();
  return row ? grantSchema.parse(row) : null;
}
async function withDeadline<T>(
  work: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Access follow-up timed out")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
/** Receipt owns the intent. Failure here must never roll back a revocation. */
async function deliverNotice(
  db: AccessWriteDatabase,
  receipt: Receipt,
  today: string,
): Promise<Receipt["notificationState"]> {
  if (receipt.notificationState !== "pending") return receipt.notificationState;
  const notice = noticePayloadSchema.parse(
    JSON.parse(receipt.notificationPayload),
  );
  const predicate =
    receipt.kind === "grant"
      ? `g.revokedAt IS NULL AND g.startsOn<=? AND (g.expiresOn IS NULL OR g.expiresOn>?)`
      : `g.revokedAt IS NOT NULL AND NOT EXISTS(SELECT 1 FROM member_permission_grant newer WHERE newer.orgId=g.orgId AND newer.userId=g.userId AND newer.capability=g.capability AND newer.id<>g.id AND newer.revokedAt IS NULL AND newer.startsOn<=? AND (newer.expiresOn IS NULL OR newer.expiresOn>?))`;
  try {
    await withDeadline(
      db.batch([
        db
          .prepare(
            `INSERT OR IGNORE INTO notification(id,orgId,userId,type,severity,title,message,target,source,actionUrl,createdAt)
        SELECT ?,?,?,'access-grant','info',?,?,'personal','access-control',?,?
        WHERE EXISTS(SELECT 1 FROM member_permission_grant g JOIN member m ON m.userId=g.userId AND m.organizationId=g.orgId WHERE g.orgId=? AND g.id=? AND g.userId=? AND ${predicate})`,
          )
          .bind(
            receipt.notificationId,
            receipt.orgId,
            receipt.targetId,
            notice.title,
            notice.message,
            notice.actionUrl,
            new Date(receipt.createdAt).toISOString(),
            receipt.orgId,
            receipt.grantId,
            receipt.targetId,
            today,
            today,
          ),
        db
          .prepare(
            `UPDATE access_write_receipt SET notificationState=CASE WHEN EXISTS(SELECT 1 FROM notification WHERE id=? AND orgId=?) THEN 'created' ELSE 'superseded' END WHERE orgId=? AND actorId=? AND requestId=? AND notificationState='pending'`,
          )
          .bind(
            receipt.notificationId,
            receipt.orgId,
            receipt.orgId,
            receipt.actorId,
            receipt.requestId,
          ),
      ]),
      3_000,
    );
    return (
      (await receiptFor(db, receipt.orgId, receipt.actorId, receipt.requestId))
        ?.notificationState ?? "pending"
    );
  } catch {
    return "pending";
  }
}
async function acknowledge(
  db: AccessWriteDatabase,
  receipt: Receipt,
  today: string,
): Promise<AccessWriteResult> {
  const [notification, grant] = await Promise.all([
    deliverNotice(db, receipt, today),
    currentGrant(db, receipt.orgId, receipt.grantId),
    withDeadline(
      refreshOrgReadAuthority(receipt.orgId, receipt.targetId),
      2_000,
    ).catch(() => {
      console.error(
        JSON.stringify({
          message:
            "Access committed; relay refresh deadline reached, read leases remain active",
          orgId: receipt.orgId,
        }),
      );
    }),
  ]);
  const state = !grant
    ? "missing"
    : grant.revokedAt !== null
      ? "revoked"
      : grant.startsOn > today ||
          (grant.expiresOn !== null && grant.expiresOn <= today)
        ? "expired"
        : "active";
  return accessWriteResultSchema.parse({
    ok: true,
    id: receipt.grantId,
    kind: receipt.kind,
    requestId: receipt.requestId,
    state,
    notification,
  });
}
export async function pendingAccessNotices(
  db: AccessWriteDatabase,
  orgId: string,
  actorId: string,
) {
  const rows = await db
    .prepare(
      "SELECT requestId,kind,grantId,json_extract(notificationPayload,'$.title') AS title,json_extract(notificationPayload,'$.message') AS message FROM access_write_receipt WHERE orgId=? AND actorId=? AND notificationState='pending' ORDER BY createdAt,requestId",
    )
    .bind(orgId, actorId)
    .all();
  return (rows.results ?? []).map((row) => accessNoticeSchema.parse(row));
}
export async function retryAccessNotice(
  db: AccessWriteDatabase,
  actor: AccessGrantActor,
  input: { orgId: string; requestId: string },
) {
  const access = await readAuthority(db, actor, input.orgId);
  const receipt = await receiptFor(
    db,
    input.orgId,
    actor.userId,
    input.requestId,
  );
  if (!receipt)
    throw new TeamCommandError(
      404,
      "This access notification is no longer available.",
    );
  return acknowledge(db, receipt, access.authority.today);
}
export async function writeAccessGrant(
  db: AccessWriteDatabase,
  actor: AccessGrantActor,
  raw: AccessWrite,
): Promise<AccessWriteResult> {
  const command = accessWriteSchema.parse(raw);
  const access = await readAuthority(db, actor, command.orgId);
  const requestId = command.requestId ?? crypto.randomUUID(),
    fingerprint = await hashCommand(command);
  const recover = async () => {
    const receipt = await receiptFor(
      db,
      command.orgId,
      actor.userId,
      requestId,
    );
    if (receipt && receipt.fingerprint !== fingerprint)
      throw new TeamCommandError(
        409,
        "This request belongs to different access changes. Review access before saving again.",
      );
    return receipt;
  };
  const previous = await recover();
  if (previous) return acknowledge(db, previous, access.authority.today);
  const { authority, guard, params } = access;
  if (
    command.expectedWeekStart !== undefined &&
    command.expectedWeekStart !== authority.weekStart &&
    (authority.kind === "on-duty-tm" ||
      (command.kind === "grant" && command.duration === "this-week"))
  )
    throw new TeamCommandError(
      409,
      "The duty week changed. Review the current week before granting access.",
    );
  if (
    authority.kind === "on-duty-tm" ||
    (command.kind === "grant" && command.duration === "this-week")
  ) {
    const start = serviceTimeToIso(
      authority.weekStart,
      "00:00",
      access.timezone || undefined,
    );
    const end = serviceTimeToIso(
      authority.weekEndExclusive,
      "00:00",
      access.timezone || undefined,
    );
    if (!start || !end)
      throw new TeamCommandError(
        409,
        "Review the organization timezone before changing weekly access.",
      );
    guard.push(
      "(julianday('now')-2440587.5)*86400000>=? AND (julianday('now')-2440587.5)*86400000<?",
    );
    params.push(Date.parse(start), Date.parse(end));
  }
  let grantId: string,
    targetId: string,
    notice: z.infer<typeof noticePayloadSchema>,
    mutation: Statement;
  if (command.kind === "grant") {
    if (command.userId === actor.userId)
      throw new TeamCommandError(
        400,
        "Access grants must be assigned to another member.",
      );
    if (authority.kind === "on-duty-tm" && command.duration !== "this-week")
      throw new TeamCommandError(
        403,
        "The on-duty TM can grant access only for the current duty week.",
      );
    const capability = getAccessCapability(command.capability);
    const permissions = capability
      ? [...capability.permissions]
      : command.permissions;
    if (!permissions.length)
      throw new TeamCommandError(
        400,
        "Choose at least one permission for custom access.",
      );
    const target = await db
      .prepare(
        "SELECT m.id,u.name FROM member m JOIN user u ON u.id=m.userId WHERE m.organizationId=? AND m.userId=?",
      )
      .bind(command.orgId, command.userId)
      .first<{ id: string; name: string }>();
    if (!target)
      throw new TeamCommandError(
        404,
        "That person is not a member of this organization.",
      );
    const duplicate = await db
      .prepare(
        "SELECT id FROM member_permission_grant WHERE orgId=? AND userId=? AND capability=? AND revokedAt IS NULL AND startsOn<=? AND (expiresOn IS NULL OR expiresOn>?)",
      )
      .bind(
        command.orgId,
        command.userId,
        command.capability,
        authority.today,
        authority.today,
      )
      .first();
    if (duplicate) {
      const raced = await recover();
      if (raced) return acknowledge(db, raced, authority.today);
      throw new TeamCommandError(
        409,
        `${target.name} already has ${capability?.label ?? "custom operational"} access.`,
      );
    }
    guard.push(
      "EXISTS(SELECT 1 FROM member WHERE organizationId=? AND id=? AND userId=?)",
    );
    params.push(command.orgId, target.id, command.userId);
    guard.push(
      "NOT EXISTS(SELECT 1 FROM member_permission_grant WHERE orgId=? AND userId=? AND capability=? AND revokedAt IS NULL AND startsOn<=? AND (expiresOn IS NULL OR expiresOn>?))",
    );
    params.push(
      command.orgId,
      command.userId,
      command.capability,
      authority.today,
      authority.today,
    );
    grantId = crypto.randomUUID();
    targetId = command.userId;
    const startsOn =
      command.duration === "this-week" ? authority.weekStart : authority.today;
    const expiresOn =
      command.duration === "this-week" ? authority.weekEndExclusive : null;
    mutation = db
      .prepare(
        "INSERT INTO member_permission_grant(id,orgId,userId,capability,permissions,startsOn,expiresOn,reason,grantedByUserId) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        grantId,
        command.orgId,
        targetId,
        command.capability,
        JSON.stringify(permissions),
        startsOn,
        expiresOn,
        command.reason,
        actor.userId,
      );
    notice = {
      title: "Access granted",
      message: `${actor.name} granted you ${capability?.label ?? "Custom operational"} access ${expiresOn ? "for the current duty week" : "until it is revoked"}.`,
      actionUrl: capability?.notificationPath ?? "show",
    };
  } else {
    const grant = await currentGrant(db, command.orgId, command.grantId);
    if (!grant || grant.revokedAt !== null) {
      const raced = await recover();
      if (raced) return acknowledge(db, raced, authority.today);
      throw new TeamCommandError(404, "This access grant is no longer active.");
    }
    if (
      authority.kind === "on-duty-tm" &&
      !(
        grant.startsOn >= authority.weekStart &&
        grant.expiresOn === authority.weekEndExclusive
      )
    )
      throw new TeamCommandError(
        403,
        "The on-duty TM can revoke only grants for the current duty week.",
      );
    guard.push(
      "EXISTS(SELECT 1 FROM member_permission_grant WHERE orgId=? AND id=? AND userId=? AND capability=? AND permissions=? AND startsOn=? AND expiresOn IS ? AND revokedAt IS NULL)",
    );
    params.push(
      command.orgId,
      grant.id,
      grant.userId,
      grant.capability,
      grant.permissions,
      grant.startsOn,
      grant.expiresOn,
    );
    grantId = grant.id;
    targetId = grant.userId;
    mutation = db
      .prepare(
        "UPDATE member_permission_grant SET revokedAt=CURRENT_TIMESTAMP,revokedByUserId=?,updatedAt=CURRENT_TIMESTAMP WHERE orgId=? AND id=? AND revokedAt IS NULL",
      )
      .bind(actor.userId, command.orgId, grantId);
    notice = {
      title: "Access revoked",
      message: `${actor.name} revoked your ${getAccessCapability(grant.capability)?.label ?? "custom"} access.`,
      actionUrl: "",
    };
  }
  markDatabaseWrite();
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO access_write_receipt(orgId,actorId,requestId,fingerprint,grantId,targetId,kind,notificationId,notificationPayload,createdAt,precondition) VALUES(?,?,?,?,?,?,?,?,?,?,CASE WHEN ${guard.join(" AND ")} THEN 1 ELSE 0 END)`,
        )
        .bind(
          command.orgId,
          actor.userId,
          requestId,
          fingerprint,
          grantId,
          targetId,
          command.kind,
          crypto.randomUUID(),
          JSON.stringify(notice),
          Date.now(),
          ...params,
        ),
      mutation,
    ]);
  } catch (error) {
    const raced = await recover();
    if (raced) return acknowledge(db, raced, authority.today);
    if (
      error instanceof Error &&
      error.message.includes("access_write_precondition")
    )
      throw new TeamCommandError(
        409,
        "Access, membership, duty authority or the reviewed week changed. Refresh before saving again.",
      );
    throw new TeamCommandError(
      500,
      "The access change could not be confirmed. Retry the same request.",
    );
  }
  const saved = await recover();
  if (!saved)
    throw new TeamCommandError(
      500,
      "The access change could not be confirmed. Retry the same request.",
    );
  return acknowledge(db, saved, authority.today);
}
