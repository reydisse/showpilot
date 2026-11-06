import { hashPassword } from "better-auth/crypto";
import { afterEach, expect, it, vi } from "vitest";
import { getAuth } from "../auth";
import { getPrisma } from "../db";
import { getOnboardingProgress, markOnboardingStarted } from "../onboarding";

// Keep real auth, cookie validation, database permissions and progress queries.
// Only the TanStack request adapter is supplied by the test host.
const request = vi.hoisted(() => ({ cookie: "" }));
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
const post = (path: string, body: unknown) => getAuth().handler(new Request(`${origin}/api/auth/${path}`, {
  method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Cookie: request.cookie }, body: JSON.stringify(body),
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

// The unverified-user 403 is exercised through the built Worker's HTTP entry
// in smoke-organization-creation.mjs, including its real request context.
it("keeps new setup unauthenticated until sign-in", async () => {
  expect(await getOnboardingProgress({ data: { mode: "new" } })).toMatchObject({ authenticated: false, org: null });
});
