import { env } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { seedRelayMember } from "@/test/relay-fixtures";
import { nextFixtureAddress } from "@/test/fixture-address";
import { getAuth } from "../auth";
import { getPrisma } from "../db";
import type { ProPresenterOutputCommand } from "@showpilot/shared/propresenter-output";
import {
  getProPresenterOutput,
  changeProPresenterOutput,
} from "../propresenter-output";
import { updateOrgSetting } from "../settings";

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
beforeEach(async () => {
  orgId = crypto.randomUUID();
  showId = crypto.randomUUID();
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
});

const scope = () => ({ orgId, userId, surface: "rundown" as const });
const command = (): ProPresenterOutputCommand & { surface: "rundown" } => ({
  ...scope(),
  requestId: crypto.randomUUID(),
  enabled: true,
  expectedRevision: null,
  expiresAt: Date.now() + 5_000,
});
const read = () => getProPresenterOutput({ data: scope() });
const write = (data = command()) => changeProPresenterOutput({ data });
async function role(value: string) {
  await env.DB.prepare(
    "UPDATE member SET role=? WHERE organizationId=? AND userId=?",
  )
    .bind(value, orgId, userId)
    .run();
}
it("lets a control-only PM read and change output without a device connection", async () => {
  expect(await read()).toMatchObject({ enabled: false, revision: null });
  expect(await write()).toMatchObject({
    outcome: "applied",
    snapshot: { enabled: true },
  });
});
it("requires Settings permission independently of rundown control", async () => {
  await expect(
    getProPresenterOutput({ data: { ...scope(), surface: "settings" } }),
  ).rejects.toThrow();
  await expect(
    changeProPresenterOutput({ data: { ...command(), surface: "settings" } }),
  ).rejects.toThrow();
  expect((await read()).enabled).toBe(false);
  await role("owner");
  expect(
    await changeProPresenterOutput({
      data: { ...command(), surface: "settings" },
    }),
  ).toMatchObject({ outcome: "applied" });
});
it("recovers a Rundown command from Settings without overwriting a later native change", async () => {
  await role("owner");
  const original = command();
  const first = await write(original);
  await write({
    ...command(),
    expectedRevision: first.snapshot.revision,
    enabled: false,
  });
  const recovered = await changeProPresenterOutput({
    data: { ...original, surface: "settings" },
  });
  expect(recovered).toMatchObject({
    requestId: original.requestId,
    outcome: "superseded",
    snapshot: { enabled: false },
  });
  expect((await read()).enabled).toBe(false);
});
it("rejects forged actors, cross-org reads, old payloads and generic Settings writes", async () => {
  await role("owner");
  await expect(write({ ...command(), userId: "other" })).rejects.toThrow();
  await expect(
    getProPresenterOutput({ data: { ...scope(), orgId: "other" } }),
  ).rejects.toThrow();
  // Exercise validators with intentionally obsolete RPC input.
  await expect(async () =>
    changeProPresenterOutput({ data: { orgId, enabled: true } }),
  ).rejects.toThrow();
  await expect(async () =>
    updateOrgSetting({
      data: {
        orgId,
        key: "propresenter-stage-display",
        value: "true",
        expectedValue: null,
        requestId: crypto.randomUUID(),
      },
    }),
  ).rejects.toThrow();
  expect((await read()).enabled).toBe(false);
});
it("checks live membership and the session again for recovery", async () => {
  const original = command();
  await write(original);
  await role("member");
  await expect(write(original)).rejects.toThrow();
  await expect(read()).rejects.toThrow();
  await role("pm");
  await env.DB.prepare("DELETE FROM session WHERE userId=?").bind(userId).run();
  await expect(write(original)).rejects.toThrow();
  await expect(read()).rejects.toThrow();
});
it("rejects changed receipt payloads and expires delayed first delivery", async () => {
  const original = command();
  await write(original);
  await expect(write({ ...original, enabled: false })).rejects.toThrow(
    "different output",
  );
  expect(
    await write({ ...command(), enabled: false, expiresAt: Date.now() - 1 }),
  ).toMatchObject({ outcome: "expired", snapshot: { enabled: true } });
});
