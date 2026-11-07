import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import { getPrisma } from "../db";
import { hashPassword } from "better-auth/crypto";
import { getAuth } from "../auth";
const auth = vi.hoisted(() => {
  const emails: { to: string; subject: string; html: string; idempotencyKey?: string }[] = [];
  const barrier: { promise: Promise<void> | null } = { promise: null };
  return { cookie: "", delivery: "accept", sends: 0, ip: 0, emails, barrier };
});
vi.mock("better-auth/tanstack-start", () => ({ tanstackStartCookies: () => ({ id: "test-cookie-bridge" }) }));
vi.mock("../email", async importOriginal => {
  const actual = await importOriginal<typeof import("../email")>();
  return { ...actual, sendEmail: async (input: Parameters<typeof actual.sendEmail>[0]) => {
    auth.sends++; auth.emails.push({ to: input.to, subject: input.subject, html: input.html, idempotencyKey: input.idempotencyKey });
    const mode = auth.delivery;
    if (mode === "hold" && auth.barrier.promise) await auth.barrier.promise;
    if (mode === "reject") throw new actual.EmailDeliveryRejected("Fixture provider rejected");
    if (mode === "lost") throw new Error("Provider outcome unknown");
  } };
});
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => new Headers({ Cookie: auth.cookie }) }));
vi.mock("@tanstack/react-start", () => {
  const builder = () => { let validate = (value: unknown) => value;
    const chain = { middleware: () => chain, inputValidator: (fn: typeof validate) => { validate = fn; return chain; }, handler: (fn: (input: { data: unknown }) => unknown) => async (input: { data: unknown }) => fn({ data: validate(input.data) }), server: () => chain };
    return chain;
  };
  return { createServerFn: builder, createMiddleware: builder, createServerOnlyFn: <T>(fn: T): T => fn };
});
beforeEach(() => { auth.delivery = "accept"; auth.sends = 0; auth.cookie = ""; auth.emails.length = 0; auth.barrier.promise = null; });
async function fixture() {
  const { orgId, userId } = await seedRelayMember(crypto.randomUUID());
  const password = "Disposable-setup-password-92!";
  await getPrisma().account.create({ data: { id: crypto.randomUUID(), issuer: "local:credential", accountId: userId, providerId: "credential", userId, password: await hashPassword(password) } });
  const login = await getAuth().handler(new Request("https://app.showpilot.tech/api/auth/sign-in/email", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://app.showpilot.tech", "cf-connecting-ip": `192.0.2.${++auth.ip}` }, body: JSON.stringify({ email: `${userId}@example.test`, password }) }));
  expect(login.status).toBe(200); await login.arrayBuffer(); auth.cookie = login.headers.getSetCookie().map(cookie => cookie.split(";")[0]).join("; ");
  return { orgId, userId };

}

async function invite(orgId: string, email: string, requestId: string, options: { role?: string; resend?: boolean; invitationId?: string; previousDeliveryId?: string | null } = {}) {
  const response = await getAuth().handler(new Request("https://app.showpilot.tech/api/auth/organization/invite-member", {
    method: "POST", headers: { Cookie: auth.cookie, Origin: "https://app.showpilot.tech", "Content-Type": "application/json", "Idempotency-Key": requestId, "cf-connecting-ip": `198.51.100.${++auth.ip}`, ...(options.invitationId ? { "X-ShowPilot-Invitation": options.invitationId } : {}), ...(options.previousDeliveryId !== undefined ? { "X-ShowPilot-Previous-Delivery": options.previousDeliveryId ?? "none" } : {}) },
    body: JSON.stringify({ organizationId: orgId, email, role: options.role ?? "member", resend: options.resend }),
  }));
  const body: unknown = await response.json();
  return { status: response.status, body };
}

it("recovers the same created invitation after a lost reply without sending again", async () => {
  const f = await fixture(), id = crypto.randomUUID();
  const first = await invite(f.orgId, "retry@example.test", id);
  expect(first.status).toBe(200);
  const retry = await invite(f.orgId, "retry@example.test", id);
  expect(retry.status).toBe(200);
  expect(retry.body).toMatchObject({ id: expect.any(String), delivery: { state: "accepted" } });
  expect(auth.sends).toBe(1);
  expect(await getPrisma().invitation.count({ where: { organizationId: f.orgId } })).toBe(1);
});

it("reports rejected email delivery while keeping the created invitation usable", async () => {
  const f = await fixture(); auth.delivery = "reject";
  const response = await invite(f.orgId, "rejected@example.test", crypto.randomUUID());
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ id: expect.any(String), status: "pending", delivery: { state: "failed" } });
  expect(await getPrisma().invitation.count({ where: { organizationId: f.orgId } })).toBe(1);
});

it("does not label an unknown provider outcome as email accepted", async () => {
  const f = await fixture(); auth.delivery = "lost";
  const response = await invite(f.orgId, "uncertain@example.test", crypto.randomUUID());
  expect(response.body).toMatchObject({ id: expect.any(String), delivery: { state: "uncertain" } });
});

it("records a request before cancellation so an old retry cannot reopen or recreate it", async () => {
  const f = await fixture(), id = crypto.randomUUID();
  expect((await invite(f.orgId, "cancelled@example.test", id)).status).toBe(200);
  await getPrisma().invitation.updateMany({ where: { organizationId: f.orgId }, data: { status: "canceled" } });
  const retry = await invite(f.orgId, "cancelled@example.test", id);
  expect(retry.status).toBe(200);
  expect(retry.body).toMatchObject({ status: "canceled" });
  expect(await getPrisma().invitation.count({ where: { organizationId: f.orgId } })).toBe(1);
  expect(auth.sends).toBe(1);
});

async function invitationFor(orgId: string) {
  return getPrisma().invitation.findFirstOrThrow({ where: { organizationId: orgId } });
}
async function deliveryFor(orgId: string) {
  const row = await env.DB.prepare("SELECT id,state,firstSentAt FROM team_invitation_delivery WHERE orgId=? ORDER BY createdAt DESC LIMIT 1").bind(orgId).first<{ id: string; state: string; firstSentAt: number | null }>();
  if (!row) throw new Error("Fixture email attempt missing");
  return row;
}

it("freezes the email body and provider key across an uncertain retry", async () => {
  const f = await fixture(), id = crypto.randomUUID(); auth.delivery = "lost";
  await invite(f.orgId, "frozen@example.test", id);
  await getPrisma().organization.update({ where: { id: f.orgId }, data: { name: "Renamed organization" } });
  await getPrisma().user.update({ where: { id: f.userId }, data: { name: "Different display name" } });
  auth.delivery = "accept";
  const response = await invite(f.orgId, "frozen@example.test", id);
  expect(response.body).toMatchObject({ delivery: { state: "accepted" } });
  expect(auth.emails).toHaveLength(2);
  expect(auth.emails[1]).toEqual(auth.emails[0]);
  expect(auth.emails[0].idempotencyKey).toMatch(/^team-invitation\//);
});

it("admits one invitation and one active sender under concurrent exact retries", async () => {
  const f = await fixture(), id = crypto.randomUUID();
  const results = await Promise.all([invite(f.orgId, "parallel@example.test", id), invite(f.orgId, "parallel@example.test", id)]);
  expect(results.every(result => result.status === 200)).toBe(true);
  expect(auth.sends).toBe(1);
  expect(await getPrisma().invitation.count({ where: { organizationId: f.orgId } })).toBe(1);
  expect((await deliveryFor(f.orgId)).state).toBe("accepted");
});

it("does not allow two creation requests to make duplicate pending invitations", async () => {
  const f = await fixture();
  const results = await Promise.all([invite(f.orgId, "same@example.test", crypto.randomUUID()), invite(f.orgId, "same@example.test", crypto.randomUUID())]);
  expect(results.map(result => result.status).sort()).toEqual([200, 409]);
  expect(auth.sends).toBe(1);
  expect(await getPrisma().invitation.count({ where: { organizationId: f.orgId } })).toBe(1);
});

it("retains the existing atomic plan capacity boundary", async () => {
  const f = await fixture();
  for (let n = 0; n < 3; n++) await getPrisma().invitation.create({ data: { id: crypto.randomUUID(), organizationId: f.orgId, inviterId: f.userId, email: `reserved-${n}@example.test`, role: "member", status: "pending", expiresAt: new Date(Date.now() + 3600_000) } });
  const results = await Promise.all([invite(f.orgId, "slot-a@example.test", crypto.randomUUID()), invite(f.orgId, "slot-b@example.test", crypto.randomUUID())]);
  expect(results.map(result => result.status).sort()).toEqual([200, 403]);
  expect(await getPrisma().invitation.count({ where: { organizationId: f.orgId } })).toBe(4);
  expect(auth.sends).toBe(1);
});

it("rolls back the creation receipt and email attempt when invitation insertion fails", async () => {
  const f = await fixture(), id = crypto.randomUUID();
  await env.DB.prepare("CREATE TRIGGER fixture_invite_failure BEFORE INSERT ON invitation BEGIN SELECT RAISE(ABORT,'fixture unavailable'); END").run();
  try {
    expect((await invite(f.orgId, "rollback@example.test", id)).status).toBe(500);
    expect(await env.DB.prepare("SELECT * FROM team_invitation_request WHERE orgId=?").bind(f.orgId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT * FROM team_invitation_delivery WHERE orgId=?").bind(f.orgId).first()).toBeNull();
    expect(auth.sends).toBe(0);
  } finally { await env.DB.prepare("DROP TRIGGER fixture_invite_failure").run(); }
  expect((await invite(f.orgId, "rollback@example.test", id)).status).toBe(200);
  expect(auth.sends).toBe(1);
});

it("never reuses an uncertain email key beyond its safe replay window", async () => {
  const f = await fixture(), id = crypto.randomUUID(); auth.delivery = "lost";
  await invite(f.orgId, "old@example.test", id);
  const original = await deliveryFor(f.orgId), invitation = await invitationFor(f.orgId);
  await env.DB.prepare("UPDATE team_invitation_delivery SET firstSentAt=? WHERE orgId=? AND id=?").bind(Date.now() - 24 * 3600_000, f.orgId, original.id).run();
  auth.delivery = "accept";
  const retry = await invite(f.orgId, "old@example.test", id);
  expect(retry.body).toMatchObject({ delivery: { id: original.id, state: "uncertain", retryable: false } });
  expect(auth.sends).toBe(1);
  const resendId = crypto.randomUUID();
  const resent = await invite(f.orgId, "old@example.test", resendId, { resend: true, invitationId: invitation.id, previousDeliveryId: original.id });
  expect(resent.body).toMatchObject({ id: invitation.id, delivery: { state: "accepted" } });
  expect(auth.sends).toBe(2);
  expect(auth.emails[1].idempotencyKey).not.toBe(auth.emails[0].idempotencyKey);
  expect((await invite(f.orgId, "old@example.test", resendId, { resend: true, invitationId: invitation.id, previousDeliveryId: original.id })).status).toBe(200);
  expect(auth.sends).toBe(2);
  expect(await getPrisma().invitation.count({ where: { organizationId: f.orgId } })).toBe(1);
});

it("rejects changed request contents and stale explicit resend targets", async () => {
  const f = await fixture(), id = crypto.randomUUID();
  await invite(f.orgId, "stale@example.test", id);
  expect((await invite(f.orgId, "different@example.test", id)).status).toBe(409);
  const original = await deliveryFor(f.orgId), invitation = await invitationFor(f.orgId);
  expect((await invite(f.orgId, "stale@example.test", crypto.randomUUID(), { resend: true, invitationId: invitation.id, previousDeliveryId: original.id })).status).toBe(200);
  expect((await invite(f.orgId, "stale@example.test", crypto.randomUUID(), { resend: true, invitationId: invitation.id, previousDeliveryId: original.id })).status).toBe(409);
  expect(auth.sends).toBe(2);
});

it("prevents an old in-flight sender from overwriting a newer lease owner's outcome", async () => {
  const f = await fixture(), id = crypto.randomUUID();
  let failOld: (error: Error) => void = () => {};
  auth.barrier.promise = new Promise<void>((_resolve, reject) => { failOld = reject; }); auth.delivery = "hold";
  const original = invite(f.orgId, "lease@example.test", id);
  await vi.waitFor(() => expect(auth.sends).toBe(1));
  const attempt = await deliveryFor(f.orgId);
  await env.DB.prepare("UPDATE team_invitation_delivery SET leaseUntil=0 WHERE orgId=? AND id=?").bind(f.orgId, attempt.id).run();
  auth.delivery = "accept";
  expect((await invite(f.orgId, "lease@example.test", id)).body).toMatchObject({ delivery: { state: "accepted" } });
  failOld(new Error("Old provider response lost"));
  expect((await original).body).toMatchObject({ delivery: { state: "accepted" } });
  expect((await deliveryFor(f.orgId)).state).toBe("accepted");
  expect(auth.emails[1]).toEqual(auth.emails[0]);
});

it("requires current owner authority to retry an ownership invitation", async () => {
  const f = await fixture(), id = crypto.randomUUID(); auth.delivery = "lost";
  expect((await invite(f.orgId, "owner@example.test", id, { role: "owner" })).status).toBe(200);
  await getPrisma().member.updateMany({ where: { organizationId: f.orgId, userId: f.userId }, data: { role: "admin" } });
  auth.delivery = "accept";
  expect((await invite(f.orgId, "owner@example.test", id, { role: "owner" })).status).toBe(403);
  expect(auth.sends).toBe(1);
});

it("rejects foreign organizations and revoked actors before email replay", async () => {
  const f = await fixture(), foreign = crypto.randomUUID(), id = crypto.randomUUID();
  await getPrisma().organization.create({ data: { id: foreign, name: "Other org", slug: foreign, createdAt: new Date() } });
  expect((await invite(foreign, "foreign@example.test", id)).status).toBe(403);
  auth.delivery = "lost"; await invite(f.orgId, "revoked@example.test", id);
  await getPrisma().member.deleteMany({ where: { organizationId: f.orgId, userId: f.userId } });
  expect((await invite(f.orgId, "revoked@example.test", id)).status).toBe(403);
  expect(auth.sends).toBe(1);
});

it("recovers a web invitation at the plan cap and returns its delivery status in the list", async () => {
  const { inviteMember, getOrgInvitations } = await import("../session");
  const f = await fixture();
  for (let n = 0; n < 3; n++) await invite(f.orgId, `web-reserved-${n}@example.test`, crypto.randomUUID());
  const data = { orgId: f.orgId, email: "web-final@example.test", role: "member", requestId: crypto.randomUUID() };
  const first = await inviteMember({ data });
  const retry = await inviteMember({ data });
  expect(retry).toMatchObject({ id: first.id, delivery: { state: "accepted" } });
  expect(auth.sends).toBe(4);
  expect(await getOrgInvitations({ data: { orgId: f.orgId } })).toContainEqual(expect.objectContaining({ id: first.id, delivery: expect.objectContaining({ state: "accepted" }) }));
});

it("rejects web auth error payloads instead of reporting a successful invitation", async () => {
  const { inviteMember } = await import("../session");
  const f = await fixture();
  const data = { orgId: f.orgId, email: "web-conflict@example.test", role: "member", requestId: crypto.randomUUID() };
  await inviteMember({ data });
  await expect(inviteMember({ data: { ...data, requestId: crypto.randomUUID() } })).rejects.toThrow("pending invitation");
});

async function mobileInvite(orgId: string, email: string, requestId: string) {
  const { handleMobileApi } = await import("../mobile-api.server");
  const response = await handleMobileApi(new Request(`https://app.showpilot.tech/api/mobile/v1/team/invitations?orgId=${orgId}`, {
    method: "POST", headers: { Cookie: auth.cookie, "Content-Type": "application/json", "Idempotency-Key": requestId }, body: JSON.stringify({ email, role: "member" }),
  }), { DB: env.DB });
  if (!response) throw new Error("Mobile invitation endpoint missing");
  const body: unknown = await response.json();
  return { status: response.status, body };
}

it("preserves mobile invitation conflicts as failures", async () => {
  const f = await fixture();
  expect((await mobileInvite(f.orgId, "mobile-conflict@example.test", crypto.randomUUID())).status).toBe(201);
  const second = await mobileInvite(f.orgId, "mobile-conflict@example.test", crypto.randomUUID());
  expect(second.status).toBe(409);
  expect(second.body).toMatchObject({ error: expect.stringContaining("pending invitation") });
});

it("allows an exact mobile retry at capacity without another email", async () => {
  const f = await fixture();
  for (let n = 0; n < 3; n++) await invite(f.orgId, `mobile-reserved-${n}@example.test`, crypto.randomUUID());
  const id = crypto.randomUUID();
  const first = await mobileInvite(f.orgId, "mobile-final@example.test", id);
  const retry = await mobileInvite(f.orgId, "mobile-final@example.test", id);
  expect(first.status).toBe(201);
  expect(retry).toEqual(first);
  expect(auth.sends).toBe(4);
});


it("recovers the original delivery through the web retry boundary and never sends a replacement attempt", async () => {
  const { retryTeamInvitationDelivery } = await import("../session");
  const f = await fixture(); auth.delivery = "lost";
  await invite(f.orgId, "delivery-retry@example.test", crypto.randomUUID());
  const original = await deliveryFor(f.orgId), invitation = await invitationFor(f.orgId);
  const data = { orgId: f.orgId, invitationId: invitation.id, deliveryId: original.id };
  auth.delivery = "accept";
  expect(await retryTeamInvitationDelivery({ data })).toMatchObject({ delivery: { id: original.id, state: "accepted" } });
  expect(auth.sends).toBe(2);
  auth.delivery = "lost";
  await invite(f.orgId, invitation.email, crypto.randomUUID(), { resend: true, invitationId: invitation.id, previousDeliveryId: original.id });
  const replacement = await deliveryFor(f.orgId);
  expect(replacement.id).not.toBe(original.id);
  auth.delivery = "accept";
  expect(await retryTeamInvitationDelivery({ data })).toMatchObject({ delivery: { id: replacement.id, state: "uncertain" } });
  expect(auth.sends).toBe(3);
});

it("rejects a foreign or revoked delivery retry before contacting the provider", async () => {
  const { retryTeamInvitationDelivery } = await import("../session");
  const f = await fixture(); auth.delivery = "lost";
  await invite(f.orgId, "delivery-scope@example.test", crypto.randomUUID());
  const original = await deliveryFor(f.orgId), invitation = await invitationFor(f.orgId);
  const data = { orgId: f.orgId, invitationId: invitation.id, deliveryId: original.id };
  await expect(retryTeamInvitationDelivery({ data: { ...data, orgId: "different-org" } })).rejects.toThrow("access");
  await getPrisma().member.deleteMany({ where: { organizationId: f.orgId, userId: f.userId } });
  await expect(retryTeamInvitationDelivery({ data })).rejects.toThrow("access");
  expect(auth.sends).toBe(1);
});

it("does not send a canceled or expired invitation through the delivery retry endpoint", async () => {
  const { retryTeamInvitationDelivery } = await import("../session");
  const f = await fixture(); auth.delivery = "lost";
  await invite(f.orgId, "closed-retry@example.test", crypto.randomUUID());
  const original = await deliveryFor(f.orgId), invitation = await invitationFor(f.orgId);
  const data = { orgId: f.orgId, invitationId: invitation.id, deliveryId: original.id };
  await getPrisma().invitation.update({ where: { id: invitation.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
  expect(await retryTeamInvitationDelivery({ data })).toMatchObject({ delivery: { retryable: false } });
  await getPrisma().invitation.update({ where: { id: invitation.id }, data: { status: "canceled", expiresAt: new Date(Date.now() + 60_000) } });
  expect(await retryTeamInvitationDelivery({ data })).toMatchObject({ status: "canceled", delivery: { retryable: false } });
  expect(auth.sends).toBe(1);
});

it("checks current authority when creation commits, not just when the request starts", async () => {
  const { createTeamInvitation } = await import("../team-invitation.server");
  const f = await fixture();
  const session = await getAuth().api.getSession({ headers: new Headers({ Cookie: auth.cookie }), query: { disableCookieCache: true } });
  if (!session) throw new Error("Fixture session missing");
  const racing = { prepare: env.DB.prepare.bind(env.DB), batch: async <T>(statements: D1PreparedStatement[]) => {
    await getPrisma().member.updateMany({ where: { organizationId: f.orgId, userId: f.userId }, data: { role: "member" } });
    return env.DB.batch<T>(statements);
  } };
  await expect(createTeamInvitation(racing, { userId: f.userId, sessionId: session.session.id }, {
    orgId: f.orgId, email: "commit-guard@example.test", role: "member", requestId: crypto.randomUUID(),
  }, "https://app.showpilot.tech")).rejects.toThrow("changed");
  expect(await getPrisma().invitation.count({ where: { organizationId: f.orgId } })).toBe(0);
  expect(auth.sends).toBe(0);
});

it("bounds a provider that never responds and keeps the committed invitation uncertain", async () => {
  const f = await fixture(); auth.delivery = "hold"; auth.barrier.promise = new Promise(() => {});
  const response = await invite(f.orgId, "timeout@example.test", crypto.randomUUID());
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ status: "pending", delivery: { state: "uncertain", retryable: true } });
  expect(auth.sends).toBe(1);
}, 15_000);
