import { markDatabaseWrite } from "./request-database.server";
import { getPlanMemberLimitForOrg } from "./plan-limits";
import type { InvitationView } from "./invitation-view";

type Database = Pick<D1Database, "prepare" | "batch">;
export type InvitationDecision = "accepted" | "rejected";
type Actor = { userId: string; sessionId: string };
export class InvitationResponseError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409, readonly code: string, message: string) { super(message); }
}
type StoredInvitation = {
  id: string; organizationId: string; email: string; role: string | null; status: string;
  expiresAt: string | number; createdAt: string | number; inviterId: string;
};
type Receipt = { actorId: string | null; decision: InvitationDecision; memberId: string | null };
type Member = { id: string; organizationId: string; userId: string; role: string; createdAt: string | number };
type SavedResponse = { invitation: Omit<StoredInvitation, "createdAt" | "expiresAt"> & { createdAt: Date; expiresAt: Date }; member: (Omit<Member, "createdAt"> & { createdAt: Date }) | null };

/** The caller supplies a freshly read session. Anonymous and unrelated accounts
 * receive no invitation email, inviter identity or workspace details. */
export async function readInvitationView(db: Database, user: { id: string; email: string; emailVerified: boolean } | null, invitationId: string): Promise<InvitationView> {
  if (!user) return { status: "signed-out" };
  if (!user.emailVerified) return { status: "unverified", email: user.email };
  const row = await db.prepare(`SELECT i.id,i.email,i.status,i.role,i.expiresAt,i.organizationId,o.name,o.slug,
    r.actorId,r.decision,r.memberId FROM invitation i JOIN organization o ON o.id=i.organizationId
    LEFT JOIN invitation_response r ON r.invitationId=i.id AND r.orgId=i.organizationId WHERE i.id=?`)
    .bind(invitationId).first<Pick<StoredInvitation, "id" | "email" | "status" | "role" | "expiresAt" | "organizationId"> & {
      name: string; slug: string; actorId: string | null; decision: InvitationDecision | null; memberId: string | null;
    }>();
  if (!row) return { status: "unavailable" };
  if (row.email.toLowerCase() !== user.email.toLowerCase() || (row.decision && row.actorId !== user.id)) return { status: "wrong-account", email: user.email };
  const invitation = { id: row.id, role: row.role ?? "member", expiresAt: new Date(row.expiresAt).getTime(), organization: { id: row.organizationId, name: row.name, slug: row.slug } };
  if (!Number.isFinite(invitation.expiresAt)) throw new Error("The invitation expiry could not be read. Ask an administrator for a new invitation.");
  const common = { invitation, email: user.email };
  const status = row.decision ?? row.status;
  if (status === "accepted") {
    const member = await db.prepare(`SELECT id FROM member WHERE organizationId=? AND userId=? ${row.decision ? "AND id=?" : ""} LIMIT 1`)
      .bind(row.organizationId, user.id, ...(row.decision ? [row.memberId] : [])).first();
    return { ...common, status: member ? "accepted" : "access-removed" };
  }
  if (status === "rejected") return { ...common, status: "declined" };
  if (status === "canceled") return { ...common, status: "canceled" };
  if (status !== "pending") return { status: "unavailable" };
  return { ...common, status: invitation.expiresAt <= Date.now() ? "expired" : "pending" };
}

async function authenticatedInvitation(db: Database, actor: Actor, invitationId: string) {
  const identity = await db.prepare(`SELECT u.email,u.emailVerified FROM session s JOIN user u ON u.id=s.userId
    WHERE s.id=? AND s.userId=? AND (CASE WHEN typeof(s.expiresAt) IN ('integer','real') THEN s.expiresAt
      ELSE (julianday(s.expiresAt)-2440587.5)*86400000 END)>?`).bind(actor.sessionId, actor.userId, Date.now()).first<{ email: string; emailVerified: number }>();
  if (!identity) throw new InvitationResponseError(401, "UNAUTHORIZED", "Sign in again before responding to this invitation.");
  if (!identity.emailVerified) throw new InvitationResponseError(403, "EMAIL_VERIFICATION_REQUIRED", "Verify your email before responding to this invitation.");
  const invitation = await db.prepare(`SELECT i.* FROM invitation i JOIN organization o ON o.id=i.organizationId WHERE i.id=?`).bind(invitationId).first<StoredInvitation>();
  if (!invitation) throw new InvitationResponseError(404, "INVITATION_NOT_FOUND", "This invitation is no longer available.");
  if (invitation.email.toLowerCase() !== identity.email.toLowerCase()) throw new InvitationResponseError(403, "WRONG_INVITATION_RECIPIENT", "Sign in with the account this invitation was sent to.");
  return invitation;
}

async function savedResponse(db: Database, actor: Actor, invitation: StoredInvitation, decision: InvitationDecision): Promise<SavedResponse | null> {
  const receipt = await db.prepare("SELECT actorId,decision,memberId FROM invitation_response WHERE invitationId=? AND orgId=?")
    .bind(invitation.id, invitation.organizationId).first<Receipt>();
  if (receipt && receipt.actorId !== actor.userId) throw new InvitationResponseError(403, "INVITATION_ACCOUNT_CHANGED", "This invitation was answered by a different account. Ask for a new invitation.");
  const status = receipt?.decision ?? invitation.status;
  if (status === "pending") return null;
  if (status !== decision) throw new InvitationResponseError(409, "INVITATION_ALREADY_ANSWERED", "This invitation already has a different response. Check its current status.");
  const member = decision === "accepted" ? await db.prepare(`SELECT id,organizationId,userId,role,createdAt FROM member WHERE organizationId=? AND userId=? ${receipt ? "AND id=?" : ""} LIMIT 1`)
    .bind(invitation.organizationId, actor.userId, ...(receipt ? [receipt.memberId] : [])).first<Member>() : null;
  if (decision === "accepted" && !member) throw new InvitationResponseError(409, "INVITATION_ACCESS_REMOVED", "This invitation was accepted, but its workspace access is no longer available. Ask an administrator for a new invitation.");
  return { invitation: { ...invitation, status: decision, createdAt: new Date(invitation.createdAt), expiresAt: new Date(invitation.expiresAt) }, member: member ? { ...member, createdAt: new Date(member.createdAt) } : null };
}

/** Receipt, decision, membership and legacy default activation commit together.
 * A replay only reads: it cannot restore access, rewrite a role or switch a session. */
export async function respondToInvitationAtomically(db: Database, actor: Actor, invitationId: string, decision: InvitationDecision, memberLimit?: number): Promise<SavedResponse> {
  const invitation = await authenticatedInvitation(db, actor, invitationId);
  const saved = await savedResponse(db, actor, invitation, decision);
  if (saved) return saved;
  const configuredLimit = memberLimit ?? await getPlanMemberLimitForOrg(invitation.organizationId);
  const now = Date.now(); const timestamp = new Date(now).toISOString();
  if (new Date(invitation.expiresAt).getTime() <= now) throw new InvitationResponseError(400, "INVITATION_EXPIRED", "This invitation has expired. Ask for a new invitation.");
  const nonce = crypto.randomUUID(); const memberId = crypto.randomUUID();
  const limit = Number.isFinite(configuredLimit) ? configuredLimit : Number.MAX_SAFE_INTEGER;
  markDatabaseWrite();
  await db.batch([
    db.prepare(`INSERT INTO invitation_response (invitationId,orgId,actorId,decision,nonce,memberId,respondedAt)
      SELECT i.id,i.organizationId,u.id,?,?,CASE WHEN ?='accepted' THEN COALESCE(
        (SELECT id FROM member WHERE organizationId=i.organizationId AND userId=u.id ORDER BY createdAt,id LIMIT 1),?) ELSE NULL END,?
      FROM invitation i JOIN organization o ON o.id=i.organizationId JOIN user u ON u.id=? JOIN session s ON s.userId=u.id AND s.id=?
      WHERE i.id=? AND i.organizationId=? AND i.status='pending' AND lower(i.email)=lower(u.email) AND u.emailVerified=1
        AND (CASE WHEN typeof(i.expiresAt) IN ('integer','real') THEN i.expiresAt ELSE (julianday(i.expiresAt)-2440587.5)*86400000 END)>?
        AND (CASE WHEN typeof(s.expiresAt) IN ('integer','real') THEN s.expiresAt ELSE (julianday(s.expiresAt)-2440587.5)*86400000 END)>?
        AND (?='rejected' OR EXISTS(SELECT 1 FROM member WHERE organizationId=i.organizationId AND userId=u.id)
          OR (SELECT COUNT(*) FROM member WHERE organizationId=i.organizationId)<?)
      ON CONFLICT(invitationId) DO NOTHING`)
      .bind(decision, nonce, decision, memberId, timestamp, actor.userId, actor.sessionId, invitation.id, invitation.organizationId, now, now, decision, limit),
    // Release the reserved invitation slot before membership insertion. The
    // batch still rolls both changes back if any later statement fails.
    db.prepare(`UPDATE invitation SET status=? WHERE id=? AND organizationId=? AND status='pending'
      AND EXISTS(SELECT 1 FROM invitation_response WHERE invitationId=? AND orgId=? AND nonce=?)`)
      .bind(decision, invitation.id, invitation.organizationId, invitation.id, invitation.organizationId, nonce),
    db.prepare(`INSERT INTO member (id,organizationId,userId,role,createdAt)
      SELECT r.memberId,r.orgId,r.actorId,COALESCE(i.role,'member'),r.respondedAt FROM invitation_response r JOIN invitation i ON i.id=r.invitationId AND i.organizationId=r.orgId
      WHERE r.invitationId=? AND r.orgId=? AND r.nonce=? AND r.decision='accepted'
        AND NOT EXISTS(SELECT 1 FROM member WHERE organizationId=r.orgId AND userId=r.actorId)`)
      .bind(invitation.id, invitation.organizationId, nonce),
    db.prepare(`UPDATE session SET activeOrganizationId=?,updatedAt=? WHERE id=? AND userId=?
      AND EXISTS(SELECT 1 FROM invitation_response WHERE invitationId=? AND orgId=? AND nonce=? AND decision='accepted')`)
      .bind(invitation.organizationId, timestamp, actor.sessionId, actor.userId, invitation.id, invitation.organizationId, nonce),
  ]);
  const current = await authenticatedInvitation(db, actor, invitationId);
  const result = await savedResponse(db, actor, current, decision);
  if (result) return result;
  if (new Date(current.expiresAt).getTime() <= Date.now()) throw new InvitationResponseError(400, "INVITATION_EXPIRED", "This invitation has expired. Ask for a new invitation.");
  if (decision === "accepted") {
    const count = await db.prepare("SELECT COUNT(*) AS count FROM member WHERE organizationId=?").bind(invitation.organizationId).first<{ count: number }>();
    if ((count?.count ?? 0) >= limit) throw new InvitationResponseError(403, "ORGANIZATION_MEMBERSHIP_LIMIT_REACHED", "This workspace has reached its member limit. Ask an administrator to review its plan.");
  }
  throw new InvitationResponseError(409, "INVITATION_RESPONSE_UNCONFIRMED", "Your response could not be confirmed. Check the invitation status before retrying.");
}
