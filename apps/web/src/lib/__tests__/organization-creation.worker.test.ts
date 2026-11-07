import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { hashPassword } from "better-auth/crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createOrganizationAtomically } from "../organization-creation.server";
import { getPrisma } from "../db";
import { getOnboardingProgress, markOnboardingStarted } from "../onboarding";

// Keep real auth, cookie validation, database permissions and progress queries.
// Auth calls use the actual Worker HTTP entry; progress assertions supply only
// the TanStack server-function request adapter.
const request = vi.hoisted(() => ({ cookie: "", ip: 0 }));
vi.mock("better-auth/tanstack-start", () => ({ tanstackStartCookies: () => ({ id: "test-cookie-bridge" }) }));
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => new Headers({ Cookie: request.cookie }) }));
vi.mock("@tanstack/react-start", () => {
  const builder = () => {
    let validate = (data: unknown) => data;
    const chain = {
      middleware: () => chain,
      inputValidator: (validator: typeof validate) => { validate = validator; return chain; },
      handler: (handler: (input: unknown) => unknown) => async (input: { data?: unknown } = {}) => handler({ data: validate(input.data) }),
      server: () => chain,
    };
    return chain;
  };
  return { createServerFn: builder, createMiddleware: builder, createServerOnlyFn: <T>(fn: T): T => fn };
});
afterEach(() => { request.cookie = ""; });

const origin = "https://app.showpilot.tech";
const password = "Disposable-org-fixture-password-92!";
const post = (path: string, body: unknown) => SELF.fetch(new Request(`${origin}/api/auth/${path}`, {
  method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Cookie: request.cookie, "cf-connecting-ip": `192.0.2.${++request.ip}` }, body: JSON.stringify(body),
}));
async function memberFixture() {
  const prisma = getPrisma();
  const id = crypto.randomUUID();
  const orgId = crypto.randomUUID();
  const email = `${id}@example.test`;
  await prisma.user.create({ data: { id, name: "Existing member", email, emailVerified: true } });
  await prisma.account.create({ data: { id: crypto.randomUUID(), issuer: "local:credential", accountId: id, providerId: "credential", userId: id, password: await hashPassword(password) } });
  await prisma.organization.create({ data: { id: orgId, name: "Original team", slug: orgId, createdAt: new Date() } });
  await prisma.member.create({ data: { id: crypto.randomUUID(), organizationId: orgId, userId: id, role: "member", createdAt: new Date() } });
  const login = await post("sign-in/email", { email, password });
  expect(login.status).toBe(200);
  request.cookie = login.headers.getSetCookie().map(cookie => cookie.split(";")[0]).join("; ");
  return { prisma, id, orgId, email };
}

it("lets an existing Member create a separate owned organization and resume its own progress", async () => {
  const f = await memberFixture();
  expect(await getOnboardingProgress({ data: { mode: "new" } })).toMatchObject({ authenticated: true, hasOrg: false, org: null });
  expect(await getOnboardingProgress({ data: { mode: "resume" } })).toMatchObject({ org: { id: f.orgId }, isOwner: false });
  const response = await post("organization/create", { name: "Separate team", slug: crypto.randomUUID() });
  expect(response.status).toBe(200);
  const created = await response.json<{ id: string }>();
  await markOnboardingStarted({ data: { orgId: created.id } });
  expect(await getOnboardingProgress({ data: { mode: "resume", orgId: created.id } })).toMatchObject({ org: { id: created.id }, started: true, isOwner: true, completed: false });
  expect(await f.prisma.member.findFirst({ where: { userId: f.id, organizationId: f.orgId } })).toMatchObject({ role: "member" });
  expect(await f.prisma.appSetting.count({ where: { orgId: f.orgId } })).toBe(0);
  expect(await f.prisma.organization.findUnique({ where: { id: created.id } })).toMatchObject({ trialEndsAt: expect.any(Date) });
}, 20_000);

it("rejects progress reads for an unrelated org, invalid IDs, and member-only checkpoint writes", async () => {
  const f = await memberFixture();
  const otherId = crypto.randomUUID();
  await f.prisma.organization.create({ data: { id: otherId, name: "Unrelated", slug: otherId, createdAt: new Date() } });
  await expect(getOnboardingProgress({ data: { mode: "resume", orgId: otherId } })).rejects.toThrow("do not have access");
  await expect(getOnboardingProgress({ data: { mode: "resume", orgId: "x".repeat(65) } })).rejects.toThrow();
  await expect(markOnboardingStarted({ data: { orgId: f.orgId } })).rejects.toThrow("Forbidden");
}, 20_000);

it("keeps new setup unauthenticated until sign-in", async () => {
  expect(await getOnboardingProgress({ data: { mode: "new" } })).toMatchObject({ authenticated: false, org: null });
});


it("does not leave an ownerless organization when creating its membership fails", async () => {
  const f = await memberFixture();
  const slug = crypto.randomUUID();
  await env.DB.prepare(`CREATE TRIGGER reject_created_owner BEFORE INSERT ON member
    WHEN NEW.userId = '${f.id}' AND NEW.organizationId != '${f.orgId}'
    BEGIN SELECT RAISE(ABORT, 'forced owner insertion failure'); END`).run();
  try {
    const response = await post("organization/create", { name: "Atomic creation fixture", slug, keepCurrentActiveOrganization: true });
    expect(response.status).toBe(500); await response.arrayBuffer();
  } finally {
    await env.DB.prepare("DROP TRIGGER reject_created_owner").run();
  }
  expect(await f.prisma.organization.findUnique({ where: { slug } })).toBeNull();
  expect(await f.prisma.member.findFirst({ where: { userId: f.id, organizationId: f.orgId } })).toMatchObject({ role: "member" });
  const retry = await post("organization/create", { name: "Atomic creation fixture", slug, keepCurrentActiveOrganization: true });
  expect(retry.status).toBe(200); const created = await retry.json<{ id: string }>();
  expect(await f.prisma.member.count({ where: { organizationId: created.id, userId: f.id, role: "owner" } })).toBe(1);
});


it.each(["integer", "iso"])("rejects a session that expired after authorization (%s storage)", async storage => {
  const f = await memberFixture();
  const session = await f.prisma.session.findFirstOrThrow({ where: { userId: f.id } });
  const expiresAt = storage === "integer" ? Date.now() - 1000 : new Date(Date.now() - 1000).toISOString();
  await env.DB.prepare("UPDATE session SET expiresAt = ? WHERE id = ?").bind(expiresAt, session.id).run();
  const slug = crypto.randomUUID();
  expect(await createOrganizationAtomically(env.DB, { userId: f.id, sessionId: session.id }, { name: "Expired session", slug })).toBeNull();
  expect(await f.prisma.organization.findUnique({ where: { slug } })).toBeNull();
});

it("commits a fourteen-day trial and owner while preserving the requested active workspace", async () => {
  const f = await memberFixture();
  const active = await post("organization/set-active", { organizationId: f.orgId });
  expect(active.status).toBe(200); await active.arrayBuffer();
  const slug = crypto.randomUUID();
  const metadata = { fixture: "kept", nested: { number: 1 } };
  const response = await post("organization/create", { name: "  Separate production  ", slug, metadata, logo: "https://example.test/logo.png", userId: "not-the-caller", keepCurrentActiveOrganization: true });
  expect(response.status).toBe(200);
  const created = await response.json<{ id: string; metadata: unknown; members: { userId: string; role: string }[] }>();
  expect(created.metadata).toEqual(metadata); expect(created.members).toMatchObject([{ userId: f.id, role: "owner" }]);
  const saved = await f.prisma.organization.findUniqueOrThrow({ where: { id: created.id } });
  expect(saved.name).toBe("Separate production"); expect(saved.cloud_enabled).toBe(true); expect(saved.plan).toBe("free");
  expect(saved.trialEndsAt!.getTime() - saved.createdAt.getTime()).toBe(14 * 24 * 60 * 60 * 1000);
  expect(saved.logo).toBe("https://example.test/logo.png"); expect(JSON.parse(saved.metadata!)).toEqual(metadata);
  expect(await f.prisma.session.findFirst({ where: { userId: f.id } })).toMatchObject({ activeOrganizationId: f.orgId });
  expect(await f.prisma.appSetting.count({ where: { orgId: created.id } })).toBe(0);
});

it("retains the existing API's default active-workspace behavior", async () => {
  const f = await memberFixture();
  const response = await post("organization/create", { name: "Native client", slug: crypto.randomUUID() });
  expect(response.status).toBe(200); const created = await response.json<{ id: string }>();
  expect(await f.prisma.session.findFirst({ where: { userId: f.id } })).toMatchObject({ activeOrganizationId: created.id });
  const session = await SELF.fetch(new Request(`${origin}/api/auth/get-session`, { headers: { Cookie: request.cookie } }));
  expect(session.status).toBe(200);
  expect(await session.json()).toMatchObject({ session: { activeOrganizationId: created.id }, user: { id: f.id } });
});

it("rolls back the organization and owner when the final session update fails", async () => {
  const f = await memberFixture(); const slug = crypto.randomUUID();
  await env.DB.prepare(`CREATE TRIGGER reject_created_session BEFORE UPDATE ON session
    WHEN NEW.userId = '${f.id}' AND NEW.activeOrganizationId IS NOT OLD.activeOrganizationId
    BEGIN SELECT RAISE(ABORT, 'forced session update failure'); END`).run();
  try {
    const response = await post("organization/create", { name: "Session rollback", slug });
    expect(response.status).toBe(500); expect(await response.json()).toMatchObject({ code: "ORGANIZATION_CREATION_UNCONFIRMED" });
  } finally { await env.DB.prepare("DROP TRIGGER reject_created_session").run(); }
  expect(await f.prisma.organization.findUnique({ where: { slug } })).toBeNull();
  expect(await f.prisma.member.count({ where: { userId: f.id } })).toBe(1);
});

it("lets only one concurrent request own an address and never adds a second owner", async () => {
  const f = await memberFixture(); const slug = crypto.randomUUID();
  const responses = await Promise.all(["First", "Second"].map(name => post("organization/create", { name, slug, keepCurrentActiveOrganization: true })));
  expect(responses.map(response => response.status).sort()).toEqual([200, 400]);
  const bodies = await Promise.all(responses.map(response => response.json()));
  expect(bodies).toContainEqual({ code: "ORGANIZATION_ALREADY_EXISTS", message: "This workspace address is already in use." });
  const saved = await f.prisma.organization.findUniqueOrThrow({ where: { slug } });
  expect(await f.prisma.member.findMany({ where: { organizationId: saved.id } })).toMatchObject([{ userId: f.id, role: "owner" }]);
  expect(await f.prisma.member.count({ where: { organizationId: saved.id } })).toBe(1);
  expect(saved.trialEndsAt).not.toBeNull();
});

it("rejects anonymous and freshly unverified accounts without creating anything", async () => {
  const slug = crypto.randomUUID();
  const anonymous = await post("organization/create", { name: "Anonymous", slug });
  expect(anonymous.status).toBe(401); await anonymous.arrayBuffer();
  const f = await memberFixture(); await f.prisma.user.update({ where: { id: f.id }, data: { emailVerified: false } });
  const unverified = await post("organization/create", { name: "Unverified", slug });
  expect(unverified.status).toBe(403); expect(await unverified.json()).toMatchObject({ code: "YOU_ARE_NOT_ALLOWED_TO_CREATE_A_NEW_ORGANIZATION" });
  expect(await f.prisma.organization.findUnique({ where: { slug } })).toBeNull();
});

it.each(["revoked", "unverified", "wrong-user"])("rejects account changes at the write boundary: %s", async change => {
  const f = await memberFixture(); const session = await f.prisma.session.findFirstOrThrow({ where: { userId: f.id } });
  if (change === "revoked") await f.prisma.session.delete({ where: { id: session.id } });
  if (change === "unverified") await f.prisma.user.update({ where: { id: f.id }, data: { emailVerified: false } });
  const slug = crypto.randomUUID();
  expect(await createOrganizationAtomically(env.DB, { userId: change === "wrong-user" ? "another-user" : f.id, sessionId: session.id }, { name: "Changed account", slug })).toBeNull();
  expect(await f.prisma.organization.findUnique({ where: { slug } })).toBeNull();
});

it("rejects whitespace names and malformed workspace addresses", async () => {
  const f = await memberFixture();
  for (const body of [{ name: "   ", slug: crypto.randomUUID() }, { name: "Invalid address", slug: "../another-workspace" }]) {
    const response = await post("organization/create", body);
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: "INVALID_ORGANIZATION" });
  }
  expect(await f.prisma.member.count({ where: { userId: f.id } })).toBe(1);
});

it("keeps the previous first workspace when the active session has no selection", async () => {
  const f = await memberFixture();
  expect(await f.prisma.session.findFirst({ where: { userId: f.id } })).toMatchObject({ activeOrganizationId: null });
  const response = await post("organization/create", { name: "Later workspace", slug: crypto.randomUUID(), keepCurrentActiveOrganization: true });
  expect(response.status).toBe(200); await response.arrayBuffer();
  expect(await getOnboardingProgress({ data: { mode: "resume" } })).toMatchObject({ org: { id: f.orgId }, isOwner: false });
  const memberships = await f.prisma.member.findMany({ where: { userId: f.id }, orderBy: { createdAt: "asc" } });
  expect(memberships[0].organizationId).toBe(f.orgId);
});
