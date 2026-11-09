import { env } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { seedRelayMember } from "@/test/relay-fixtures";
import { nextFixtureAddress } from "@/test/fixture-address";
import { getAuth } from "../auth";
import { getPrisma } from "../db";
import { handleMobileApi } from "../mobile-api.server";

vi.mock("better-auth/tanstack-start", () => ({
  tanstackStartCookies: () => ({ id: "test-cookie-bridge" }),
}));
vi.mock("@tanstack/react-start/server", () => ({
  getRequestHeaders: () => new Headers(),
}));
vi.mock("@tanstack/react-start", () => {
  const builder = () => {
    const chain = {
      middleware: () => chain,
      inputValidator: () => chain,
      handler: (handler: unknown) => handler,
      server: () => chain,
    };
    return chain;
  };
  return {
    createServerFn: builder,
    createMiddleware: builder,
    createServerOnlyFn: <T>(fn: T): T => fn,
  };
});
afterEach(() => abortAllDurableObjects());
const orgId = crypto.randomUUID(), otherOrg = crypto.randomUUID();
let userId = "", cookie = "";
const shows = ["morning", "evening", "old", "deleting"].map(name => ({ id: crypto.randomUUID(), name }));
beforeAll(async () => {
  const actor = await seedRelayMember(orgId); userId = actor.userId;
  await seedRelayMember(otherOrg);
  const password = "Disposable-timecode-show-password-92!";
  await getPrisma().account.create({ data: { id: crypto.randomUUID(), issuer: "local:credential", accountId: userId, providerId: "credential", userId, password: await hashPassword(password) } });
  for (const show of shows) await getPrisma().rundown.create({ data: { ...show, orgId, serviceDate: show.name === "old" ? "2001-01-01" : "2002-01-01" } });
  await getPrisma().rundown.create({ data: { id: crypto.randomUUID(), orgId: otherOrg, serviceDate: "2002-01-01", name: "Other organization" } });
  await env.DB.prepare("INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,?,?)").bind(crypto.randomUUID(), orgId, `show-deleting:${shows[3].id}`, "true").run();
  const login = await getAuth().handler(new Request("https://app.showpilot.tech/api/auth/sign-in/email", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://app.showpilot.tech", "cf-connecting-ip": nextFixtureAddress() },
    body: JSON.stringify({ email: `${userId}@example.test`, password }),
  }));
  expect(login.status).toBe(200); await login.arrayBuffer();
  cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
});
async function call(session = cookie, organization = orgId) {
  const response = await handleMobileApi(new Request(`https://app.showpilot.tech/api/mobile/v1/timecode/shows?orgId=${organization}`, { headers: { Cookie: session } }), env);
  if (!response) throw new Error("Missing timecode show-list route");
  return { status: response.status, body: await response.json() };
}
it("lists both same-day shows and older shows without leaking another organization or a deleting show", async () => {
  const response = await call();
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ shows: expect.arrayContaining(shows.slice(0, 3).map(show => ({ ...show, serviceDate: show.name === "old" ? "2001-01-01" : "2002-01-01", scheduledStartTime: null }))) });
  expect(response.body).toHaveProperty("shows.length", 3);
});
it("requires a real signed-in session", async () => { expect((await call("")).status).toBe(401); });
it("requires timecode access even when the member can view rundowns", async () => {
  await env.DB.prepare("UPDATE member SET role='member' WHERE organizationId=? AND userId=?").bind(orgId, userId).run();
  expect((await call()).status).toBe(403);
});
it("cannot list another organization's timecode shows", async () => { expect(await call(cookie, otherOrg)).toEqual({ status: 401, body: { error: "Unauthorized" } }); });
