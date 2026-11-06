import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";

// Optional compatibility probe, intentionally fails on the installed adapter:
// SHOWPILOT_PROBE_ISOLATE_PRISMA=1 pnpm --filter @showpilot/web exec vitest run --config vitest.worker.config.ts src/lib/__tests__/database-sessions.worker.test.ts
// Concurrent SELF requests then report workerd's cross-request I/O error, even
// after warmup. Re-run before considering an isolate-wide Prisma client.

async function fixture() {
  const member = await seedRelayMember(`database-${crypto.randomUUID()}`);
  const url = new URL("https://app.test/_test/prisma");
  url.searchParams.set("orgId", member.orgId);
  return { member, url };
}

interface Probe {
  first: { id: string; name: string };
  second: { id: string; name: string };
  clientId: number;
  reusedWithinRequest: boolean;
  sessions: string[];
  queries: string[];
}

it("reuses one Prisma client within each request without sharing engines or replica sessions across concurrent requests", async () => {
  const first = await fixture();
  const second = await fixture();
  const warm = await SELF.fetch(first.url);
  const initial = await warm.json<Probe>();
  const runs = await Promise.all([first, second, first, second].map(async test => {
    const response = await SELF.fetch(test.url);
    expect(response.status).toBe(200);
    const result = await response.json<Probe>();
    expect(result.first.id).toBe(test.member.orgId);
    expect(result.second.id).toBe(test.member.orgId);
    expect(result.sessions).toEqual(["first-unconstrained"]);
    expect(result.queries).toEqual(["first-unconstrained", "first-unconstrained"]);
    expect(result.reusedWithinRequest).toBe(true);
    expect(result.clientId).not.toBe(initial.clientId);
    return result;
  }));
  expect(new Set(runs.map(result => result.clientId)).size).toBe(4);
});

it("routes mutations and security reads to primary while a post-write loader starts on primary", async () => {
  const test = await fixture();
  const saved = await SELF.fetch(test.url, { method: "POST" });
  const write = await saved.json<Probe>();
  expect(write.second.name).toBe("Saved by fixture");
  expect(write.sessions).toEqual([]);
  expect(write.queries).toEqual(["primary", "primary", "primary"]);
  const cookies = saved.headers.getSetCookie();
  expect(cookies).toContain("fixture_cookie=kept; Path=/");
  const recentWrite = cookies.find(cookie => cookie.startsWith("showpilot_read_after_write="));
  expect(recentWrite).toContain("HttpOnly; SameSite=Lax; Secure");
  test.url.searchParams.set("sessionId", test.member.sessionId);
  const loaded = await SELF.fetch(test.url, { headers: { Cookie: recentWrite?.split(";")[0] ?? "" } });
  const result = await loaded.json<Probe>();
  expect(result.first.name).toBe("Saved by fixture");
  expect(result.sessions).toEqual(["first-primary"]);
  expect(result.queries).toEqual(["first-primary", "primary", "first-primary"]);
  const ordinary = await (await SELF.fetch(test.url)).json<Probe>();
  expect(ordinary.queries).toEqual(["first-unconstrained", "primary", "first-unconstrained"]);
});

it.each(["invalid", "9999999999999", "1000000000000"])("ignores an invalid or expired post-write marker %s", async marker => {
  const test = await fixture();
  const result = await (await SELF.fetch(test.url, { headers: { Cookie: `showpilot_read_after_write=${marker}` } })).json<Probe>();
  expect(result.sessions).toEqual(["first-unconstrained"]);
});

it("keeps reads after a lazy GET mutation on primary", async () => {
  const test = await fixture();
  test.url.searchParams.set("lazyWrite", "1");
  const response = await SELF.fetch(test.url);
  const result = await response.json<Probe>();
  expect(result.first.name).toBe(test.member.orgId);
  expect(result.second.name).toBe("Seeded during GET");
  expect(result.queries).toEqual(["first-unconstrained", "primary", "primary"]);
  expect(response.headers.getSetCookie().some(cookie => cookie.startsWith("showpilot_read_after_write="))).toBe(true);
});
