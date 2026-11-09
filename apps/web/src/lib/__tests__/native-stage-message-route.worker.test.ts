import { env } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
let orgId = "",
  showId = "";
const serviceDate = "2026-11-08";
let userId = "",
  cookie = "",
  expectedRevision = 0;
beforeEach(async () => {
  orgId = crypto.randomUUID();
  showId = crypto.randomUUID();
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
    data: { id: showId, orgId, serviceDate, name: "Stage route fixture" },
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
  if (!response) throw new Error("Missing native stage route");
  return { status: response.status, body: await response.json() };
}

it("lets a signed-in control-only production manager send and clear stage messages", async () => {
  expect(
    await call("stage", {
      action: "stage-message",
      message: "Control-only message",
    }),
  ).toMatchObject({
    status: 200,
    body: { outcome: "applied", orgId, userId, showId },
  });
  expect(
    await call("stage", {
      action: "stage-clear",
      expectedRevision: expectedRevision + 1,
    }),
  ).toMatchObject({ status: 200, body: { outcome: "applied" } });
});
it("the stage endpoint cannot grant item editing or reset authority", async () => {
  for (const action of ["reset", "clear-all"])
    expect(await call("stage", { action })).toMatchObject({ status: 400 });
  expect(
    await call("change", { action: "stage-message", message: "No edit grant" }),
  ).toMatchObject({ status: 403 });
  expect(
    await call("reset", { action: "stage-message", message: "Wrong endpoint" }),
  ).toMatchObject({ status: 400 });
});
it("stage commands require the original actor, show and revision", async () => {
  expect(
    await call("stage", {
      action: "stage-message",
      message: "Denied",
      userId: "other",
    }),
  ).toMatchObject({ status: 403 });
  expect(
    await call("stage", {
      action: "stage-message",
      message: "Denied",
      showId: "other",
    }),
  ).toMatchObject({ status: 403 });
  expect(
    await call("stage", { action: "stage-clear", expectedRevision: undefined }),
  ).toMatchObject({ status: 400 });
});
it("rechecks control revocation before sending a stage message", async () => {
  await env.DB.prepare(
    "UPDATE member SET role='member' WHERE organizationId=? AND userId=?",
  )
    .bind(orgId, userId)
    .run();
  expect(
    await call("stage", { action: "stage-message", message: "Denied" }),
  ).toMatchObject({ status: 403 });
});

it("preserves edit-only stage access without granting transport control", async () => {
  await env.DB.prepare(
    "UPDATE member SET role='member' WHERE organizationId=? AND userId=?",
  )
    .bind(orgId, userId)
    .run();
  await env.DB.prepare(
    "INSERT INTO member_permission_grant(id,orgId,userId,capability,permissions,startsOn,grantedByUserId) VALUES(?,?,?,'rundown','[\"rundown:edit\"]','2000-01-01',?)",
  )
    .bind(crypto.randomUUID(), orgId, userId, userId)
    .run();
  expect(
    await call("stage", {
      action: "stage-message",
      message: "Edit-only message",
    }),
  ).toMatchObject({ status: 200, body: { outcome: "applied" } });
  expect(await call("reset")).toMatchObject({ status: 403 });
});
