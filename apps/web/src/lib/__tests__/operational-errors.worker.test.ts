import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import { recordOperationalError, reportRelayError, pruneOperationalErrors, ERROR_DAY_LIMIT, ERROR_RETENTION_MS, ERROR_MINUTE_LIMIT } from "../operational-errors.server";
const auth = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("../auth", () => ({ getAuth: () => ({ api: { getSession: async () => auth.userId ? { user: { id: auth.userId } } : null } }) }));
import { handleOperationalErrorRequest } from "../operational-error-api.server";
const tasks: Promise<unknown>[] = [];
const ctx = { waitUntil: (task: Promise<unknown>) => { tasks.push(task); } };
afterEach(async () => { await Promise.all(tasks.splice(0)); vi.restoreAllMocks(); });
const input = { code: "browser_error" as const, errorName: "TypeError" as const, asset: "fixture.js", line: 12 };
async function fixture() { const member = await seedRelayMember(`error-log-${crypto.randomUUID()}`); auth.userId = member.userId; return member; }
function request(orgId: string, body: unknown = input, origin = "https://app.showpilot.tech") {
  return new Request(`https://app.showpilot.tech/api/operational-errors/${orgId}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
async function rows(orgId: string) { return (await env.DB.prepare("SELECT * FROM operational_error WHERE orgId=?").bind(orgId).all()).results; }

it("authenticates membership, rejects cross-origin and forged relay reports, and limits read access", async () => {
  const mine = await fixture(); const other = await fixture(); auth.userId = mine.userId;
  expect((await handleOperationalErrorRequest(request(other.orgId), env.DB, other.orgId, ctx)).status).toBe(403);
  auth.userId = null;
  expect((await handleOperationalErrorRequest(request(mine.orgId), env.DB, mine.orgId, ctx)).status).toBe(401);
  auth.userId = mine.userId;
  expect((await handleOperationalErrorRequest(request(mine.orgId, input, "https://evil.test"), env.DB, mine.orgId, ctx)).status).toBe(403);
  for (const body of [{ ...input, code: "rundown_persistence" }, { ...input, stack: "private secret" }, { ...input, asset: "https://private.test/secret.js" }]) {
    expect((await handleOperationalErrorRequest(request(mine.orgId, body), env.DB, mine.orgId, ctx)).status).toBe(400);
  }
  expect((await handleOperationalErrorRequest(request(mine.orgId, { ...input, extra: "x".repeat(1100) }), env.DB, mine.orgId, ctx)).status).toBe(413);
  await env.DB.prepare("UPDATE member SET role='member' WHERE organizationId=? AND userId=?").bind(mine.orgId, mine.userId).run();
  expect((await handleOperationalErrorRequest(new Request(`https://app.showpilot.tech/api/operational-errors/${mine.orgId}`), env.DB, mine.orgId, ctx)).status).toBe(403);
  expect(await rows(mine.orgId)).toEqual([]);
});

it("stores safe browser reports in the background and returns only this org's last 50 to administrators", async () => {
  const mine = await fixture(); const other = await fixture(); auth.userId = mine.userId;
  const response = await handleOperationalErrorRequest(request(mine.orgId), env.DB, mine.orgId, ctx);
  expect(response.status).toBe(202); expect(response.headers.get("Cache-Control")).toBe("no-store");
  await Promise.all(tasks.splice(0));
  await recordOperationalError(env.DB, other.orgId, input);
  const result = await handleOperationalErrorRequest(new Request(`https://app.showpilot.tech/api/operational-errors/${mine.orgId}`), env.DB, mine.orgId, ctx);
  expect(await result.json()).toMatchObject({ errors: [{ code: "browser_error", source: "browser", errorName: "TypeError", asset: "fixture.js", message: expect.any(String) }] });
  expect(await rows(mine.orgId)).toHaveLength(1);
});

it("atomically caps concurrent writers and isolates each org's budget", async () => {
  const mine = await fixture(); const other = await fixture(); const now = Date.now();
  const results = await Promise.all(Array.from({ length: 45 }, () => recordOperationalError(env.DB, mine.orgId, input, now)));
  expect(results.filter(Boolean)).toHaveLength(ERROR_MINUTE_LIMIT);
  expect(await rows(mine.orgId)).toHaveLength(ERROR_MINUTE_LIMIT);
  expect(await recordOperationalError(env.DB, other.orgId, input, now)).toBe(true);
  expect(await recordOperationalError(env.DB, mine.orgId, input, now + 60_001)).toBe(true);
});

it("bounds daily storage, expires reports and cascades organization deletion", async () => {
  const { orgId } = await fixture(); const now = Date.now();
  await env.DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?)
    INSERT INTO operational_error(id,orgId,source,code,errorName,createdAt)
    SELECT 'fixture-'||?||'-'||x,?,'browser','browser_error','Unknown',? FROM n`).bind(ERROR_DAY_LIMIT, orgId, orgId, now - 60_001).run();
  expect(await recordOperationalError(env.DB, orgId, input, now)).toBe(false);
  const page = await handleOperationalErrorRequest(new Request(`https://app.showpilot.tech/api/operational-errors/${orgId}`), env.DB, orgId, ctx);
  expect((await page.json<{ errors: unknown[] }>()).errors).toHaveLength(50);
  await pruneOperationalErrors(env.DB, now + ERROR_RETENTION_MS); expect(await rows(orgId)).toEqual([]);
  expect(await recordOperationalError(env.DB, orgId, input, now + ERROR_RETENTION_MS)).toBe(true);
  await env.DB.prepare("DELETE FROM organization WHERE id=?").bind(orgId).run(); expect(await rows(orgId)).toEqual([]);
});

it("drops arbitrary exception text, throttles relay duplicates and cannot reject a live path when D1 fails", async () => {
  const { orgId } = await fixture(); const cause = new TypeError("secret password and private lyric");
  reportRelayError(ctx, env.DB, orgId, "rundown_persistence", cause);
  reportRelayError(ctx, env.DB, orgId, "rundown_persistence", cause);
  await Promise.all(tasks.splice(0));
  const stored = await rows(orgId); expect(stored).toHaveLength(1); expect(stored[0]).toMatchObject({ code: "rundown_persistence", source: "RundownRelay", errorName: "TypeError" });
  expect(JSON.stringify(stored)).not.toMatch(/password|private|secret/);
  const fail = vi.spyOn(env.DB, "prepare").mockImplementation(() => { throw new Error("D1 unavailable"); });
  expect(() => reportRelayError(ctx, env.DB, orgId, "rundown_activation", cause)).not.toThrow();
  await expect(Promise.all(tasks.splice(0))).resolves.toEqual([undefined]); fail.mockRestore();
});
