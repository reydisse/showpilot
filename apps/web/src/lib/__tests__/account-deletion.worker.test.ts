import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { getAuth } from "../auth";
import { getPrisma } from "../db";
import { beforeDeleteAccount } from "../account-deletion.server";

// HTTP cookies come from Better Auth itself; there is no TanStack request
// context in this worker test. Only its framework cookie bridge is omitted.
vi.mock("better-auth/tanstack-start", () => ({ tanstackStartCookies: () => ({ id: "test-cookie-bridge" }) }));
const fault = vi.hoisted(() => ({ failBatch: false }));
vi.mock("../d1", async () => {
  const { env } = await import("cloudflare:workers");
  return { getD1: () => ({
    prepare: env.DB.prepare.bind(env.DB),
    batch: async (statements: D1PreparedStatement[]) => {
      if (fault.failBatch) throw new Error("Simulated database interruption");
      return env.DB.batch(statements);
    },
  }) };
});
afterEach(() => { fault.failBatch = false; });

const password = "Disposable-test-password-92!";
const origin = "https://app.showpilot.tech";

async function fixture(verified = true) {
  const id = crypto.randomUUID();
  const other = crypto.randomUUID();
  const org = crypto.randomUUID();
  const email = `${id}@example.test`;
  const prisma = getPrisma();
  await prisma.user.create({ data: { id, name: "Disposable User", email, emailVerified: verified } });
  await prisma.user.create({ data: { id: other, name: "Remaining Owner", email: `${other}@example.test`, emailVerified: true } });
  await prisma.account.create({ data: { id: crypto.randomUUID(), issuer: "local:credential", accountId: id, providerId: "credential", userId: id, password: await hashPassword(password) } });
  await prisma.organization.create({ data: { id: org, name: "Deletion test", slug: org, createdAt: new Date() } });
  for (const [userId, role] of [[id, "member"], [other, "owner"]]) {
    await prisma.member.create({ data: { id: crypto.randomUUID(), organizationId: org, userId, role, createdAt: new Date() } });
  }
  await prisma.crewMember.create({ data: { id: `crew-${id}`, orgId: org, memberId: id, name: "Disposable User", email: email.toUpperCase(), role: "Audio" } });
  await prisma.crewMember.create({ data: { id: `crew-${other}`, orgId: org, memberId: other, name: "Remaining Owner", email: `${other}@example.test`, role: "Producer" } });
  await prisma.serviceAssignment.create({ data: { id: `assignment-${id}`, orgId: org, serviceDate: "2026-09-30", crewMemberId: `crew-${id}`, assignedByUserId: id, role: "Audio", responseNote: "Personal response" } });
  await env.DB.prepare("INSERT INTO crew_schedule_access (id, orgId, crewMemberId, tokenHash, expiresAt) VALUES (?, ?, ?, ?, '2099-01-01')").bind(id, org, `crew-${id}`, id).run();
  for (const key of [`notification-timezone:${id}`, `onboarding-role:${id}`, `onboarding-first-session:${id}`, `notification-timezone:${other}`]) {
    await prisma.appSetting.create({ data: { orgId: org, key, value: "test" } });
  }
  await env.STORAGE.put(`avatars/${id}.jpg`, "avatar");
  await env.STORAGE.put(`orgs/${org}/chat/draft/file.txt`, "unsent personal upload", { customMetadata: { uploadedBy: id } });
  await env.STORAGE.put(`orgs/${org}/chat/other/file.txt`, "keep", { customMetadata: { uploadedBy: other } });
  return { id, other, org, email, prisma };
}

async function signIn(email: string) {
  const response = await getAuth().handler(new Request(`${origin}/api/auth/sign-in/email`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ email, password }),
  }));
  expect(response.status).toBe(200);
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}

async function remove(cookie: string, suppliedPassword = password) {
  return getAuth().handler(new Request(`${origin}/api/auth/delete-user`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie }, body: JSON.stringify({ password: suppliedPassword }),
  }));
}

describe("account deletion through the real auth endpoint", () => {
  it("removes account-linked data and uploads after password confirmation while preserving another member's data", async () => {
    const f = await fixture();
    const cookie = await signIn(f.email);
    expect(await f.prisma.user.findUnique({ where: { id: f.id } })).not.toBeNull();
    const response = await remove(cookie);
    expect(await response.json()).toMatchObject({ success: true, message: "User deleted" });
    expect(response.status).toBe(200);
    expect(await f.prisma.user.findUnique({ where: { id: f.id } })).toBeNull();
    expect(await f.prisma.account.count({ where: { userId: f.id } })).toBe(0);
    expect(await f.prisma.session.count({ where: { userId: f.id } })).toBe(0);
    expect(await f.prisma.member.count({ where: { userId: f.id } })).toBe(0);
    expect(await f.prisma.crewMember.findUnique({ where: { id: `crew-${f.id}` } })).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM crew_schedule_access WHERE id = ?").bind(f.id).first()).toBeNull();
    expect(await f.prisma.serviceAssignment.findUnique({ where: { id: `assignment-${f.id}` } })).toMatchObject({ crewMemberId: null, assignedByUserId: null, responseNote: "" });
    expect(await f.prisma.appSetting.count({ where: { orgId: f.org } })).toBe(1);
    expect(await env.STORAGE.head(`avatars/${f.id}.jpg`)).toBeNull();
    expect(await env.STORAGE.head(`orgs/${f.org}/chat/draft/file.txt`)).toBeNull();
    expect(await env.STORAGE.head(`orgs/${f.org}/chat/other/file.txt`)).not.toBeNull();
    expect(await f.prisma.crewMember.findUnique({ where: { id: `crew-${f.other}` } })).not.toBeNull();
    expect(await f.prisma.organization.findUnique({ where: { id: f.org } })).not.toBeNull();
    const stale = await getAuth().handler(new Request(`${origin}/api/auth/get-session`, { headers: { Cookie: cookie } }));
    expect(await stale.json()).toBeNull();
  }, 20_000);

  it("allows password-confirmed retry after cleanup fails without consuming an email token", async () => {
    const f = await fixture();
    const cookie = await signIn(f.email);
    fault.failBatch = true;
    await expect(beforeDeleteAccount({ id: f.id, email: f.email, emailVerified: true })).rejects.toThrow("Simulated database interruption");
    expect(await f.prisma.user.findUnique({ where: { id: f.id } })).not.toBeNull();
    fault.failBatch = false;
    expect((await remove(cookie)).status).toBe(200);
    expect(await f.prisma.user.findUnique({ where: { id: f.id } })).toBeNull();
  }, 20_000);

  it("blocks a sole owner before deleting any personal data", async () => {
    const f = await fixture();
    await f.prisma.member.updateMany({ where: { userId: f.id }, data: { role: "owner" } });
    await f.prisma.member.updateMany({ where: { userId: f.other }, data: { role: "member" } });
    await expect(beforeDeleteAccount({ id: f.id, email: f.email, emailVerified: true })).rejects.toThrow("Transfer ownership");
    expect(await env.STORAGE.head(`avatars/${f.id}.jpg`)).not.toBeNull();
    expect(await f.prisma.crewMember.findUnique({ where: { id: `crew-${f.id}` } })).not.toBeNull();
  }, 20_000);

  it("removes unsent uploads from a previously visited workspace after membership ends", async () => {
    const f = await fixture();
    await env.DB.prepare("INSERT INTO chat_user_room (userId, orgId, roomId, updatedAt) VALUES (?, ?, 'production', CURRENT_TIMESTAMP)").bind(f.id, f.org).run();
    await f.prisma.member.deleteMany({ where: { userId: f.id } });
    const cookie = await signIn(f.email);
    expect((await remove(cookie)).status).toBe(200);
    expect(await env.STORAGE.head(`orgs/${f.org}/chat/draft/file.txt`)).toBeNull();
    expect(await env.STORAGE.head(`orgs/${f.org}/chat/other/file.txt`)).not.toBeNull();
    expect(await env.DB.prepare("SELECT userId FROM chat_user_room WHERE userId = ?").bind(f.id).first()).toBeNull();
  }, 20_000);

  it("does not treat an unverified email as authority to delete a crew contact", async () => {
    const f = await fixture(false);
    await beforeDeleteAccount({ id: f.id, email: f.email, emailVerified: false });
    expect(await f.prisma.crewMember.findUnique({ where: { id: `crew-${f.id}` } })).not.toBeNull();
  }, 20_000);
});
