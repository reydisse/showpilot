import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { SELF } from "cloudflare:test";
import { hashPassword } from "better-auth/crypto";
import { getPrisma } from "../db";
import { issueChatPass } from "../chat-pass-issuance.server";
import { handleMobileApi } from "../mobile-api.server";
import { createCrewChatPass, createPlanningChatPass, validateCrewChatPass, revokeChatPass } from "../crew-chat-pass";
const request = vi.hoisted(() => ({ cookie: "" }));
vi.mock("better-auth/tanstack-start", () => ({ tanstackStartCookies: () => ({ id: "test-cookie-bridge" }) }));
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => new Headers({ Cookie: request.cookie }) }));
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
  const response = await SELF.fetch(new Request("https://app.showpilot.tech/api/auth/sign-in/email", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://app.showpilot.tech", "cf-connecting-ip": `192.0.2.${Math.floor(Math.random()*200)+1}` }, body: JSON.stringify({ email, password }) }));
  expect(response.status).toBe(200); await response.arrayBuffer();
  request.cookie = response.headers.getSetCookie().map(cookie => cookie.split(";")[0]).join("; ");
  return { prisma, id, orgId };
}

it("creates a different pass when a leader explicitly creates again after revocation", async () => {
  const f = await fixture();
  await f.prisma.member.updateMany({ where: { organizationId: f.orgId, userId: f.id }, data: { role: "owner" } });
  const now = Date.now(); const clock = vi.spyOn(Date,"now").mockReturnValue(now);
  try {
    const first = await createCrewChatPass({ data: { orgId: f.orgId, hours: 8 } });
    await revokeChatPass({ data: { orgId: f.orgId, token: first.token } });
    const second = await createCrewChatPass({ data: { orgId: f.orgId, hours: 8 } });
    expect(second.token).not.toBe(first.token);
    expect(await validateCrewChatPass({ data: second.token })).toMatchObject({ status: "valid" });
  } finally { clock.mockRestore(); }
});

it("concurrent retries return one grant and preserve its original expiry", async () => {
  const f = await fixture();
  const data = { orgId: f.orgId, hours: 2, requestId: crypto.randomUUID() };
  const [first, duplicate] = await Promise.all([createCrewChatPass({ data }), createCrewChatPass({ data })]);
  expect(duplicate).toEqual(first);
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
  try { expect(await createCrewChatPass({ data })).toEqual(first); }
  finally { clock.mockRestore(); }
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM chat_pass_creation_receipt WHERE orgId=?").bind(f.orgId).first()).toEqual({ count: 1 });
  await expect(createCrewChatPass({ data: { ...data, hours: 8 } })).rejects.toThrow("choices differ");
  await revokeChatPass({ data: { orgId: f.orgId, token: first.token } });
  await expect(createCrewChatPass({ data })).rejects.toThrow("revoked");
});

it("recovers an actual committed grant after the receipt read fails", async () => {
  const f = await fixture(); let receiptReads = 0;
  const db = { prepare(sql: string) {
    const statement = env.DB.prepare(sql);
    return { bind(...values: unknown[]) {
      const bound = statement.bind(...values);
      return { all: <T>() => bound.all<T>(), run: () => bound.run(), first: async <T>() => {
        if (sql.startsWith("SELECT fingerprint,payload") && ++receiptReads === 2) throw new Error("Lost reply after commit");
        return bound.first<T>();
      } };
    } };
  } };
  const command = { scope: "crew-chat", orgId: f.orgId, hours: 2, requestId: crypto.randomUUID() } satisfies Parameters<typeof issueChatPass>[3];
  const actor = { userId: f.id, name: "Fixture" };
  await expect(issueChatPass(db, env.KIOSK_SECRET, actor, command)).rejects.toThrow("Lost reply");
  const recovered = await issueChatPass(env.DB, env.KIOSK_SECRET, actor, command);
  expect(await validateCrewChatPass({ data: recovered.token })).toMatchObject({ status: "valid" });
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM chat_pass_creation_receipt WHERE orgId=?").bind(f.orgId).first()).toEqual({ count: 1 });
});

it("cannot recover expired grants, removed authority or a revoked session", async () => {
  const f = await fixture();
  const data = { orgId: f.orgId, hours: 1, requestId: crypto.randomUUID() };
  const pass = await createCrewChatPass({ data });
  const clock = vi.spyOn(Date, "now").mockReturnValue(pass.expiresAt + 1);
  try { await expect(createCrewChatPass({ data })).rejects.toThrow("expired"); }
  finally { clock.mockRestore(); }
  await f.prisma.member.updateMany({ where: { organizationId: f.orgId, userId: f.id }, data: { role: "member" } });
  await expect(createCrewChatPass({ data })).rejects.toThrow("Only production leaders");
  await f.prisma.session.deleteMany({ where: { userId: f.id } });
  await expect(createCrewChatPass({ data })).rejects.toThrow("Sign in");
});

async function recipient(f: Awaited<ReturnType<typeof fixture>>) {
  const id = crypto.randomUUID();
  await f.prisma.user.create({ data: { id, name: "Selected member", email: `${id}@example.test`, emailVerified: true } });
  await f.prisma.member.create({ data: { id: crypto.randomUUID(), organizationId: f.orgId, userId: id, role: "member", createdAt: new Date() } });
  return id;
}

it("recovers partial Planning notifications without replacing the link or resetting read notifications", async () => {
  const f = await fixture(); const first = await recipient(f); const second = await recipient(f);
  const data = { orgId: f.orgId, hours: 8, targetUserIds: [first, second], requestId: crypto.randomUUID() };
  // Fixture UUID only. Trigger injects a real write failure for one recipient.
  await env.DB.exec(`CREATE TRIGGER fail_chat_notification BEFORE INSERT ON notification WHEN NEW.userId='${second}' BEGIN SELECT RAISE(ABORT, 'fixture notification failure'); END;`);
  let pass: Awaited<ReturnType<typeof createPlanningChatPass>>;
  try {
    pass = await createPlanningChatPass({ data });
    expect(pass.notifications).toEqual({ status: "pending", missing: 1 });
  } finally { await env.DB.exec("DROP TRIGGER fail_chat_notification"); }
  await env.DB.prepare("UPDATE notification SET dismissed=1,readAt='2026-01-01T00:00:00Z' WHERE orgId=? AND userId=?").bind(f.orgId, first).run();
  const before = await env.DB.prepare("SELECT * FROM notification WHERE orgId=? AND userId=?").bind(f.orgId, first).first();
  const recovered = await createPlanningChatPass({ data: { ...data, targetUserIds: [second, first, first] } });
  expect(recovered.token).toBe(pass.token);
  expect(recovered.notifications).toEqual({ status: "saved", recipients: 2 });
  await createPlanningChatPass({ data });
  expect(await env.DB.prepare("SELECT * FROM notification WHERE orgId=? AND userId=?").bind(f.orgId, first).first()).toEqual(before);
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM notification WHERE orgId=?").bind(f.orgId).first()).toEqual({ count: 2 });
  await f.prisma.member.deleteMany({ where: { organizationId: f.orgId, userId: second } });
  await expect(createPlanningChatPass({ data })).rejects.toThrow("Every selected person");
});

it("shares recovery across web and mobile and rejects an entire invalid recipient selection", async () => {
  const f = await fixture();
  const data = { orgId: f.orgId, hours: 8, requestId: crypto.randomUUID() };
  const pass = await createCrewChatPass({ data });
  const mobile = (kind: string, body: unknown) => handleMobileApi(new Request(`https://app.showpilot.tech/api/mobile/v1/chat/passes/${kind}?orgId=${f.orgId}`, {
    method: "POST", headers: { Cookie: request.cookie, "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), { DB: env.DB, KIOSK_SECRET: env.KIOSK_SECRET });
  const response = await mobile("crew", data);
  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({ token: pass.token, expiresAt: pass.expiresAt });
  const invalid = await mobile("planning", { ...data, requestId: crypto.randomUUID(), targetUserIds: [f.id, ""] });
  expect(invalid?.status).toBe(400);
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM chat_pass_creation_receipt WHERE orgId=?").bind(f.orgId).first()).toEqual({ count: 1 });
});

it("isolates a request identity by actor and workspace without granting foreign access", async () => {
  const f = await fixture(); const other = await recipient(f);
  await f.prisma.member.updateMany({ where: { organizationId: f.orgId, userId: other }, data: { role: "owner" } });
  const orgId = crypto.randomUUID();
  await f.prisma.organization.create({ data: { id: orgId, name: "Other fixture", slug: orgId, createdAt: new Date() } });
  await f.prisma.member.create({ data: { id: crypto.randomUUID(), organizationId: orgId, userId: f.id, role: "owner", createdAt: new Date() } });
  const command = { orgId: f.orgId, scope: "crew-chat", hours: 2, requestId: crypto.randomUUID() } satisfies Parameters<typeof issueChatPass>[3];
  const actor = { userId: f.id, name: "Fixture" }; const secondActor = { userId: other, name: "Second fixture" };
  const first = await issueChatPass(env.DB, env.KIOSK_SECRET, actor, command);
  const second = await issueChatPass(env.DB, env.KIOSK_SECRET, secondActor, command);
  const third = await issueChatPass(env.DB, env.KIOSK_SECRET, actor, { ...command, orgId });
  expect(new Set([first.token, second.token, third.token]).size).toBe(3);
  expect(await validateCrewChatPass({ data: third.token })).toMatchObject({ status: "valid", pass: { orgId } });
  await expect(issueChatPass(env.DB, env.KIOSK_SECRET, secondActor, { ...command, orgId })).rejects.toThrow("Only production leaders");
  await expect(createPlanningChatPass({ data: { ...command, targetUserIds: [crypto.randomUUID()] } })).rejects.toThrow("Every selected person");
});
