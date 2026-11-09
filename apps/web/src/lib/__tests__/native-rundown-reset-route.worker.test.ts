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
const orgId = crypto.randomUUID(),
  showId = crypto.randomUUID(),
  serviceDate = "2026-11-08";
let userId = "",
  cookie = "",
  expectedRevision = 0;
beforeAll(async () => {
  const actor = await seedRelayMember(orgId);
  userId = actor.userId;
  const password = "Disposable-native-reset-password-92!";
  await getPrisma().account.create({
    data: {
      id: crypto.randomUUID(),
      issuer: "local:credential",
      accountId: userId,
      providerId: "credential",
      userId,
      password: await hashPassword(password),
    },
  });
  await getPrisma().rundown.create({
    data: { id: showId, orgId, serviceDate, name: "Reset route fixture" },
  });
  const login = await getAuth().handler(
    new Request("https://app.showpilot.tech/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://app.showpilot.tech",
        "cf-connecting-ip": nextFixtureAddress(),
      },
      body: JSON.stringify({ email: `${userId}@example.test`, password }),
    }),
  );
  expect(login.status).toBe(200);
  await login.arrayBuffer();
  cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  await env.DB.prepare(
    "UPDATE member SET role='pm' WHERE organizationId=? AND userId=?",
  )
    .bind(orgId, userId)
    .run();
  const query = new URLSearchParams({
    orgId,
    showId,
    serviceDate,
    access: "control",
    authUserId: userId,
    authSessionId: actor.sessionId,
  });
  const stateResponse = await env.RUNDOWN_RELAY.getByName(
    `${orgId}:show:${showId}`,
  ).fetch(`https://rundown.test/state?${query}`);
  expect(stateResponse.status).toBe(200);
  expectedRevision = (await stateResponse.json<{ revision: number }>())
    .revision;
});
async function call(path = "reset", overrides: object = {}) {
  const response = await handleMobileApi(
    new Request(
      `https://app.showpilot.tech/api/mobile/v1/rundowns/${showId}/${path}?orgId=${orgId}`,
      {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          orgId,
          userId,
          showId,
          serviceDate,
          requestId: crypto.randomUUID(),
          expectedRevision,
          action: "reset",
          ...overrides,
        }),
      },
    ),
    env,
  );
  if (!response) throw new Error("Missing native reset route");
  return { status: response.status, body: await response.json() };
}
it("allows a real signed-in production manager to reset through the control-only endpoint", async () => {
  expect(await call()).toMatchObject({
    status: 200,
    body: { outcome: "applied", orgId, userId, showId },
  });
});
it("does not let the reset endpoint dispatch editing commands", async () => {
  expect(await call("reset", { action: "clear-all" })).toMatchObject({
    status: 400,
  });
  expect(
    await call("reset", { action: "remove-item", itemId: "cue" }),
  ).toMatchObject({ status: 400 });
  expect(await call("change", { action: "clear-all" })).toMatchObject({
    status: 403,
  });
});
it("rejects wrong-account, wrong-show and missing-revision reset commands", async () => {
  expect(await call("reset", { userId: "other" })).toMatchObject({
    status: 403,
  });
  expect(await call("reset", { showId: "other" })).toMatchObject({
    status: 403,
  });
  expect(await call("reset", { expectedRevision: undefined })).toMatchObject({
    status: 400,
  });
});
it("rechecks loss of current control access before reset", async () => {
  await env.DB.prepare(
    "UPDATE member SET role='member' WHERE organizationId=? AND userId=?",
  )
    .bind(orgId, userId)
    .run();
  expect(await call()).toMatchObject({ status: 403 });
});
