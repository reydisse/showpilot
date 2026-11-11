import { env } from "cloudflare:workers";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { seedRelayMember } from "@/test/relay-fixtures";
import { getPrisma } from "../db";
import { getAuth } from "../auth";
vi.mock("../push-delivery.server", () => ({
  deliverPushToUser: vi.fn().mockResolvedValue({ sent: 0 }),
}));
const auth = vi.hoisted(() => ({ cookie: "", ip: 0 }));
vi.mock("better-auth/tanstack-start", () => ({
  tanstackStartCookies: () => ({ id: "test-cookie-bridge" }),
}));
vi.mock("@tanstack/react-start/server", () => ({
  getRequestHeaders: () => new Headers({ Cookie: auth.cookie }),
  setResponseHeader: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => {
  const builder = () => {
    let validate = (value: unknown) => value;
    const chain = {
      middleware: () => chain,
      inputValidator: (fn: typeof validate) => {
        validate = fn;
        return chain;
      },
      handler:
        (fn: (input: { data: unknown }) => unknown) =>
        async (input: { data: unknown }) =>
          fn({ data: validate(input.data) }),
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

import { abortAllDurableObjects } from "cloudflare:test";
import {
  writeTmRundown as runTmControl,
  getTmRundownState,
} from "../tm-rundown";
import {
  getRundownPinCookieName,
  RUNDOWN_PIN_SETTING_KEY,
} from "../rundown-pin";
import type { TmRundownAction } from "../tm-rundown-contract";
import { buildCompanionDeps } from "../companion-api";
import { getActiveRundownRelayTarget } from "../active-rundown-relay";
afterEach(async () => {
  await abortAllDurableObjects();
});

let authenticated: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  auth.cookie = "";
  authenticated = await fixture();
});
async function fixture() {
  const { orgId, userId } = await seedRelayMember(crypto.randomUUID());
  const password = "Disposable-crew-password-92!";
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
  const login = await getAuth().handler(
    new Request("https://app.showpilot.tech/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://app.showpilot.tech",
        "cf-connecting-ip": `192.0.2.${++auth.ip}`,
      },
      body: JSON.stringify({ email: `${userId}@example.test`, password }),
    }),
  );
  expect(login.status).toBe(200);
  await login.arrayBuffer();
  auth.cookie = login.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
  const session = await getAuth().api.getSession({
    headers: new Headers({ Cookie: auth.cookie }),
    query: { disableCookieCache: true },
  });
  if (!session) throw new Error("Fixture session missing");
  return { orgId, userId, actor: { userId, sessionId: session.session.id } };
}

const serviceDate = "2026-11-08";
async function show(suffix = "a") {
  const { orgId } = authenticated,
    showId = `${orgId}-${suffix}`;
  await env.DB.prepare(
    "INSERT INTO rundown(id,orgId,serviceDate,name,status,createdAt,updatedAt) VALUES(?,?,?,'TM fixture','draft',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
  )
    .bind(showId, orgId, serviceDate)
    .run();
  await env.DB.prepare(
    "INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,'active-show-id',?) ON CONFLICT(orgId,key) DO UPDATE SET value=excluded.value",
  )
    .bind(crypto.randomUUID(), orgId, showId)
    .run();
  const target = await getActiveRundownRelayTarget(env.DB, orgId),
    deps = buildCompanionDeps({ orgId, target });
  const items = [1, 2, 3].map((n) => ({
    id: `${suffix}-${n}`,
    title: `Item ${n}`,
    type: "segment",
    duration: 60000,
    status: "upcoming",
    sortOrder: n,
    notes: "",
    assignee: "",
    cue: "",
    hardStop: false,
  }));
  await deps.relayCommand(orgId, "seed", { items });
  await deps.relayCommand(orgId, "timer-start", { itemId: items[0].id });
  return { target, deps, items };
}
it("does not advance twice when the operator retries the same lost command", async () => {
  const { target, deps } = await show();
  const data = {
    orgId: authenticated.orgId,
    action: "rundown-next" as const,
    requestId: crypto.randomUUID(),
    target: { showId: target.showId, serviceDate },
    expectedRevision: (
      await getTmRundownState({ data: { orgId: authenticated.orgId } })
    ).revision,
    expiresAt: Date.now() + 5000,
  };
  await runTmControl({ data });
  await runTmControl({ data });
  expect((await deps.relayState(authenticated.orgId)).timer.currentItemId).toBe(
    "a-2",
  );
});
it("does not send an old Next click into a newly selected show", async () => {
  const a = await show(),
    data = {
      orgId: authenticated.orgId,
      action: "rundown-next" as const,
      requestId: crypto.randomUUID(),
      target: { showId: a.target.showId, serviceDate },
      expectedRevision: (
        await getTmRundownState({ data: { orgId: authenticated.orgId } })
      ).revision,
      expiresAt: Date.now() + 5000,
    };
  const b = await show("b");
  await runTmControl({ data }).catch(() => {});
  expect(
    (await b.deps.relayState(authenticated.orgId)).timer.currentItemId,
  ).toBe("b-1");
});
it("does not execute a transport command after its original deadline", async () => {
  const { target, deps } = await show();
  const data = {
    orgId: authenticated.orgId,
    action: "rundown-next" as const,
    requestId: crypto.randomUUID(),
    target: { showId: target.showId, serviceDate },
    expectedRevision: (
      await getTmRundownState({ data: { orgId: authenticated.orgId } })
    ).revision,
    expiresAt: Date.now() - 1000,
  };
  await runTmControl({ data }).catch(() => {});
  expect((await deps.relayState(authenticated.orgId)).timer.currentItemId).toBe(
    "a-1",
  );
});
it("does not grant transport control solely because the member can view the TM dashboard", async () => {
  const { target, deps } = await show();
  await env.DB.prepare(
    "UPDATE member SET role='tm' WHERE organizationId=? AND userId=?",
  )
    .bind(authenticated.orgId, authenticated.userId)
    .run();
  const data = {
    orgId: authenticated.orgId,
    action: "rundown-next" as const,
    requestId: crypto.randomUUID(),
    target: { showId: target.showId, serviceDate },
    expectedRevision: (
      await getTmRundownState({ data: { orgId: authenticated.orgId } })
    ).revision,
    expiresAt: Date.now() + 5000,
  };
  await expect(runTmControl({ data })).rejects.toThrow();
  expect((await deps.relayState(authenticated.orgId)).timer.currentItemId).toBe(
    "a-1",
  );
});

async function command(action: TmRundownAction = "rundown-next") {
  const state = await getTmRundownState({
    data: { orgId: authenticated.orgId },
  });
  return {
    orgId: authenticated.orgId,
    requestId: crypto.randomUUID(),
    action,
    target: state.target,
    expectedRevision: state.revision,
    expiresAt: Date.now() + 5000,
  };
}
it("returns a conflict instead of advancing a newer rundown revision", async () => {
  const { deps } = await show(),
    data = await command();
  await deps.relayCommand(authenticated.orgId, "timer-next");
  expect((await runTmControl({ data })).outcome).toBe("revision-conflict");
  expect((await deps.relayState(authenticated.orgId)).timer.currentItemId).toBe(
    "a-2",
  );
});
it("binds an actor request to its original action and target", async () => {
  const { deps } = await show(),
    data = await command();
  await runTmControl({ data });
  await expect(
    runTmControl({ data: { ...data, action: "timer-stop" } }),
  ).rejects.toThrow("different rundown command");
  expect((await deps.relayState(authenticated.orgId)).timer.playback).toBe(
    "play",
  );
});
it("recovers a missing receipt outcome using the relay duplicate acknowledgement", async () => {
  const { deps } = await show(),
    data = await command();
  await runTmControl({ data });
  await env.DB.prepare(
    "UPDATE tm_rundown_command_receipt SET outcome=NULL WHERE orgId=? AND requestId=?",
  )
    .bind(authenticated.orgId, data.requestId)
    .run();
  expect((await runTmControl({ data })).outcome).toBe("applied");
  expect((await deps.relayState(authenticated.orgId)).timer.currentItemId).toBe(
    "a-2",
  );
});
it("replays a confirmed result after the active show changes without touching either room", async () => {
  const a = await show(),
    data = await command();
  await runTmControl({ data });
  const b = await show("b");
  expect((await runTmControl({ data })).outcome).toBe("applied");
  expect(
    (await a.deps.relayState(authenticated.orgId)).timer.currentItemId,
  ).toBe("a-2");
  expect(
    (await b.deps.relayState(authenticated.orgId)).timer.currentItemId,
  ).toBe("b-1");
});
it("rejects a confirmed End show when the active show changes", async () => {
  const a = await show(),
    data = await command("timer-stop"),
    b = await show("b");
  expect((await runTmControl({ data })).outcome).toBe("target-changed");
  expect((await a.deps.relayState(authenticated.orgId)).timer.playback).toBe(
    "play",
  );
  expect((await b.deps.relayState(authenticated.orgId)).timer.playback).toBe(
    "play",
  );
  const stop = await command("timer-stop");
  expect((await runTmControl({ data: stop })).outcome).toBe("applied");
  expect((await b.deps.relayState(authenticated.orgId)).timer.playback).toBe(
    "stop",
  );
});
it("uses the current PIN and rechecks permission before replaying an acknowledgement", async () => {
  const { orgId, userId } = authenticated,
    { deps } = await show();
  await env.DB.prepare(
    "UPDATE member SET role='tm' WHERE organizationId=? AND userId=?",
  )
    .bind(orgId, userId)
    .run();
  await env.DB.prepare(
    "INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,?,'4381')",
  )
    .bind(crypto.randomUUID(), orgId, RUNDOWN_PIN_SETTING_KEY)
    .run();
  const locked = await getTmRundownState({ data: { orgId } });
  expect(locked.canControl).toBe(false);
  expect(locked.blockedReason).toContain("PIN");
  auth.cookie += `; ${getRundownPinCookieName(orgId)}=4381`;
  const data = await command();
  expect((await getTmRundownState({ data: { orgId } })).canControl).toBe(true);
  expect((await runTmControl({ data })).outcome).toBe("applied");
  await env.DB.prepare(
    "UPDATE app_setting SET value='9911' WHERE orgId=? AND key=?",
  )
    .bind(orgId, RUNDOWN_PIN_SETTING_KEY)
    .run();
  await expect(runTmControl({ data })).rejects.toThrow("PIN");
  expect((await deps.relayState(orgId)).timer.currentItemId).toBe("a-2");
});
it("denies a revoked session and a different organization", async () => {
  await show();
  const data = await command(),
    other = await seedRelayMember(crypto.randomUUID());
  await expect(
    runTmControl({ data: { ...data, orgId: other.orgId } }),
  ).rejects.toThrow("Forbidden");
  await env.DB.prepare("DELETE FROM session WHERE id=?")
    .bind(authenticated.actor.sessionId)
    .run();
  await expect(runTmControl({ data })).rejects.toThrow("Sign in");
});
it("adjusts time once per request and preserves pause when adding time", async () => {
  const { deps } = await show();
  await deps.relayCommand(authenticated.orgId, "timer-pause");
  const before = (await deps.relayState(authenticated.orgId)).timer.elapsed,
    data = await command("timer-add");
  await runTmControl({ data });
  await runTmControl({ data });
  const after = (await deps.relayState(authenticated.orgId)).timer;
  expect(after.playback).toBe("pause");
  expect(after.elapsed).toBe(before - 60000);
  await runTmControl({ data: await command("timer-subtract") });
  expect((await deps.relayState(authenticated.orgId)).timer.elapsed).toBe(
    before,
  );
});
it("starts the first playable row, resumes elapsed time and moves to previous", async () => {
  const { deps, items } = await show();
  await deps.relayCommand(authenticated.orgId, "timer-stop");
  await deps.relayCommand(authenticated.orgId, "seed", {
    force: true,
    items: [{ ...items[0], id: "header", type: "header" }, ...items],
  });
  expect(
    (await runTmControl({ data: await command("timer-start") })).outcome,
  ).toBe("applied");
  expect((await deps.relayState(authenticated.orgId)).timer.currentItemId).toBe(
    "a-1",
  );
  await deps.relayCommand(authenticated.orgId, "timer-pause");
  const elapsed = (await deps.relayState(authenticated.orgId)).timer.elapsed;
  await runTmControl({ data: await command("timer-start") });
  expect((await deps.relayState(authenticated.orgId)).timer.elapsed).toBe(
    elapsed,
  );
  await runTmControl({ data: await command() });
  await runTmControl({ data: await command("rundown-previous") });
  expect((await deps.relayState(authenticated.orgId)).timer.currentItemId).toBe(
    "a-1",
  );
});
it("updates ProPresenter output through the authoritative relay", async () => {
  await show();
  await runTmControl({ data: await command("lyrics-on") });
  expect(
    (await getTmRundownState({ data: { orgId: authenticated.orgId } }))
      .lyricsEnabled,
  ).toBe(true);
  const off = await command("lyrics-off");
  await runTmControl({ data: off });
  await runTmControl({ data: off });
  expect(
    (await getTmRundownState({ data: { orgId: authenticated.orgId } }))
      .lyricsEnabled,
  ).toBe(false);
});
it("never initializes an unprepared room through feedback or controls", async () => {
  const { orgId } = authenticated;
  const state = await getTmRundownState({ data: { orgId } });
  expect(state.initialized).toBe(false);
  expect((await runTmControl({ data: await command() })).outcome).toBe(
    "unavailable",
  );
  expect((await getTmRundownState({ data: { orgId } })).initialized).toBe(
    false,
  );
});
it("recovers simultaneous retries without a second advance", async () => {
  const { deps } = await show(),
    data = await command();
  const results = await Promise.all([
    runTmControl({ data }),
    runTmControl({ data }),
  ]);
  expect(results.map((r) => r.outcome)).toEqual(["applied", "applied"]);
  expect((await deps.relayState(authenticated.orgId)).timer.currentItemId).toBe(
    "a-2",
  );
});
