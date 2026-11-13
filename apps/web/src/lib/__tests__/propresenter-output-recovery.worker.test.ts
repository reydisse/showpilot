import { env } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { seedRelayMember } from "@/test/relay-fixtures";
import { nextFixtureAddress } from "@/test/fixture-address";
import { getAuth } from "../auth";
import { getPrisma } from "../db";
import {
  handleMobileApi,
  type MobileApiEnvironment,
} from "../mobile-api.server";
import { applySettingWrite } from "../setting-writes.server";
import {
  readProPresenterOutputSnapshot,
  writeProPresenterOutput,
} from "../propresenter-output.server";
import { rundownRelayKey } from "../rundown-relay-key";
import { hashRundownPin } from "../rundown-pin-crypto";
import * as pinCrypto from "../rundown-pin-crypto";
import { buildCompanionDeps } from "../companion-api";
import { setProPresenterStageDisplayForOrg } from "../rundown";

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
afterEach(() => { vi.restoreAllMocks(); return abortAllDurableObjects(); });
let orgId = "",
  showId = "",
  userId = "",
  cookie = "";
beforeEach(async () => {
  orgId = crypto.randomUUID();
  showId = crypto.randomUUID();
  ({ userId } = await seedRelayMember(orgId));
  const password = "Disposable-output-recovery-password-92!";
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
      name: "Output fixture",
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
});
async function call(
  body?: object,
  environment: MobileApiEnvironment = env,
  pin?: string,
) {
  const response = await handleMobileApi(
    new Request(
      `https://app.showpilot.tech/api/mobile/v1/propresenter/output?orgId=${orgId}`,
      {
        method: body ? "POST" : "GET",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
          ...(pin ? { "x-showpilot-rundown-pin": pin } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    ),
    environment,
  );
  if (!response) throw new Error("Missing output route");
  return { status: response.status, body: await response.json() };
}
async function savedOutput() {
  return (
    await env.DB.prepare(
      "SELECT value FROM app_setting WHERE orgId=? AND key='propresenter-stage-display'",
    )
      .bind(orgId)
      .first<{ value: string }>()
  )?.value;
}
it("does not replay a recovered output request over a later operator's setting", async () => {
  const original = {
    orgId,
    userId,
    requestId: crypto.randomUUID(),
    expectedRevision: null,
    enabled: true,
    expiresAt: Date.now() + 10_000,
  };
  expect((await call(original)).status).toBe(200);
  // Another surface changes the same workspace output while the first reply is lost.
  await env.DB.prepare(
    "UPDATE app_setting SET value='false' WHERE orgId=? AND key='propresenter-stage-display'",
  )
    .bind(orgId)
    .run();
  expect((await call(original)).status).toBe(200);
  expect(await savedOutput()).toBe("false");
});
it("rejects the old blind boolean write instead of silently bypassing recovery", async () => {
  expect((await call({ enabled: true })).status).toBe(400);
  expect(await savedOutput()).toBeUndefined();
});
it("does not accept a stale review after Settings changes away and back", async () => {
  const first = {
    orgId,
    userId,
    requestId: crypto.randomUUID(),
    expectedRevision: null,
    enabled: true,
    expiresAt: Date.now() + 5_000,
  };
  expect((await call(first)).status).toBe(200);
  const reviewed = await readProPresenterOutputSnapshot(env.DB, orgId);
  for (const [expectedValue, value] of [
    ["true", "false"],
    ["false", "true"],
  ]) {
    await applySettingWrite(
      env.DB,
      {
        orgId,
        key: "propresenter-stage-display",
        value,
        expectedValue,
        requestId: crypto.randomUUID(),
      },
      userId,
    );
  }
  const result = await call({
    ...first,
    requestId: crypto.randomUUID(),
    enabled: false,
    expectedRevision: reviewed.revision,
  });
  expect(result).toMatchObject({ status: 200, body: { outcome: "conflict" } });
  expect(await savedOutput()).toBe("true");
});
it("expires a delayed first delivery without touching the output", async () => {
  const command = {
    orgId,
    userId,
    requestId: crypto.randomUUID(),
    expectedRevision: null,
    enabled: true,
    expiresAt: Date.now() - 1,
  };
  expect(await call(command)).toMatchObject({
    status: 200,
    body: { outcome: "expired" },
  });
  expect(await call(command)).toMatchObject({
    status: 200,
    body: { outcome: "expired" },
  });
  expect(await savedOutput()).toBeUndefined();
});
it("rejects a changed payload using the original receipt identity", async () => {
  const command = {
    orgId,
    userId,
    requestId: crypto.randomUUID(),
    expectedRevision: null,
    enabled: true,
    expiresAt: Date.now() + 5_000,
  };
  expect((await call(command)).status).toBe(200);
  expect((await call({ ...command, enabled: false })).status).toBe(503);
  expect(await savedOutput()).toBe("true");
});
it("rejects another actor and workspace before storing anything", async () => {
  const command = {
    orgId,
    userId,
    requestId: crypto.randomUUID(),
    expectedRevision: null,
    enabled: true,
    expiresAt: Date.now() + 5_000,
  };
  expect((await call({ ...command, userId: "someone-else" })).status).toBe(403);
  expect((await call({ ...command, orgId: "another-workspace" })).status).toBe(
    403,
  );
  expect(await savedOutput()).toBeUndefined();
});
it.each(["sm", "pm"])(
  "lets an authorized %s change output without device-control setup",
  async (role) => {
    await env.DB.prepare(
      "UPDATE member SET role=? WHERE organizationId=? AND userId=?",
    )
      .bind(role, orgId, userId)
      .run();
    expect(
      await call({
        orgId,
        userId,
        requestId: crypto.randomUUID(),
        expectedRevision: null,
        enabled: true,
        expiresAt: Date.now() + 5_000,
      }),
    ).toMatchObject({
      status: 200,
      body: { outcome: "applied", snapshot: { enabled: true } },
    });
  },
);
it("keeps read-only members from changing or recovering output", async () => {
  const original = {
    orgId,
    userId,
    requestId: crypto.randomUUID(),
    expectedRevision: null,
    enabled: true,
    expiresAt: Date.now() + 5_000,
  };
  expect((await call(original)).status).toBe(200);
  await env.DB.prepare(
    "UPDATE member SET role='member' WHERE organizationId=? AND userId=?",
  )
    .bind(orgId, userId)
    .run();
  expect((await call(original)).status).toBe(403);
  expect(await savedOutput()).toBe("true");
});
it("pushes a saved output change to an already-connected stage display", async () => {
  const actor = await seedRelayMember(orgId, userId);
  const query = new URLSearchParams({
    orgId,
    showId,
    serviceDate: "2026-11-09",
    access: "control",
    authUserId: userId,
    authSessionId: actor.sessionId,
  });
  const relay = env.RUNDOWN_RELAY.getByName(
    rundownRelayKey(orgId, "2026-11-09", "2026-11-09", showId),
  );
  const initial = await relay.fetch(`https://rundown.test/state?${query}`);
  expect(initial.status).toBe(200);
  await initial.arrayBuffer();
  const preview = await relay.fetch(
    new Request(`https://rundown.test/command?${query}`, {
      method: "POST",
      body: JSON.stringify({
        action: "pp-preview",
        payload: {
          slide: {
            text: "Held fixture lyric",
            presentationName: "Fixture",
            notes: "",
            isScripture: false,
          },
        },
      }),
    }),
  );
  expect(preview.status).toBe(200);
  await preview.arrayBuffer();
  const displayQuery = new URLSearchParams({
    orgId,
    showId,
    serviceDate: "2026-11-09",
    display: "1",
  });
  const response = await relay.fetch(
    new Request(`https://rundown.test/ws?${displayQuery}`, {
      headers: { Upgrade: "websocket" },
    }),
  );
  const socket = response.webSocket;
  if (!socket) throw new Error("Missing fixture socket");
  socket.accept();
  const frames: Array<{
    type: string;
    state?: { ppSlide?: { text: string } | null };
  }> = [];
  socket.addEventListener("message", (event) => {
    frames.push(JSON.parse(String(event.data)));
  });
  const original = {
    orgId,
    userId,
    requestId: crypto.randomUUID(),
    expectedRevision: null,
    enabled: true,
    expiresAt: Date.now() + 5_000,
  };
  expect((await call(original)).status).toBe(200);
  await vi.waitFor(() =>
    expect(
      frames.some(
        (frame) => frame.state?.ppSlide?.text === "Held fixture lyric",
      ),
    ).toBe(true),
  );
  frames.length = 0;
  const current = await readProPresenterOutputSnapshot(env.DB, orgId);
  expect(
    (
      await call({
        ...original,
        requestId: crypto.randomUUID(),
        enabled: false,
        expectedRevision: current.revision,
      })
    ).status,
  ).toBe(200);
  await vi.waitFor(() =>
    expect(frames.some((frame) => frame.state?.ppSlide === null)).toBe(true),
  );
  socket.close();
});
it("recovers a committed setting after live-delivery failure without writing it again", async () => {
  const original = {
    orgId,
    userId,
    requestId: crypto.randomUUID(),
    expectedRevision: null,
    enabled: true,
    expiresAt: Date.now() + 5_000,
  };
  const unavailable = {
    ...env,
    RUNDOWN_RELAY: {
      idFromName: env.RUNDOWN_RELAY.idFromName.bind(env.RUNDOWN_RELAY),
      get: env.RUNDOWN_RELAY.get.bind(env.RUNDOWN_RELAY),
      getByName: () => ({
        fetch: async () => {
          throw new Error("Lost relay acknowledgement");
        },
      }),
    },
  };
  expect((await call(original, unavailable)).status).toBe(503);
  const saved = await readProPresenterOutputSnapshot(env.DB, orgId);
  expect(saved.enabled).toBe(true);
  expect(await call(original)).toMatchObject({
    status: 200,
    body: { outcome: "applied", snapshot: { revision: saved.revision } },
  });
  expect(await call()).toMatchObject({
    status: 200,
    body: { enabled: true, revision: saved.revision },
  });
});
it("checks membership again in the transaction that claims and writes output", async () => {
  const actor = await seedRelayMember(orgId, userId);
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === "batch")
        return async (statements: D1PreparedStatement[]) => {
          await target
            .prepare(
              "UPDATE member SET role='member' WHERE organizationId=? AND userId=?",
            )
            .bind(orgId, userId)
            .run();
          return target.batch(statements);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(
    writeProPresenterOutput(
      db,
      {
        orgId,
        userId,
        requestId: crypto.randomUUID(),
        expectedRevision: null,
        enabled: true,
        expiresAt: Date.now() + 5_000,
      },
      { ...actor, rundownPin: null },
    ),
  ).rejects.toThrow("access changed");
  expect(await savedOutput()).toBeUndefined();
});
it("records an invalid future deadline as terminal instead of allowing a later replay", async () => {
  const command = {
    orgId,
    userId,
    requestId: crypto.randomUUID(),
    expectedRevision: null,
    enabled: true,
    expiresAt: Date.now() + 60_000,
  };
  expect(await call(command)).toMatchObject({
    status: 200,
    body: { outcome: "expired" },
  });
  const receipt = await env.DB.prepare(
    "SELECT value FROM app_setting WHERE orgId=? AND key=?",
  )
    .bind(orgId, `pp-output-command:${userId}:${command.requestId}`)
    .first<{ value: string }>();
  expect(JSON.parse(receipt?.value ?? "null")).toMatchObject({
    outcome: "expired",
  });
  expect(await call(command)).toMatchObject({
    status: 200,
    body: { outcome: "expired" },
  });
  expect(await savedOutput()).toBeUndefined();
});
it("rejects a PIN configuration change between verification and the output commit", async () => {
  const actor = await seedRelayMember(orgId, userId);
  await env.DB.prepare("UPDATE member SET role='tm' WHERE organizationId=? AND userId=?").bind(orgId, userId).run();
  // Independent existing 210,000-iteration hash for 2468; no reduced work factor.
  await env.DB.prepare("INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,'rundown-pin',?)")
    .bind(crypto.randomUUID(), orgId, "pbkdf2-sha256:210000:MDEyMzQ1Njc4OWFiY2RlZg:dn1Cq81hnTfBlkh2maxSEZ3GzIkOQC9w2mVohTIJ_uo").run();
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        await target.prepare("UPDATE app_setting SET value='rotated-pin' WHERE orgId=? AND key='rundown-pin'").bind(orgId).run();
        return target.batch(statements);
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(writeProPresenterOutput(db, {
    orgId, userId, requestId: crypto.randomUUID(), expectedRevision: null, enabled: true, expiresAt: Date.now() + 5_000,
  }, { ...actor, rundownPin: "2468" })).rejects.toThrow("access changed");
  expect(await savedOutput()).toBeUndefined();
});
it("requires the configured TM PIN for both reads and writes", async () => {
  await env.DB.prepare(
    "UPDATE member SET role='tm' WHERE organizationId=? AND userId=?",
  )
    .bind(orgId, userId)
    .run();
  await env.DB.prepare(
    "INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,'rundown-pin',?)",
  )
    .bind(crypto.randomUUID(), orgId, await hashRundownPin("2468"))
    .run();
  const verify = vi.spyOn(pinCrypto, "verifyStoredRundownPin");
  expect((await call()).status).toBe(401);
  expect(verify).toHaveBeenCalledTimes(1);
  const command = {
    orgId,
    userId,
    requestId: crypto.randomUUID(),
    expectedRevision: null,
    enabled: true,
    expiresAt: Date.now() + 5_000,
  };
  expect((await call(command, env, "0000")).status).toBe(401);
  expect(verify).toHaveBeenCalledTimes(2);
  expect(await call({ ...command, requestId: crypto.randomUUID(), expiresAt: Date.now() + 5_000 }, env, "2468")).toMatchObject({
    status: 200,
    body: { outcome: "applied" },
  });
  expect(verify).toHaveBeenCalledTimes(3);
  expect(await call(undefined, env, "2468")).toMatchObject({
    status: 200,
    body: { enabled: true },
  });
  expect(verify).toHaveBeenCalledTimes(4);
}, 15_000); // Multiple real PBKDF2 checks, matching the Worker PIN crypto suite.
it.each(["companion", "fallback"])(
  "advances the shared revision for the %s writer",
  async (writer) => {
    const original = {
      orgId,
      userId,
      requestId: crypto.randomUUID(),
      expectedRevision: null,
      enabled: true,
      expiresAt: Date.now() + 5_000,
    };
    expect((await call(original)).status).toBe(200);
    const reviewed = await readProPresenterOutputSnapshot(env.DB, orgId);
    if (writer === "companion")
      await buildCompanionDeps().setLyrics(orgId, false);
    else await setProPresenterStageDisplayForOrg(orgId, false);
    const later = await readProPresenterOutputSnapshot(env.DB, orgId);
    expect(later.enabled).toBe(false);
    expect(later.revision).not.toBe(reviewed.revision);
    expect(
      await call({
        ...original,
        requestId: crypto.randomUUID(),
        expectedRevision: reviewed.revision,
      }),
    ).toMatchObject({
      status: 200,
      body: { outcome: "conflict", snapshot: { enabled: false } },
    });
  },
);
