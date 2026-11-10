import { z } from "zod";
import {
  readTeamAuthority,
  teamAuthorityGuard,
  TeamCommandError,
} from "./team-command.server";
import {
  teamInvitationSchema,
  type TeamInvitation,
} from "./team-invitation-contract";
import { invitationEmail, sendEmail, EmailDeliveryRejected } from "./email";
import { sendInvitationWithSetupReceipt } from "./setup-invitation-delivery.server";
import { markDatabaseWrite } from "./request-database.server";

type Database = Pick<D1Database, "prepare" | "batch">;
type Actor = { userId: string; sessionId: string };
type InvitationInput = {
  orgId: string;
  email: string;
  role: string | string[];
  requestId?: string;
  resend?: boolean;
  invitationId?: string;
  previousDeliveryId?: string | null;
};
const payloadSchema = z.object({
  to: z.string(),
  subject: z.string(),
  html: z.string(),
});
const storedInvitationSchema = teamInvitationSchema
  .omit({ delivery: true })
  .extend({ deliveryId: z.string().nullable() });
const storedDeliverySchema = z.object({
  id: z.string(),
  orgId: z.string(),
  invitationId: z.string(),
  payload: z.string(),
  state: z.enum(["ready", "sending", "accepted", "failed", "uncertain"]),
  firstSentAt: z.number().nullable(),
  leaseUntil: z.number().nullable(),
  updatedAt: z.number(),
});
const RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
const LEASE_MS = 30_000;
const SEND_TIMEOUT_MS = 8_000;
const normalizeRoles = (role: string | string[]) =>
  [
    ...new Set(
      (Array.isArray(role) ? role : [role]).flatMap((value) =>
        value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ),
  ].join(",");
async function fingerprint(value: unknown) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
async function storedInvitation(db: Database, orgId: string, id: string) {
  const row = await db
    .prepare("SELECT * FROM invitation WHERE organizationId=? AND id=?")
    .bind(orgId, id)
    .first();
  if (!row)
    throw new TeamCommandError(
      404,
      "This invitation is no longer available. Refresh the team.",
    );
  return storedInvitationSchema.parse(row);
}
async function storedDelivery(
  db: Database,
  orgId: string,
  invitationId: string,
  id: string | null,
) {
  if (!id) return null;
  const row = await db
    .prepare(
      "SELECT * FROM team_invitation_delivery WHERE orgId=? AND invitationId=? AND id=?",
    )
    .bind(orgId, invitationId, id)
    .first();
  return row ? storedDeliverySchema.parse(row) : null;
}
// Read the invitation and current delivery in one database snapshot. Never expose
// the stored email payload or a previous sender's attempt in the management list.
type InvitationReader = {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T>(): Promise<T | null>;
      all<T>(): Promise<{ results?: T[] }>;
    };
  };
};
const invitationViewSelect = `SELECT i.*,d.id AS emailId,d.state AS emailState,d.leaseUntil,d.firstSentAt,d.updatedAt AS emailUpdatedAt
  FROM invitation i LEFT JOIN team_invitation_delivery d
    ON d.orgId=i.organizationId AND d.invitationId=i.id AND d.id=i.deliveryId`;
const invitationViewRow = storedInvitationSchema.extend({
  emailId: z.string().nullable(),
  emailState: storedDeliverySchema.shape.state.nullable(),
  leaseUntil: z.number().nullable(),
  firstSentAt: z.number().nullable(),
  emailUpdatedAt: z.number().nullable(),
});
function invitationView(row: unknown): TeamInvitation {
  const invitation = invitationViewRow.parse(row);
  const now = Date.now();
  const state =
    invitation.emailState === "sending" && (invitation.leaseUntil ?? 0) <= now
      ? "uncertain"
      : (invitation.emailState ?? "unknown");
  return teamInvitationSchema.parse({
    ...invitation,
    delivery: {
      id: invitation.emailId,
      state,
      updatedAt: invitation.emailUpdatedAt,
      retryable:
        !!invitation.emailId &&
        invitation.status === "pending" &&
        invitation.expiresAt.getTime() > now &&
        state !== "accepted" &&
        (invitation.leaseUntil ?? 0) <= now &&
        (invitation.firstSentAt === null ||
          now < invitation.firstSentAt + RETRY_WINDOW_MS),
    },
  });
}
export async function readTeamInvitation(
  db: InvitationReader,
  orgId: string,
  id: string,
): Promise<TeamInvitation> {
  const row = await db
    .prepare(`${invitationViewSelect} WHERE i.organizationId=? AND i.id=?`)
    .bind(orgId, id)
    .first();
  if (!row)
    throw new TeamCommandError(
      404,
      "This invitation is no longer available. Refresh the team.",
    );
  return invitationView(row);
}
export async function listTeamInvitations(
  db: InvitationReader,
  orgId: string,
): Promise<TeamInvitation[]> {
  const rows = await db
    .prepare(
      `${invitationViewSelect} WHERE i.organizationId=? AND i.status='pending' ORDER BY i.createdAt DESC,i.id`,
    )
    .bind(orgId)
    .all();
  return (rows.results ?? []).map(invitationView);
}

/** Frozen invitation and email identity commit together. A receipt is never an
 * instruction to reopen/recreate the invitation or dispatch a newer attempt. */
export async function createTeamInvitation(
  db: Database,
  actor: Actor,
  raw: InvitationInput,
  baseUrl: string,
): Promise<TeamInvitation> {
  const input = {
    ...raw,
    email: raw.email.trim().toLowerCase(),
    role: normalizeRoles(raw.role),
    requestId: raw.requestId ?? crypto.randomUUID(),
  };
  if (
    !z.email().max(254).safeParse(input.email).success ||
    !z.uuid().safeParse(input.requestId).success
  )
    throw new TeamCommandError(
      400,
      "Enter a valid email address and invitation request ID.",
    );
  const access = await readTeamAuthority(db, actor, {
    orgId: input.orgId,
    kind: "invite",
  });
  const hash = await fingerprint([
    input.orgId,
    actor.userId,
    input.email,
    input.role,
    !!input.resend,
    input.invitationId ?? null,
    input.previousDeliveryId === undefined ? [] : [input.previousDeliveryId],
  ]);
  const receipt = async () => {
    const row = await db
      .prepare(
        "SELECT fingerprint,invitationId,deliveryId FROM team_invitation_request WHERE orgId=? AND actorId=? AND requestId=?",
      )
      .bind(input.orgId, actor.userId, input.requestId)
      .first<{
        fingerprint: string;
        invitationId: string;
        deliveryId: string;
      }>();
    if (row && row.fingerprint !== hash)
      throw new TeamCommandError(
        409,
        "This request ID belongs to a different invitation. Review the saved team before sending another.",
      );
    return row;
  };
  const saved = await receipt();
  if (saved)
    return deliverTeamInvitation(
      db,
      actor,
      input.orgId,
      saved.invitationId,
      saved.deliveryId,
    );
  const assignedRoles = input.role.split(",").filter(Boolean);
  if (
    !assignedRoles.length ||
    assignedRoles.some((role) => !access.knownRoles.has(role))
  )
    throw new TeamCommandError(400, "Choose an existing organization role.");
  if (assignedRoles.includes("owner") && !access.owner)
    throw new TeamCommandError(403, "Only an owner can invite another owner.");
  const { guard, params } = teamAuthorityGuard(actor, input.orgId, access);
  const memberExists =
    "EXISTS(SELECT 1 FROM member m JOIN user u ON u.id=m.userId WHERE m.organizationId=? AND lower(u.email)=?)";
  if (
    await db
      .prepare(`SELECT 1 WHERE ${memberExists}`)
      .bind(input.orgId, input.email)
      .first()
  )
    throw new TeamCommandError(
      409,
      "This person is already a member of the organization.",
    );
  guard.push(`NOT ${memberExists}`);
  params.push(input.orgId, input.email);
  const pending = await db
    .prepare(
      "SELECT * FROM invitation WHERE organizationId=? AND lower(email)=? AND status='pending' ORDER BY createdAt,id LIMIT 2",
    )
    .bind(input.orgId, input.email)
    .all();
  let existing: z.infer<typeof storedInvitationSchema> | null = null;
  if (input.resend) {
    if (pending.results.length !== 1)
      throw new TeamCommandError(
        409,
        "Review the invitation before sending again; a single pending invitation could not be confirmed.",
      );
    existing = storedInvitationSchema.parse(pending.results[0]);
    if (
      (input.invitationId && input.invitationId !== existing.id) ||
      existing.role !== input.role ||
      (input.previousDeliveryId !== undefined &&
        input.previousDeliveryId !== existing.deliveryId)
    )
      throw new TeamCommandError(
        409,
        "The invitation or email attempt changed. Refresh before sending again.",
      );
    const previous = await storedDelivery(
      db,
      input.orgId,
      existing.id,
      existing.deliveryId,
    );
    if (
      previous?.state === "sending" &&
      (previous.leaseUntil ?? 0) > Date.now()
    )
      throw new TeamCommandError(
        409,
        "An email attempt is still running. Refresh its status before sending again.",
      );
    guard.push(
      "EXISTS(SELECT 1 FROM invitation WHERE organizationId=? AND id=? AND status='pending' AND lower(email)=? AND role=? AND deliveryId IS ?)",
    );
    params.push(
      input.orgId,
      existing.id,
      input.email,
      input.role,
      existing.deliveryId,
    );
    // A retry may claim the old delivery after our read but before this batch.
    guard.push(
      "NOT EXISTS(SELECT 1 FROM team_invitation_delivery WHERE orgId=? AND invitationId=? AND id IS ? AND state='sending' AND leaseUntil>(julianday('now')-2440587.5)*86400000)",
    );
    params.push(input.orgId, existing.id, existing.deliveryId);
  } else {
    if (pending.results.length)
      throw new TeamCommandError(
        409,
        "This person already has a pending invitation. Review it before sending again.",
      );
    guard.push(
      "NOT EXISTS(SELECT 1 FROM invitation WHERE organizationId=? AND lower(email)=? AND status='pending')",
    );
    params.push(input.orgId, input.email);
  }
  const identity = await db
    .prepare(
      "SELECT o.name AS orgName,u.name AS inviterName FROM organization o JOIN user u ON u.id=? WHERE o.id=?",
    )
    .bind(actor.userId, input.orgId)
    .first<{ orgName: string; inviterName: string }>();
  if (!identity)
    throw new TeamCommandError(
      404,
      "The organization or inviter is no longer available.",
    );
  const id = existing?.id ?? crypto.randomUUID(),
    deliveryId = crypto.randomUUID(),
    now = Date.now();
  const inviteUrl = new URL(`/invite/${encodeURIComponent(id)}`, baseUrl).href;
  const payload = {
    to: input.email,
    ...invitationEmail(identity.orgName, identity.inviterName, inviteUrl),
  };
  const mutations = existing
    ? [
        db
          .prepare(
            "UPDATE invitation SET deliveryId=?,expiresAt=? WHERE organizationId=? AND id=?",
          )
          .bind(
            deliveryId,
            new Date(now + 48 * 60 * 60 * 1000).toISOString(),
            input.orgId,
            id,
          ),
      ]
    : [
        db
          .prepare(
            "INSERT INTO invitation(id,organizationId,email,role,status,expiresAt,inviterId,createdAt,deliveryId) VALUES(?,?,?,?,'pending',?,?,?,?)",
          )
          .bind(
            id,
            input.orgId,
            input.email,
            input.role,
            new Date(now + 48 * 60 * 60 * 1000).toISOString(),
            actor.userId,
            new Date(now).toISOString(),
            deliveryId,
          ),
      ];
  markDatabaseWrite();
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO team_invitation_request(orgId,actorId,requestId,fingerprint,invitationId,deliveryId,createdAt,precondition) VALUES(?,?,?,?,?,?,?,CASE WHEN ${guard.join(" AND ")} THEN 1 ELSE 0 END)`,
        )
        .bind(
          input.orgId,
          actor.userId,
          input.requestId,
          hash,
          id,
          deliveryId,
          now,
          ...params,
        ),
      ...mutations,
      db
        .prepare(
          "INSERT INTO team_invitation_delivery(id,orgId,invitationId,actorId,payload,state,createdAt,updatedAt) VALUES(?,?,?,?,?,'ready',?,?)",
        )
        .bind(
          deliveryId,
          input.orgId,
          id,
          actor.userId,
          JSON.stringify(payload),
          now,
          now,
        ),
    ]);
  } catch (error) {
    const raced = await receipt();
    if (raced)
      return deliverTeamInvitation(
        db,
        actor,
        input.orgId,
        raced.invitationId,
        raced.deliveryId,
      );
    if (
      error instanceof Error &&
      error.message.includes("organization member limit reached")
    )
      throw new TeamCommandError(
        403,
        "This workspace has reached its member limit. Review pending invitations or its plan before inviting another person.",
      );
    if (
      error instanceof Error &&
      error.message.includes("team_invitation_precondition")
    )
      throw new TeamCommandError(
        409,
        "The team or invitation changed. Refresh before sending another invitation.",
      );
    throw new TeamCommandError(
      500,
      "Invitation creation could not be confirmed. Retry the same request.",
    );
  }
  return deliverTeamInvitation(db, actor, input.orgId, id, deliveryId);
}

/** A lease fences local attempts; the frozen provider key/payload fences a send
 * that committed remotely before its acknowledgement was lost. */
export async function deliverTeamInvitation(
  db: Database,
  actor: Actor,
  orgId: string,
  invitationId: string,
  deliveryId: string,
): Promise<TeamInvitation> {
  const access = await readTeamAuthority(db, actor, { orgId, kind: "invite" });
  const invitation = await storedInvitation(db, orgId, invitationId);
  if (
    invitation.role
      ?.split(",")
      .map((role) => role.trim())
      .includes("owner") &&
    !access.owner
  )
    throw new TeamCommandError(
      403,
      "Only an owner can send an ownership invitation.",
    );
  if (invitation.deliveryId !== deliveryId)
    return readTeamInvitation(db, orgId, invitationId);
  const delivery = await storedDelivery(db, orgId, invitationId, deliveryId);
  if (!delivery)
    throw new TeamCommandError(
      409,
      "This email attempt could not be found. Review the invitation before sending again.",
    );
  const payload = payloadSchema.parse(JSON.parse(delivery.payload));
  const { guard, params } = teamAuthorityGuard(actor, orgId, access);
  const now = Date.now(),
    nonce = crypto.randomUUID();
  markDatabaseWrite();
  const claimed = await db
    .prepare(
      `UPDATE team_invitation_delivery SET state='sending',leaseNonce=?,leaseUntil=?,firstSentAt=COALESCE(firstSentAt,?),updatedAt=?
    WHERE orgId=? AND invitationId=? AND id=? AND state<>'accepted' AND (leaseUntil IS NULL OR leaseUntil<=?)
      AND (firstSentAt IS NULL OR firstSentAt>?)
      AND EXISTS(SELECT 1 FROM invitation WHERE organizationId=? AND id=? AND deliveryId=? AND status='pending'
        AND (CASE WHEN typeof(expiresAt) IN ('integer','real') THEN expiresAt ELSE (julianday(expiresAt)-2440587.5)*86400000 END)>(julianday('now')-2440587.5)*86400000)
      AND ${guard.join(" AND ")}`,
    )
    .bind(
      nonce,
      now + LEASE_MS,
      now,
      now,
      orgId,
      invitationId,
      deliveryId,
      now,
      now - RETRY_WINDOW_MS,
      orgId,
      invitationId,
      deliveryId,
      ...params,
    )
    .run();
  if (claimed.meta.changes !== 1)
    return readTeamInvitation(db, orgId, invitationId);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let state: "accepted" | "failed" | "uncertain";
  try {
    await Promise.race([
      sendInvitationWithSetupReceipt({
        orgId,
        email: invitation.email,
        invitationId,
        send: (signal) =>
          sendEmail({
            ...payload,
            idempotencyKey: `team-invitation/${deliveryId}`,
            signal: signal
              ? AbortSignal.any([controller.signal, signal])
              : controller.signal,
          }),
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Email confirmation timed out"));
        }, SEND_TIMEOUT_MS);
      }),
    ]);
    state = "accepted";
  } catch (error) {
    state = error instanceof EmailDeliveryRejected ? "failed" : "uncertain";
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  await db
    .prepare(
      "UPDATE team_invitation_delivery SET state=?,leaseNonce=NULL,leaseUntil=NULL,updatedAt=? WHERE orgId=? AND invitationId=? AND id=? AND leaseNonce=?",
    )
    .bind(state, Date.now(), orgId, invitationId, deliveryId, nonce)
    .run();
  return readTeamInvitation(db, orgId, invitationId);
}
