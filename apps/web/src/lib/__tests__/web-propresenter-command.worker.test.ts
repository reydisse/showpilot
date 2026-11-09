import { env } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { seedRelayMember } from "@/test/relay-fixtures";
import { nextFixtureAddress } from "@/test/fixture-address";
import { getAuth } from "../auth";
import { getPrisma } from "../db";
import { sendProPresenterCommand } from "../rundown";
import type { ProPresenterCommand } from "@showpilot/shared/propresenter-command";
const requestState = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock("better-auth/tanstack-start", () => ({
  tanstackStartCookies: () => ({ id: "test-cookie-bridge" }),
}));
vi.mock("@tanstack/react-start/server", () => ({
  getRequestHeaders: () => requestState.headers,
}));
vi.mock("@tanstack/react-start", () => {
  const builder = () => {
    let validate = (data: unknown): unknown => data;
    const chain = {
      middleware: () => chain,
      inputValidator: (validator: (data: unknown) => unknown) => {
        validate = validator;
        return chain;
      },
      handler:
        (handler: (input: { data: unknown }) => unknown) =>
        (input: { data: unknown }) =>
          handler({ data: validate(input.data) }),
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
  requestState.headers = new Headers({ Cookie: cookie });
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
const command = (): ProPresenterCommand => ({
  orgId,
  userId,
  showId,
  requestId: crypto.randomUUID(),
  command: "next",
});
async function call(mode: "prepare" | "execute" | "check", input = command()) {
  return sendProPresenterCommand({ data: { ...input, mode } });
}
it("routes a control-only PM through durable preparation, execution and receipt checks", async () => {
  const c = command();
  expect((await call("prepare", c)).status).toBe("prepared");
  expect(
    messages.filter((type) => type === "execute-propresenter-command"),
  ).toHaveLength(0);
  expect((await call("execute", c)).status).toBe("confirmed");
  expect((await call("check", c)).status).toBe("confirmed");
  expect((await call("execute", c)).status).toBe("confirmed");
  expect(
    messages.filter((type) => type === "execute-propresenter-command"),
  ).toHaveLength(1);
});
it("rejects an invalid command, mismatched actor and cross-org request before dispatch", async () => {
  await expect(
    call("prepare", { ...command(), requestId: "not-an-original-id" }),
  ).rejects.toThrow();
  await expect(
    call("prepare", { ...command(), userId: "another-user" }),
  ).rejects.toThrow("account changed");
  await expect(
    call("prepare", { ...command(), orgId: "another-org" }),
  ).rejects.toThrow();
  expect(messages.filter((type) => type === "connect-device")).toHaveLength(0);
});
it("rechecks live permission and session at execution and status reads", async () => {
  const c = command();
  expect((await call("prepare", c)).status).toBe("prepared");
  await env.DB.prepare(
    "UPDATE member SET role='member' WHERE organizationId=? AND userId=?",
  )
    .bind(orgId, userId)
    .run();
  await expect(call("execute", c)).rejects.toThrow("Forbidden");
  await expect(call("check", c)).rejects.toThrow("Forbidden");
  await env.DB.prepare(
    "UPDATE member SET role='pm' WHERE organizationId=? AND userId=?",
  )
    .bind(orgId, userId)
    .run();
  await env.DB.prepare("DELETE FROM session WHERE userId=?").bind(userId).run();
  await expect(call("execute", c)).rejects.toThrow();
  expect(
    messages.filter((type) => type === "execute-propresenter-command"),
  ).toHaveLength(0);
});
it("does not execute a prepared command after its show is deleted", async () => {
  const c = command();
  expect((await call("prepare", c)).status).toBe("prepared");
  await getPrisma().rundown.delete({ where: { id: showId } });
  expect((await call("execute", c)).status).toBe("rejected");
  expect(
    messages.filter((type) => type === "execute-propresenter-command"),
  ).toHaveLength(0);
});
