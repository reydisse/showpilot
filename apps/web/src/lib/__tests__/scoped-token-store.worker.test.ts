import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { backfillScopedTokenDigests, findScopedToken, scopedTokenDigest, scopedTokenIsActive } from "../scoped-token-store.server";
import { authenticateKiosk } from "../kiosk-api";
import { authenticateCompanion } from "../companion-api";
import { authenticateDisplayRequest } from "../display-access.server";
import { signToken } from "../kiosk-token";
import { signCompanionToken } from "../companion-token";

// Only adapt TanStack request setup; signatures, D1 migration and API authentication are real.
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => new Headers() }));
vi.mock("@tanstack/react-start", () => {
  const builder = () => {
    const chain = { middleware: () => chain, inputValidator: () => chain, handler: (fn: unknown) => fn, server: () => chain };
    return chain;
  };
  return { createServerFn: builder, createMiddleware: builder, createServerOnlyFn: <T>(fn: T): T => fn };
});

const kioskSecret = "worker-test-kiosk-secret-for-local-integration-only";
const companionSecret = "worker-test-companion-secret-for-local-integration-only";
async function fixture(kind: "kiosk" | "companion", storedAs: "plaintext" | "digest" = "plaintext") {
  const orgId = `scoped-token-${crypto.randomUUID()}`;
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Token fixture', ?, CURRENT_TIMESTAMP)").bind(orgId, orgId).run();
  const payload = { orgId, orgSlug: orgId, view: "timer", jti: crypto.randomUUID(), iat: Math.floor(Date.now() / 1000) };
  const token = kind === "kiosk" ? await signToken(payload, kioskSecret) : await signCompanionToken({ ...payload, scope: "companion" }, companionSecret);
  const stored = storedAs === "digest" ? await scopedTokenDigest(token) : token;
  const table = kind === "kiosk" ? "kiosk_token" : "companion_token";
  await env.DB.prepare(`INSERT INTO ${table} (id, orgId, label, token, createdBy${kind === "kiosk" ? ", view" : ""}) VALUES (?, ?, 'Fixture', ?, 'fixture-owner'${kind === "kiosk" ? ", 'timer'" : ""})`).bind(id, orgId, stored).run();
  return { orgId, id, token, table };
}
const request = (token: string) => new Request("https://app.example/api", { headers: { Authorization: `Bearer ${token}` } });

describe("scoped bearer token storage", () => {
  it.each(["kiosk", "companion"] as const)("migrates an existing %s token once without changing its identity or revocation", async kind => {
    const { orgId, id, token, table } = await fixture(kind);
    const [first, concurrent] = await Promise.all([findScopedToken(env.DB, kind, orgId, token), findScopedToken(env.DB, kind, orgId, token)]);
    expect(first).toEqual(concurrent);
    expect(first).toMatchObject({ id, orgId, revokedAt: null });
    expect(JSON.stringify(first)).not.toContain(token);
    expect(await env.DB.prepare(`SELECT token FROM ${table} WHERE id = ? AND orgId = ?`).bind(id, orgId).first("token")).toBe(await scopedTokenDigest(token));
    await env.DB.prepare(`UPDATE ${table} SET revokedAt = CURRENT_TIMESTAMP WHERE id = ? AND orgId = ?`).bind(id, orgId).run();
    expect(scopedTokenIsActive(await findScopedToken(env.DB, kind, orgId, token))).toBe(false);
  });

  it.each(["kiosk", "companion"] as const)("authenticates a migrated %s token through the real API and rejects the digest as a bearer token", async kind => {
    const { token, orgId, id, table } = await fixture(kind);
    const authenticate = kind === "kiosk" ? authenticateKiosk : authenticateCompanion;
    expect(await authenticate(request(token))).toEqual({ orgId, orgSlug: orgId });
    expect(await authenticate(request(await scopedTokenDigest(token)))).toHaveProperty("error.status", 401);
    await env.DB.prepare(`UPDATE ${table} SET expiresAt = ? WHERE id = ? AND orgId = ?`).bind(Date.now() - 1000, id, orgId).run();
    expect(await authenticate(request(token))).toHaveProperty("error.status", 401);
  });

  it("keeps existing display links working after migration while preserving view and organization boundaries", async () => {
    const { token, orgId } = await fixture("kiosk");
    expect(await authenticateDisplayRequest(env.DB, request(token), orgId, "timer", kioskSecret)).toMatchObject({ orgId, surface: "timer" });
    expect(await authenticateDisplayRequest(env.DB, request(token), orgId, "overlay", kioskSecret)).toBeNull();
    expect(await authenticateDisplayRequest(env.DB, request(token), "other-org", "timer", kioskSecret)).toBeNull();
    expect(await findScopedToken(env.DB, "companion", orgId, token)).toBeNull();
    expect(await findScopedToken(env.DB, "kiosk", "other-org", token)).toBeNull();
  });

  it("backfills inactive and revoked tokens in bounded idempotent batches", async () => {
    const rows = await Promise.all([fixture("kiosk"), fixture("kiosk"), fixture("companion"), fixture("companion")]);
    const revoked = rows[0];
    await env.DB.prepare("UPDATE kiosk_token SET revokedAt = CURRENT_TIMESTAMP WHERE id = ? AND orgId = ?").bind(revoked.id, revoked.orgId).run();
    let result = await backfillScopedTokenDigests(env.DB, 1);
    expect(result.migrated).toBeLessThanOrEqual(2);
    expect(result.remaining).toBeGreaterThan(0);
    for (let iteration = 0; result.remaining && iteration < 20; iteration++) result = await backfillScopedTokenDigests(env.DB, 1);
    expect(result.remaining).toBe(0);
    for (const { table, id, orgId, token } of rows) {
      expect(await env.DB.prepare(`SELECT token FROM ${table} WHERE id = ? AND orgId = ?`).bind(id, orgId).first("token")).toBe(await scopedTokenDigest(token));
    }
    expect(await backfillScopedTokenDigests(env.DB)).toEqual({ migrated: 0, remaining: 0 });
    expect(scopedTokenIsActive(await findScopedToken(env.DB, "kiosk", revoked.orgId, revoked.token))).toBe(false);
    await expect(backfillScopedTokenDigests(env.DB, 0)).rejects.toThrow("batch size");
  });
});
