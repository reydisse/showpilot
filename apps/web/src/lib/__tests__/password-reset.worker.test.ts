import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { getAuth } from "../auth";
import { getPrisma } from "../db";
vi.mock("better-auth/tanstack-start", () => ({ tanstackStartCookies: () => ({ id: "test-cookie-bridge" }) }));
const request = vi.hoisted(() => ({ ip: "192.0.2.1" }));
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => new Headers({ "cf-connecting-ip": request.ip }) }));
vi.mock("@tanstack/react-start", () => ({ createServerFn: () => {
  let validate = (value: unknown) => value;
  const chain = { inputValidator: (fn: typeof validate) => { validate = fn; return chain; }, handler: (fn: (input: { data: unknown }) => unknown) => (input: { data: unknown }) => fn({ data: validate(input.data) }) };
  return chain;
} }));
import { checkPasswordResetLink } from "../password-reset";
const origin = "https://app.showpilot.tech";
const oldPassword = "Disposable-password-94!", newPassword = "Replacement-password-53!";
const post = (path: string, body: unknown) => getAuth().handler(new Request(`${origin}/api/auth/${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) }));
const check = (token: string) => checkPasswordResetLink({ data: { token } });
beforeEach(() => { request.ip = crypto.randomUUID(); });
async function fixture(expiresAt = new Date(Date.now() + 60_000)) {
  const prisma = getPrisma(), id = crypto.randomUUID(), token = crypto.randomUUID(), email = `${id}@example.test`;
  await prisma.user.create({ data: { id, name: "Reset fixture", email, emailVerified: true } });
  await prisma.account.create({ data: { id: crypto.randomUUID(), issuer: "local:credential", accountId: id, providerId: "credential", userId: id, password: await hashPassword(oldPassword) } });
  const ctx = await getAuth().$context;
  await ctx.internalAdapter.createVerificationValue({ identifier: `reset-password:${token}`, value: id, expiresAt });
  return { prisma, id, token, email, ctx };
}
// Negative auth HTTP responses run in smoke-password-reset.mjs against the
// built Worker, with its real request context, as in the organization fixture.
it("checks repeatedly without consuming the token and returns no account identity", async () => {
  const f = await fixture();
  expect(await check(f.token)).toEqual({ valid: true });
  expect(await check(f.token)).toEqual({ valid: true });
  expect(await f.ctx.internalAdapter.findVerificationValue(`reset-password:${f.token}`)).not.toBeNull();
  const response = await post("reset-password", { token: f.token, newPassword });
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ status: true });
  expect(await check(f.token)).toEqual({ valid: false });
  expect((await post("sign-in/email", { email: f.email, password: newPassword })).status).toBe(200);
}, 20_000);
it("rejects missing, expired and consumed links, including expiry after a successful check", async () => {
  expect(await check("unknown-link")).toEqual({ valid: false });
  const expired = await fixture(new Date(Date.now() - 1000));
  expect(await check(expired.token)).toEqual({ valid: false });
  const f = await fixture(); expect(await check(f.token)).toEqual({ valid: true });
  await f.prisma.verification.updateMany({ where: { identifier: `reset-password:${f.token}` }, data: { expiresAt: new Date(Date.now() - 1000) } });
  expect(await check(f.token)).toEqual({ valid: false });
  expect((await post("sign-in/email", { email: f.email, password: oldPassword })).status).toBe(200);
}, 20_000);
it("rate limits anonymous checks without including token values in the rate bucket", async () => {
  for (let i = 0; i < 10; i++) expect(await check(`missing-${i}`)).toEqual({ valid: false });
  await expect(check("missing-next")).rejects.toThrow("Too many link checks");
  const rows = await env.DB.prepare("SELECT key FROM rateLimit WHERE key = ?").bind(`reset-link-check:${request.ip}`).all();
  expect(rows.results).toHaveLength(1);
});
it("validates untrusted tokens before any auth read", async () => {
  await expect(async () => check("")).rejects.toThrow();
  await expect(async () => check("x".repeat(257))).rejects.toThrow();
});
