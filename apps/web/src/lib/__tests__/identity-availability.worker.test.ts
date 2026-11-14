import { env } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { APIError } from "better-auth/api";
import { seedRelayMember } from "@/test/relay-fixtures";
import { nextFixtureAddress } from "@/test/fixture-address";
import { getAuth } from "../auth";
import { getPrisma } from "../db";
import { handleMobileApi } from "../mobile-api.server";
import { RelayUpgradeCache } from "../relay-upgrade-cache.server";
import { AccessCheckUnavailableError } from "../access-check-errors.server";

vi.mock("better-auth/tanstack-start", () => ({ tanstackStartCookies: () => ({ id: "test-cookie-bridge" }) }));
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => new Headers() }));
vi.mock("@tanstack/react-start", () => {
  const builder = () => {
    const chain = { middleware: () => chain, inputValidator: () => chain, handler: (handler: unknown) => handler, server: () => chain };
    return chain;
  };
  return { createServerFn: builder, createMiddleware: builder, createServerOnlyFn: <T>(fn: T): T => fn };
});
afterEach(() => abortAllDurableObjects());

const orgId = crypto.randomUUID(), showId = crypto.randomUUID();
let userId = "", cookie = "";
beforeAll(async () => {
  const actor = await seedRelayMember(orgId);
  userId = actor.userId;
  const password = "Disposable-session-probe-only-93!";
  await getPrisma().account.create({ data: {
    id: crypto.randomUUID(), issuer: "local:credential", accountId: userId, providerId: "credential", userId,
    password: await hashPassword(password),
  } });
  await getPrisma().rundown.create({ data: { id: showId, orgId, serviceDate: "2026-11-14", name: "Session fixture" } });
  const login = await getAuth().handler(new Request("https://app.showpilot.tech/api/auth/sign-in/email", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://app.showpilot.tech", "cf-connecting-ip": nextFixtureAddress() },
    body: JSON.stringify({ email: `${userId}@example.test`, password }),
  }));
  expect(login.status).toBe(200);
  await login.arrayBuffer();
  cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
});

function failedIdentityDb() {
  return new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => {
        if (sql.startsWith("SELECT role FROM member")) throw new Error("Injected identity database outage");
        return target.prepare(sql);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
const paths = () => ["/api/mobile/v1/cue-sheets", "/api/mobile/v1/chat/members", `/api/mobile/v1/rundowns/${showId}`];
async function call(path: string, db = env.DB, auth = cookie) {
  const response = await handleMobileApi(new Request(`https://app.showpilot.tech${path}?orgId=${orgId}`, {
    headers: { Cookie: auth },
  }), { ...env, DB: db });
  if (!response) throw new Error("Missing fixture route");
  return response;
}

it("returns retryable 503 for an identity database failure and recovers with the same session on retry", async () => {
  const session = await getAuth().api.getSession({ headers: new Headers({ Cookie: cookie }) });
  expect(session?.user.id).toBe(userId);
  for (const path of paths()) {
    const failed = await call(path, failedIdentityDb());
    expect(failed.status).toBe(503);
    expect(failed.headers.get("Retry-After")).toBe("1");
    const error = await failed.json<{ error: string; code: string }>();
    expect(error.code).toBe("access_unavailable");
    expect(error.error).not.toContain("Injected");
    expect((await call(path)).status).toBe(200);
  }
});

it("keeps genuinely missing credentials unauthorized during the downstream outage", async () => {
  for (const path of paths()) expect((await call(path, failedIdentityDb(), "")).status).toBe(401);
});

it("retains permission denials instead of treating them as internal failures", async () => {
  await env.DB.prepare("UPDATE member SET role='member' WHERE organizationId=? AND userId=?").bind(orgId, userId).run();
  try { expect((await call("/api/mobile/v1/cue-sheets")).status).toBe(403); }
  finally { await env.DB.prepare("UPDATE member SET role='owner' WHERE organizationId=? AND userId=?").bind(orgId, userId).run(); }
});

it("does not turn a relay authority outage into an anonymous identity or poison the next request", async () => {
  const cache = new RelayUpgradeCache();
  const request = () => new Request(`https://app.showpilot.tech/api/chat/${orgId}/ws`, {
    headers: { Cookie: cookie, Upgrade: "websocket" },
  });
  const load = (request: Request) => getAuth().api.getSession({ headers: request.headers });
  await expect(cache.identity(request(), orgId, failedIdentityDb(), load)).rejects.toBeInstanceOf(AccessCheckUnavailableError);
  expect(await cache.identity(request(), orgId, env.DB, load)).toMatchObject({ userId });
});

it("surfaces a failed upgrade session lookup without caching a rejected login", async () => {
  const cache = new RelayUpgradeCache();
  const request = () => new Request(`https://app.showpilot.tech/api/chat/${orgId}/ws`, {
    headers: { Cookie: cookie, Upgrade: "websocket" },
  });
  await expect(cache.resolveOrgId(request(), orgId, env.DB, async () => { throw new Error("Injected session lookup outage"); }))
    .rejects.toBeInstanceOf(AccessCheckUnavailableError);
  expect(await cache.identity(request(), orgId, env.DB, req => getAuth().api.getSession({ headers: req.headers })))
    .toMatchObject({ userId });
});

it.each(["GET", "POST"])("preserves an explicit authentication denial on a %s relay request", async method => {
  const cache = new RelayUpgradeCache();
  const request = new Request(`https://app.showpilot.tech/api/chat/${orgId}/ws`, {
    method, headers: { Cookie: cookie, Upgrade: "websocket" },
  });
  expect(await cache.identity(request, orgId, env.DB, async () => { throw new APIError("UNAUTHORIZED"); })).toBeNull();
});
