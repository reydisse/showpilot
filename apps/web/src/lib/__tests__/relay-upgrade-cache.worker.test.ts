import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import { RelayUpgradeCache } from "../relay-upgrade-cache.server";

async function fixture() {
  const member = await seedRelayMember(`upgrade-${crypto.randomUUID()}`);
  let now = Date.now();
  let reads = 0;
  const cache = new RelayUpgradeCache(() => now);
  const db = { prepare(sql: string) { reads++; return env.DB.prepare(sql); } };
  const request = (method = "GET", path = "ws", token = member.sessionId) => new Request(`https://app.test/api/timecode/${member.orgId}/${path}`, {
    method, headers: { Upgrade: "websocket", Authorization: `Bearer ${token}` },
  });
  const load = async (request: Request) => {
    const row = await db.prepare("SELECT s.id, s.expiresAt, u.id AS userId, u.name FROM session s JOIN user u ON u.id=s.userId WHERE s.token=?")
      .bind(request.headers.get("authorization")?.slice(7)).first<{ id: string; expiresAt: string; userId: string; name: string }>();
    return row ? { session: { id: row.id, expiresAt: row.expiresAt }, user: { id: row.userId, name: row.name } } : null;
  };
  const resolve = async (req = request()) => {
    const orgId = await cache.resolveOrgId(req, member.orgId, db, load);
    return orgId ? cache.identity(req, orgId, db, load) : null;
  };
  return { member, cache, db, request, load, resolve, reads: () => reads, advance: (ms: number) => { now += ms; }, now: () => now };
}

it("reuses completed session, org and permission decisions across repeated upgrades", async () => {
  const test = await fixture();
  expect(await test.resolve()).toMatchObject({ userId: test.member.userId, sessionId: test.member.sessionId });
  const firstReads = test.reads();
  expect(firstReads).toBeGreaterThanOrEqual(6);
  for (let count = 0; count < 5; count++) expect(await test.resolve()).toMatchObject({ role: "owner" });
  expect(test.reads()).toBe(firstReads);
});

it.each([["POST", "ws"], ["GET", "state"]])("never uses upgrade authority for %s /%s even with an Upgrade header", async (method, path) => {
  const test = await fixture();
  await test.resolve();
  await env.DB.prepare("DELETE FROM member WHERE organizationId=? AND userId=?").bind(test.member.orgId, test.member.userId).run();
  const before = test.reads();
  expect(await test.resolve(test.request(method, path))).toBeNull();
  expect(test.reads()).toBeGreaterThan(before);
});

it("expires cached permissions and honors explicit per-member invalidation", async () => {
  const test = await fixture();
  await test.resolve();
  await env.DB.prepare("UPDATE member SET role='member' WHERE organizationId=? AND userId=?").bind(test.member.orgId, test.member.userId).run();
  test.cache.invalidate({ orgId: test.member.orgId, userId: test.member.userId });
  expect(await test.resolve()).toMatchObject({ role: "member" });
  await env.DB.prepare("DELETE FROM member WHERE organizationId=? AND userId=?").bind(test.member.orgId, test.member.userId).run();
  test.advance(15_001);
  expect(await test.resolve()).toBeNull();
});

it("does not extend a session beyond its actual expiry", async () => {
  const test = await fixture();
  await env.DB.prepare("UPDATE session SET expiresAt=? WHERE id=?").bind(new Date(test.now() + 1000).toISOString(), test.member.sessionId).run();
  expect(await test.resolve()).not.toBeNull();
  test.advance(1001);
  expect(await test.resolve()).toBeNull();
});

it("isolates sessions and organizations and never caches a rejected login", async () => {
  const test = await fixture();
  await test.resolve();
  const other = await seedRelayMember(`other-${crypto.randomUUID()}`);
  expect(await test.resolve(test.request("GET", "ws", other.sessionId))).toBeNull();
  expect(await test.cache.identity(test.request(), other.orgId, test.db, test.load)).toBeNull();
  const before = test.reads();
  expect(await test.resolve(test.request("GET", "ws", "invalid"))).toBeNull();
  const rejectedReads = test.reads();
  expect(rejectedReads).toBeGreaterThan(before);
  expect(await test.resolve(test.request("GET", "ws", "invalid"))).toBeNull();
  expect(test.reads()).toBeGreaterThan(rejectedReads);
});

it("does not repopulate a cache with a session lookup started before invalidation", async () => {
  const test = await fixture();
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started = () => {};
  const loading = new Promise<void>(resolve => { started = resolve; });
  const pending = test.cache.identity(test.request(), test.member.orgId, test.db, async request => {
    const session = await test.load(request);
    started(); await gate;
    return session;
  });
  await loading;
  await env.DB.prepare("DELETE FROM session WHERE id=?").bind(test.member.sessionId).run();
  test.cache.invalidate({ userId: test.member.userId });
  release(); await pending;
  expect(await test.resolve()).toBeNull();
});
