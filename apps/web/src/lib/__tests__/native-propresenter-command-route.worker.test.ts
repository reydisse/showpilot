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
  showId = "",
  userId = "",
  cookie = "";
let messages: string[] = [];
beforeEach(async () => {
  orgId = crypto.randomUUID();
  showId = crypto.randomUUID();
  messages = [];
  const actor = await seedRelayMember(orgId);
  userId = actor.userId;
  const password = "Disposable-slide-command-password-92!";
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
    data: {
      id: showId,
      orgId,
      serviceDate: "2026-11-09",
      name: "Slide route fixture",
    },
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
  for (const [key, value] of [
    ["propresenter-host", "127.0.0.1"],
    ["propresenter-send-cues", "true"],
  ])
    await env.DB.prepare(
      "INSERT INTO app_setting (id,orgId,key,value) VALUES (?,?,?,?)",
    )
      .bind(crypto.randomUUID(), orgId, key, value)
      .run();
  const { openTestBridge, approveTestBridgeTarget } =
    await import("@/test/bridge-fixtures");
  const target = "propresenter:127.0.0.1:50001";
  await approveTestBridgeTarget(orgId, "propresenter", target, {
    apiPort: 1025,
  });
  const bridge = await openTestBridge(orgId);
  bridge.socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    messages.push(message.type);
    if (message.type === "connect-device")
      bridge.socket.send(
        JSON.stringify({ type: "device-status", target, connected: true }),
      );
    if (
      message.type === "prepare-propresenter-command" ||
      message.type === "execute-propresenter-command"
    )
      bridge.socket.send(
        JSON.stringify({
          type: "command-response",
          id: message.id,
          success: true,
        }),
      );
  });
});
const command = () => ({
  orgId,
  userId,
  showId,
  requestId: crypto.randomUUID(),
  command: "next",
});
async function call(mode: string, input: unknown) {
  const response = await handleMobileApi(
    new Request(
      `https://app.showpilot.tech/api/mobile/v1/rundowns/${showId}/propresenter${mode ? `/${mode}` : ""}?orgId=${orgId}`,
      {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    ),
    env,
  );
  if (!response) throw new Error("Missing slide command route");
  return { status: response.status, body: await response.json() };
}
it("lets a control-only PM prepare, execute, and check the same command once", async () => {
  const c = command();
  expect(await call("prepare", c)).toMatchObject({
    status: 200,
    body: { status: "prepared" },
  });
  expect(await call("execute", c)).toMatchObject({
    status: 200,
    body: { status: "confirmed" },
  });
  expect(await call("check", c)).toMatchObject({
    status: 200,
    body: { status: "confirmed" },
  });
  expect(await call("execute", c)).toMatchObject({
    status: 200,
    body: { status: "confirmed" },
  });
  expect(
    messages.filter((type) => type === "execute-propresenter-command"),
  ).toHaveLength(1);
});
it("rejects legacy blind commands and mismatched identities before dispatch", async () => {
  expect((await call("", { command: "next" })).status).toBe(400);
  for (const field of ["orgId", "userId", "showId"])
    expect(
      (await call("prepare", { ...command(), [field]: "other" })).status,
    ).toBe(403);
  expect(
    messages.filter((type) => type === "execute-propresenter-command"),
  ).toHaveLength(0);
});
it("does not execute after control permission is revoked", async () => {
  const c = command();
  expect((await call("prepare", c)).status).toBe(200);
  await env.DB.prepare(
    "UPDATE member SET role='member' WHERE organizationId=? AND userId=?",
  )
    .bind(orgId, userId)
    .run();
  expect((await call("execute", c)).status).toBe(403);
  expect(
    messages.filter((type) => type === "execute-propresenter-command"),
  ).toHaveLength(0);
});
it("does not execute after the show is removed", async () => {
  const c = command();
  expect((await call("prepare", c)).status).toBe(200);
  await getPrisma().rundown.delete({ where: { id: showId } });
  expect(await call("execute", c)).toMatchObject({
    status: 200,
    body: { status: "rejected" },
  });
  expect(
    messages.filter((type) => type === "execute-propresenter-command"),
  ).toHaveLength(0);
});
