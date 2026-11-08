import { nextFixtureAddress } from "@/test/fixture-address";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { SELF } from "cloudflare:test";
import { hashPassword } from "better-auth/crypto";
import { getPrisma } from "../db";
import { acceptInvitation, rejectInvitation, getInvitationDetails } from "../session";
import { respondToInvitationAtomically } from "../invitation-response.server";
const request = vi.hoisted(() => ({ cookie: "" }));
vi.mock("better-auth/tanstack-start", () => ({ tanstackStartCookies: () => ({ id: "test-cookie-bridge" }) }));
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => new Headers({ Cookie: request.cookie }), setResponseHeader: vi.fn() }));
afterEach(() => { request.cookie = ""; });
vi.mock("@tanstack/react-start", () => {
  const builder = () => {
    let validate = (value: unknown) => value;
    const chain = { middleware: () => chain, inputValidator: (fn: typeof validate) => { validate = fn; return chain; },
      handler: (fn: (input: unknown) => unknown) => (input: { data: unknown }) => fn({ data: validate(input.data) }), server: () => chain };
    return chain;
  };
  return { createServerFn: builder, createMiddleware: builder, createServerOnlyFn: <T>(fn: T): T => fn };
});
async function fixture() {
  const prisma = getPrisma(); const id = crypto.randomUUID(); const orgId = crypto.randomUUID();
  const email = `${id}@example.test`; const password = "Chat-invite-fixture-password-92!";
  await prisma.user.create({ data: { id, name: "Invited fixture", email, emailVerified: true } });
  await prisma.account.create({ data: { id: crypto.randomUUID(), issuer: "local:credential", accountId: id, providerId: "credential", userId: id, password: await hashPassword(password) } });
  await prisma.organization.create({ data: { id: orgId, name: "Planning fixture", slug: orgId, createdAt: new Date() } });
  await prisma.member.create({ data: { id: crypto.randomUUID(), organizationId: orgId, userId: id, role: "owner", createdAt: new Date() } });
  const response = await SELF.fetch(new Request("https://app.showpilot.tech/api/auth/sign-in/email", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://app.showpilot.tech", "cf-connecting-ip": nextFixtureAddress() }, body: JSON.stringify({ email, password }) }));
  expect(response.status).toBe(200); await response.arrayBuffer();
  request.cookie = response.headers.getSetCookie().map(cookie => cookie.split(";")[0]).join("; ");
  const owner = crypto.randomUUID();
  await prisma.user.create({ data: { id: owner, name: "Inviter", email: `${owner}@example.test`, emailVerified: true } });
  await prisma.member.deleteMany({ where: { userId: id, organizationId: orgId } });
  await prisma.member.create({ data: { id: crypto.randomUUID(), organizationId: orgId, userId: owner, role: "owner", createdAt: new Date() } });
  const invitationId = crypto.randomUUID();
  await prisma.invitation.create({ data: { id: invitationId, organizationId: orgId, inviterId: owner, email, role: "member", status: "pending", expiresAt: new Date(Date.now() + 3600_000) } });
  return { prisma, id, orgId, invitationId };
}

it("recovers an already accepted invitation without adding another membership", async () => {
  const f = await fixture();
  await acceptInvitation({ data: f.invitationId });
  await expect(acceptInvitation({ data: f.invitationId })).resolves.toBeDefined();
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM member WHERE organizationId=? AND userId=?").bind(f.orgId,f.id).first()).toEqual({ count: 1 });
});
it("recovers an already declined invitation without reverting its outcome", async () => {
  const f = await fixture();
  await rejectInvitation({ data: f.invitationId });
  await expect(rejectInvitation({ data: f.invitationId })).resolves.toBeDefined();
  expect(await f.prisma.invitation.findUnique({ where: { id: f.invitationId } })).toMatchObject({ status: "rejected" });
});

it("does not leave a membership behind when acceptance cannot update the session", async () => {
  const f = await fixture();
  await env.DB.prepare(`CREATE TRIGGER reject_invite_activation BEFORE UPDATE ON session
    WHEN NEW.userId='${f.id}' AND NEW.activeOrganizationId='${f.orgId}'
    BEGIN SELECT RAISE(ABORT, 'fixture session activation failure'); END`).run();
  try {
    const response = await SELF.fetch(new Request("https://app.showpilot.tech/api/auth/organization/accept-invitation", {
      method: "POST", headers: { Cookie: request.cookie, Origin: "https://app.showpilot.tech", "Content-Type": "application/json" }, body: JSON.stringify({ invitationId: f.invitationId }),
    }));
    expect(response.status).toBe(500); await response.arrayBuffer();
  } finally { await env.DB.exec("DROP TRIGGER reject_invite_activation"); }
  expect(await f.prisma.member.count({ where: { organizationId: f.orgId, userId: f.id } })).toBe(0);
  expect(await f.prisma.invitation.findUnique({ where: { id: f.invitationId } })).toMatchObject({ status: "pending" });
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM invitation_response WHERE invitationId=?").bind(f.invitationId).first()).toEqual({ count: 0 });
  await acceptInvitation({ data: f.invitationId });
  expect(await f.prisma.member.count({ where: { organizationId: f.orgId, userId: f.id } })).toBe(1);
});

async function actor(f: Awaited<ReturnType<typeof fixture>>) {
  const session = await f.prisma.session.findFirstOrThrow({ where: { userId: f.id } });
  return { userId: f.id, sessionId: session.id };
}

it("serializes competing accept and decline decisions and never changes the winning outcome", async () => {
  const f = await fixture(); const identity = await actor(f);
  const outcomes = await Promise.allSettled([
    respondToInvitationAtomically(env.DB, identity, f.invitationId, "accepted"),
    respondToInvitationAtomically(env.DB, identity, f.invitationId, "rejected"),
  ]);
  expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
  const receipt = await env.DB.prepare("SELECT decision FROM invitation_response WHERE invitationId=?").bind(f.invitationId).first<{ decision: "accepted" | "rejected" }>();
  if (!receipt) throw new Error("Decision missing");
  expect(await f.prisma.invitation.findUnique({ where: { id: f.invitationId } })).toMatchObject({ status: receipt.decision });
  expect(await f.prisma.member.count({ where: { organizationId: f.orgId, userId: f.id } })).toBe(receipt.decision === "accepted" ? 1 : 0);
  await respondToInvitationAtomically(env.DB, identity, f.invitationId, receipt.decision);
});

it("enforces the member limit inside concurrent transactions", async () => {
  const first = await fixture(); const second = await fixture();
  const secondUser = await second.prisma.user.findUniqueOrThrow({ where: { id: second.id } });
  const invitation = await first.prisma.invitation.findUniqueOrThrow({ where: { id: first.invitationId } });
  const secondId = crypto.randomUUID();
  await first.prisma.invitation.create({ data: { ...invitation, id: secondId, email: secondUser.email } });
  const outcomes = await Promise.allSettled([
    respondToInvitationAtomically(env.DB, await actor(first), first.invitationId, "accepted", 2),
    respondToInvitationAtomically(env.DB, await actor(second), secondId, "accepted", 2),
  ]);
  expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
  expect(await first.prisma.member.count({ where: { organizationId: first.orgId } })).toBe(2);
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM invitation_response WHERE orgId=?").bind(first.orgId).first()).toEqual({ count: 1 });
});

it("replays without restoring membership, changing a later role or switching the active workspace", async () => {
  const f = await fixture(); const identity = await actor(f);
  const saved = await respondToInvitationAtomically(env.DB, identity, f.invitationId, "accepted");
  if (!saved.member) throw new Error("Membership missing");
  await f.prisma.member.update({ where: { id: saved.member.id }, data: { role: "viewer" } });
  await f.prisma.session.update({ where: { id: identity.sessionId }, data: { activeOrganizationId: null } });
  expect(await respondToInvitationAtomically(env.DB, identity, f.invitationId, "accepted")).toMatchObject({ member: { id: saved.member.id, role: "viewer" } });
  expect(await f.prisma.session.findUnique({ where: { id: identity.sessionId } })).toMatchObject({ activeOrganizationId: null });
  await f.prisma.member.delete({ where: { id: saved.member.id } });
  await expect(respondToInvitationAtomically(env.DB, identity, f.invitationId, "accepted")).rejects.toThrow("access is no longer available");
  expect(await f.prisma.member.count({ where: { organizationId: f.orgId, userId: f.id } })).toBe(0);
});

it("keeps an existing membership and role when accepting a second invitation", async () => {
  const f = await fixture(); const identity = await actor(f);
  const member = await f.prisma.member.create({ data: { id: crypto.randomUUID(), organizationId: f.orgId, userId: f.id, role: "admin", createdAt: new Date() } });
  const saved = await respondToInvitationAtomically(env.DB, identity, f.invitationId, "accepted", 1);
  expect(saved.member).toMatchObject({ id: member.id, role: "admin" });
  expect(await f.prisma.member.count({ where: { organizationId: f.orgId, userId: f.id } })).toBe(1);
});

it("requires the fresh verified recipient and rejects revoked sessions and expired invitations", async () => {
  const f = await fixture(); const identity = await actor(f);
  await f.prisma.user.update({ where: { id: f.id }, data: { emailVerified: false } });
  await expect(respondToInvitationAtomically(env.DB, identity, f.invitationId, "accepted")).rejects.toThrow("Verify your email");
  await f.prisma.user.update({ where: { id: f.id }, data: { emailVerified: true } });
  const wrong = await fixture();
  await expect(respondToInvitationAtomically(env.DB, await actor(wrong), f.invitationId, "accepted")).rejects.toThrow("account this invitation");
  await f.prisma.invitation.update({ where: { id: f.invitationId }, data: { expiresAt: new Date(Date.now() - 1000) } });
  await expect(respondToInvitationAtomically(env.DB, identity, f.invitationId, "accepted")).rejects.toThrow("expired");
  await f.prisma.session.delete({ where: { id: identity.sessionId } });
  await expect(respondToInvitationAtomically(env.DB, identity, f.invitationId, "rejected")).rejects.toThrow("Sign in again");
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM invitation_response WHERE orgId=?").bind(f.orgId).first()).toEqual({ count: 0 });
});


it("recovers a committed decision after the response is lost, including concurrent duplicate accepts", async () => {
  const f = await fixture(); const identity = await actor(f);
  const interrupted: Pick<D1Database, "prepare" | "batch"> = {
    prepare: sql => env.DB.prepare(sql),
    batch: async statements => { await env.DB.batch(statements); throw new Error("fixture lost committed reply"); },
  };
  await expect(respondToInvitationAtomically(interrupted, identity, f.invitationId, "accepted")).rejects.toThrow("lost committed reply");
  const replies = await Promise.all(Array.from({ length: 3 }, () => respondToInvitationAtomically(env.DB, identity, f.invitationId, "accepted")));
  expect(new Set(replies.map(reply => reply.member?.id)).size).toBe(1);
  expect(await f.prisma.member.count({ where: { organizationId: f.orgId, userId: f.id } })).toBe(1);
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM invitation_response WHERE invitationId=?").bind(f.invitationId).first()).toEqual({ count: 1 });
});

it("shares one membership between concurrently accepted invitations for the same recipient", async () => {
  const f = await fixture(); const identity = await actor(f);
  const original = await f.prisma.invitation.findUniqueOrThrow({ where: { id: f.invitationId } });
  const secondId = crypto.randomUUID();
  await f.prisma.invitation.create({ data: { ...original, id: secondId, role: "admin" } });
  const replies = await Promise.all([
    respondToInvitationAtomically(env.DB, identity, f.invitationId, "accepted", 2),
    respondToInvitationAtomically(env.DB, identity, secondId, "accepted", 2),
  ]);
  expect(replies[0].member?.id).toBe(replies[1].member?.id);
  expect(replies[0].member?.role).toBe(replies[1].member?.role);
  expect(await f.prisma.member.count({ where: { organizationId: f.orgId, userId: f.id } })).toBe(1);
});

it("reveals invitation details only to the current verified recipient, even with an old cookie", async () => {
  const f = await fixture(); const cookie = request.cookie;
  expect(await getInvitationDetails({ data: f.invitationId })).toMatchObject({ status: "pending", invitation: { organization: { id: f.orgId } } });
  request.cookie = "";
  expect(await getInvitationDetails({ data: f.invitationId })).toEqual({ status: "signed-out" });
  request.cookie = cookie;
  await f.prisma.user.update({ where: { id: f.id }, data: { emailVerified: false } });
  expect(await getInvitationDetails({ data: f.invitationId })).toEqual({ status: "unverified", email: `${f.id}@example.test` });
  await f.prisma.user.update({ where: { id: f.id }, data: { emailVerified: true, email: `changed-${f.id}@example.test` } });
  expect(await getInvitationDetails({ data: f.invitationId })).toEqual({ status: "wrong-account", email: `changed-${f.id}@example.test` });
  await f.prisma.session.deleteMany({ where: { userId: f.id } });
  expect(await getInvitationDetails({ data: f.invitationId })).toEqual({ status: "signed-out" });
});

it("distinguishes expired, canceled, missing, accepted, declined and removed-access views", async () => {
  const f = await fixture();
  expect(await getInvitationDetails({ data: crypto.randomUUID() })).toEqual({ status: "unavailable" });
  await f.prisma.invitation.update({ where: { id: f.invitationId }, data: { expiresAt: new Date(Date.now() - 1000) } });
  expect(await getInvitationDetails({ data: f.invitationId })).toMatchObject({ status: "expired" });
  await f.prisma.invitation.update({ where: { id: f.invitationId }, data: { status: "canceled" } });
  expect(await getInvitationDetails({ data: f.invitationId })).toMatchObject({ status: "canceled" });
  await f.prisma.invitation.update({ where: { id: f.invitationId }, data: { status: "pending", expiresAt: new Date(Date.now() + 3600_000) } });
  const accepted = await acceptInvitation({ data: f.invitationId });
  expect(await getInvitationDetails({ data: f.invitationId })).toMatchObject({ status: "accepted" });
  if (!accepted.member) throw new Error("Membership missing");
  await f.prisma.member.delete({ where: { id: accepted.member.id } });
  await f.prisma.member.create({ data: { id: crypto.randomUUID(), organizationId: f.orgId, userId: f.id, role: "viewer", createdAt: new Date() } });
  expect(await getInvitationDetails({ data: f.invitationId })).toMatchObject({ status: "access-removed" });
  await expect(acceptInvitation({ data: f.invitationId })).rejects.toThrow("access is no longer available");
  const declined = await fixture();
  await rejectInvitation({ data: declined.invitationId });
  expect(await getInvitationDetails({ data: declined.invitationId })).toMatchObject({ status: "declined" });
});

it("keeps the raw auth endpoint response compatible and enforces origin protection", async () => {
  const f = await fixture();
  const respond = (origin: string) => SELF.fetch(new Request("https://app.showpilot.tech/api/auth/organization/accept-invitation", {
    method: "POST", headers: { Cookie: request.cookie, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ invitationId: f.invitationId }),
  }));
  const denied = await respond("https://untrusted.example");
  expect(denied.status).toBe(403); await denied.arrayBuffer();
  expect(await f.prisma.invitation.findUnique({ where: { id: f.invitationId } })).toMatchObject({ status: "pending" });
  const accepted = await respond("https://app.showpilot.tech");
  expect(accepted.status).toBe(200);
  expect(accepted.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await accepted.json()).toMatchObject({ invitation: { id: f.invitationId, organizationId: f.orgId, status: "accepted" }, member: { userId: f.id, organizationId: f.orgId, role: "member" } });
});

it("converts a reserved invitation slot into membership when the free workspace is at capacity", async () => {
  const f = await fixture();
  const original = await f.prisma.invitation.findUniqueOrThrow({ where: { id: f.invitationId } });
  for (let index = 0; index < 3; index++) await f.prisma.invitation.create({ data: { ...original, id: crypto.randomUUID(), email: `reserved-${index}@example.test` } });
  expect(await f.prisma.member.count({ where: { organizationId: f.orgId } })).toBe(1);
  expect(await f.prisma.invitation.count({ where: { organizationId: f.orgId, status: "pending" } })).toBe(4);
  await acceptInvitation({ data: f.invitationId });
  expect(await f.prisma.member.count({ where: { organizationId: f.orgId } })).toBe(2);
  expect(await f.prisma.invitation.count({ where: { organizationId: f.orgId, status: "pending" } })).toBe(3);
});
