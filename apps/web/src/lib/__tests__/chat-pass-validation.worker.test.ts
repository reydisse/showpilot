import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { SELF } from "cloudflare:test";
import { hashPassword } from "better-auth/crypto";
import { getPrisma } from "../db";
import { signToken } from "../kiosk-token";
import { chatPassDigest } from "../chat-pass-revocation.server";
import { validateCrewChatPass, validatePlanningChatPass, revokeChatPass } from "../crew-chat-pass";
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
it("distinguishes malformed crew links from signed expired crew links", async () => {
  expect(await validateCrewChatPass({ data: "chat_not-a-valid-jwt-but-long-enough" })).toEqual({ status: "invalid" });
  const token = `chat_${await signToken({ scope: "crew-chat", orgId: "fixture", orgSlug: "fixture", exp: Math.floor(Date.now()/1000)-1 }, env.KIOSK_SECRET)}`;
  expect(await validateCrewChatPass({ data: token })).toEqual({ status: "expired" });
});
it("distinguishes malformed Planning links from signed expired Planning links", async () => {
  expect(await validatePlanningChatPass({ data: "planning_chat_not-a-valid-jwt" })).toEqual({ status: "invalid" });
  const token = `planning_chat_${await signToken({ scope: "planning-chat", roomId: "planning", orgId: "fixture", orgSlug: "fixture", targetUserIds: ["member"], exp: Math.floor(Date.now()/1000)-1 }, env.KIOSK_SECRET)}`;
  expect(await validatePlanningChatPass({ data: token })).toEqual({ status: "expired" });
});

async function fixture() {
  const prisma = getPrisma(); const id = crypto.randomUUID(); const orgId = crypto.randomUUID();
  const email = `${id}@example.test`; const password = "Chat-invite-fixture-password-92!";
  await prisma.user.create({ data: { id, name: "Invited fixture", email, emailVerified: true } });
  await prisma.account.create({ data: { id: crypto.randomUUID(), issuer: "local:credential", accountId: id, providerId: "credential", userId: id, password: await hashPassword(password) } });
  await prisma.organization.create({ data: { id: orgId, name: "Planning fixture", slug: orgId, createdAt: new Date() } });
  await prisma.member.create({ data: { id: crypto.randomUUID(), organizationId: orgId, userId: id, role: "member", createdAt: new Date() } });
  const response = await SELF.fetch(new Request("https://app.showpilot.tech/api/auth/sign-in/email", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://app.showpilot.tech", "cf-connecting-ip": `192.0.2.${Math.floor(Math.random()*200)+1}` }, body: JSON.stringify({ email, password }) }));
  expect(response.status).toBe(200); await response.arrayBuffer();
  request.cookie = response.headers.getSetCookie().map(cookie => cookie.split(";")[0]).join("; ");
  const token = `planning_chat_${await signToken({ scope: "planning-chat", roomId: "planning", orgId, orgSlug: orgId, targetUserIds: [id], exp: Math.floor(Date.now()/1000)+3600 }, env.KIOSK_SECRET)}`;
  return { prisma, id, orgId, token };
}
it("authorizes only the intended current member and uses a renamed workspace's current address", async () => {
  const f = await fixture();
  await f.prisma.organization.update({ where: { id: f.orgId }, data: { slug: "renamed-planning-fixture" } });
  expect(await validatePlanningChatPass({ data: f.token })).toEqual({ status: "authorized", orgSlug: "renamed-planning-fixture" });
  await f.prisma.member.deleteMany({ where: { organizationId: f.orgId, userId: f.id } });
  expect(await validatePlanningChatPass({ data: f.token })).toEqual({ status: "access-removed" });
});
it("distinguishes the wrong signed-in account from a missing or revoked session", async () => {
  const f = await fixture(); const originalCookie = request.cookie;
  await fixture();
  expect(await validatePlanningChatPass({ data: f.token })).toEqual({ status: "wrong-account" });
  request.cookie = "";
  expect(await validatePlanningChatPass({ data: f.token })).toEqual({ status: "signed-out" });
  request.cookie = originalCookie;
  await f.prisma.session.deleteMany({ where: { userId: f.id } });
  expect(await validatePlanningChatPass({ data: f.token })).toEqual({ status: "signed-out" });
});
it("does not send a removed workspace's token to another workspace that reused its slug", async () => {
  const f = await fixture(); await f.prisma.organization.delete({ where: { id: f.orgId } });
  await f.prisma.organization.create({ data: { id: crypto.randomUUID(), name: "Replacement", slug: f.orgId, createdAt: new Date() } });
  expect(await validatePlanningChatPass({ data: f.token })).toEqual({ status: "unavailable" });
  const crew = `chat_${await signToken({ scope: "crew-chat", orgId: f.orgId, orgSlug: f.orgId, exp: Math.floor(Date.now()/1000)+3600 }, env.KIOSK_SECRET)}`;
  expect(await validateCrewChatPass({ data: crew })).toEqual({ status: "unavailable" });
});
it("returns only the valid crew grant and never creates membership during validation", async () => {
  const f = await fixture(); request.cookie = "";
  const token = `chat_${await signToken({ scope: "crew-chat", orgId: f.orgId, orgSlug: f.orgId, exp: Math.floor(Date.now()/1000)+3600 }, env.KIOSK_SECRET)}`;
  expect(await validateCrewChatPass({ data: token })).toMatchObject({ status: "valid", pass: { orgId: f.orgId, orgSlug: f.orgId } });
  expect(await f.prisma.member.count({ where: { organizationId: f.orgId } })).toBe(1);
});

it("distinguishes a revoked signed invite from expiry without affecting another link", async () => {
  const f = await fixture();
  const tokenHash = await chatPassDigest(f.token);
  await env.DB.prepare("INSERT INTO chat_pass_revocation (orgId,tokenHash,scope,expiresAt,revokedAt,revokedBy) VALUES (?,?,'planning-chat',?,?,?)")
    .bind(f.orgId, tokenHash, Date.now()+3600000, Date.now(), f.id).run();
  expect(await validatePlanningChatPass({ data: f.token })).toEqual({ status: "revoked" });
  const crew = `chat_${await signToken({ scope: "crew-chat", orgId: f.orgId, orgSlug: f.orgId, exp: Math.floor(Date.now()/1000)+3600 }, env.KIOSK_SECRET)}`;
  expect(await validateCrewChatPass({ data: crew })).toMatchObject({ status: "valid" });
  await env.DB.prepare("INSERT INTO chat_pass_revocation (orgId,tokenHash,scope,expiresAt,revokedAt) VALUES (?,?,'crew-chat',?,?)")
    .bind(f.orgId, await chatPassDigest(crew), Date.now()+3600000, Date.now()).run();
  expect(await validateCrewChatPass({ data: crew })).toEqual({ status: "revoked" });
});

it("allows only a current leader to disable a link from that workspace, with repeatable receipts", async () => {
  const f = await fixture();
  await expect(revokeChatPass({ data: { orgId: f.orgId, token: f.token } })).rejects.toThrow("Only production leaders");
  await f.prisma.member.updateMany({ where: { organizationId: f.orgId, userId: f.id }, data: { role: "owner" } });
  await expect(revokeChatPass({ data: { orgId: f.orgId, token: f.token } })).resolves.toEqual({ status: "revoked", disconnected: true });
  const row = await env.DB.prepare("SELECT * FROM chat_pass_revocation WHERE orgId=?").bind(f.orgId).first();
  await expect(revokeChatPass({ data: { orgId: f.orgId, token: f.token } })).resolves.toEqual({ status: "revoked", disconnected: true });
  expect(await env.DB.prepare("SELECT * FROM chat_pass_revocation WHERE orgId=?").bind(f.orgId).first()).toEqual(row);
  expect(JSON.stringify(row)).not.toContain(f.token);
  expect(await validatePlanningChatPass({ data: f.token })).toEqual({ status: "revoked" });
  const other = await fixture();
  await other.prisma.member.updateMany({ where: { organizationId: other.orgId, userId: other.id }, data: { role: "owner" } });
  await expect(revokeChatPass({ data: { orgId: other.orgId, token: f.token } })).rejects.toThrow("different workspace");
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM chat_pass_revocation WHERE orgId=?").bind(other.orgId).first("n")).toBe(0);
  await other.prisma.session.deleteMany({ where: { userId: other.id } });
  await expect(revokeChatPass({ data: { orgId: other.orgId, token: other.token } })).rejects.toThrow("Sign in");
});
it("cannot bypass revocation with an equivalent base64 spelling of the signature", async () => {
  const f = await fixture();
  await f.prisma.member.updateMany({ where: { organizationId: f.orgId, userId: f.id }, data: { role: "owner" } });
  await revokeChatPass({ data: { orgId: f.orgId, token: f.token } });
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const original = alphabet.indexOf(f.token.slice(-1));
  const alternate = f.token.slice(0,-1) + alphabet[original ^ 1];
  expect(alternate).not.toBe(f.token);
  expect(await validatePlanningChatPass({ data: alternate })).toEqual({ status: "revoked" });
});
