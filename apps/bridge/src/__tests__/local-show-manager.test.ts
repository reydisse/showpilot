import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  parseLocalRundownJournal,
  reconcileLocalRundown,
} from "@showpilot/shared/local-rundown";
import type { RundownTransportCommand } from "@showpilot/shared/rundown-transport";
import type {
  LocalShowAction,
  PreparedLocalShow,
} from "../local-show-model.js";
const vault = vi.hoisted(() => new Map<string, string>());
vi.mock("../credential-store.js", () => ({
  readCredential: (id: string) => vault.get(id),
  writeCredential: (id: string, value: string) => vault.set(id, value),
  deleteCredential: (id: string) => vault.delete(id),
}));
import { LocalShowStore, LocalShowStoreError } from "../local-show-store.js";
import { LocalShowManager } from "../local-show-manager.js";
import { startLocalShowControl } from "../local-show-control.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vault.clear();
});
const at = 1_800_000_000_000;
function preparation(): PreparedLocalShow {
  return {
    version: 1,
    sessionId: "session-1",
    orgId: "org-1",
    installationId: "bridge-1",
    showId: "show-1",
    serviceDate: "2027-01-15",
    title: "Offline service",
    baseRevision: 7,
    preparedAt: at,
    expiresAt: at + 86_400_000,
    items: ["first", "second"].map((id) => ({
      id,
      title: id,
      type: "custom",
      duration: 60000,
      notes: "",
      assignee: "",
      cue: "",
      status: "upcoming",
    })),
    timer: {
      playback: "stop",
      currentItemId: null,
      elapsed: 0,
      startedAt: null,
      pausedAt: null,
      mode: "count-down",
    },
    approvedTargets: [
      { protocol: "http-command", host: "127.0.0.1", port: 8080 },
    ],
    actions: [
      {
        id: "cue-1",
        label: "Device cue",
        deviceId: "device-1",
        protocol: "http-command",
        target: "127.0.0.1:8080",
        command: "POST /go",
        settings: { password: "private-device-password" },
      },
    ],
  };
}
function fixture(
  execute: (
    action: LocalShowAction,
  ) => Promise<"acknowledged" | "failed"> = async () => "acknowledged",
) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "showpilot-local-manager-"),
  );
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "show.json");
  const store = new LocalShowStore(file);
  let now = at;
  const dependencies = {
    store,
    scope: { orgId: "org-1", installationId: "bridge-1" },
    now: () => now,
    activate: vi.fn(async () => {}),
    deactivate: vi.fn(async () => {}),
    execute: vi.fn(execute),
  };
  const manager = new LocalShowManager(dependencies);
  const prepare = (value = preparation()) =>
    manager.prepare(value, value.approvedTargets);
  const begin = () =>
    manager.handle({
      operation: "begin",
      sessionId: "session-1",
      confirmed: true,
    });
  const transport = (
    requestId: string,
    expectedSequence: number,
    command: RundownTransportCommand,
  ) =>
    manager.handle({
      operation: "transport",
      sessionId: "session-1",
      requestId,
      expectedSequence,
      command,
    });
  const device = (
    requestId: string,
    expectedSequence: number,
    actionId = "cue-1",
  ) =>
    manager.handle({
      operation: "device",
      sessionId: "session-1",
      requestId,
      expectedSequence,
      actionId,
    });
  const finish = (expectedSequence: number) =>
    manager.handle({
      operation: "finish",
      sessionId: "session-1",
      expectedSequence,
    });
  return {
    file,
    store,
    dependencies,
    manager,
    prepare,
    begin,
    transport,
    device,
    finish,
    advance: (ms: number) => {
      now += ms;
    },
    restart: () =>
      new LocalShowManager({
        ...dependencies,
        store: new LocalShowStore(file),
      }),
  };
}

it("reconciles actual local timer progress at the exact cloud revision without replaying equipment", async () => {
  const f = fixture();
  const prepared = preparation();
  f.prepare(prepared);
  await f.begin();
  await f.transport("start", 0, { type: "timer-next" });
  f.advance(4000);
  await f.device("light", 1);
  f.advance(2000);
  await f.transport("next", 2, { type: "timer-next" });
  f.advance(3000);
  const finished = await f.finish(3);
  expect(finished).toMatchObject({
    mode: "finished",
    ready: false,
    sequence: 3,
    timer: { playback: "pause", currentItemId: "second", elapsed: 3000 },
  });
  if (!("journal" in finished)) throw new Error("Missing journal");
  const journal = parseLocalRundownJournal(finished.journal, at + 9000);
  expect(journal).not.toBeNull();
  if (!journal) throw new Error("Invalid journal");
  const cloud = reconcileLocalRundown(
    prepared,
    {
      orgId: prepared.orgId,
      showId: prepared.showId,
      serviceDate: prepared.serviceDate,
      revision: 7,
    },
    journal,
  );
  expect(cloud.ok).toBe(true);
  if (cloud.ok)
    expect(cloud.state).toEqual({
      items: finished.items,
      timer: finished.timer,
    });
  expect(
    reconcileLocalRundown(
      prepared,
      {
        orgId: prepared.orgId,
        showId: prepared.showId,
        serviceDate: prepared.serviceDate,
        revision: 8,
      },
      journal,
    ),
  ).toEqual({ ok: false, reason: "revision-conflict" });
  expect(JSON.stringify(journal)).not.toContain("cue-1");
  expect(f.dependencies.execute).toHaveBeenCalledTimes(1);
  expect(f.restart().status()).toEqual(finished);
  expect(() => f.prepare()).toThrow(/Reconcile or explicitly discard/);
  await f.manager.handle({
    operation: "reconciled",
    sessionId: "session-1",
    expectedSequence: 3,
  });
  expect(f.prepare({ ...prepared, sessionId: "session-2" })).toMatchObject({
    mode: "prepared",
    sequence: 0,
  });
});

it("returns saved receipts on retries, rejects reused IDs and stale commands, and redacts private settings", async () => {
  const f = fixture();
  f.prepare();
  await f.begin();
  await f.transport("next", 0, { type: "timer-next" });
  await f.transport("next", 0, { type: "timer-next" });
  expect(f.manager.status()).toMatchObject({
    sequence: 1,
    timer: { currentItemId: "first" },
  });
  await expect(f.transport("next", 1, { type: "timer-stop" })).rejects.toThrow(
    /different local action/,
  );
  await expect(f.transport("stale", 0, { type: "timer-next" })).rejects.toThrow(
    /changed/,
  );
  await expect(f.device("unapproved", 1, "other-cue")).rejects.toThrow(
    /not part/,
  );
  await f.device("fire", 1);
  await f.device("fire", 1);
  expect(f.dependencies.execute).toHaveBeenCalledTimes(1);
  const status = f.manager.status();
  for (const privateValue of [
    "private-device-password",
    "127.0.0.1:8080",
    "POST /go",
    "approvedTargets",
  ])
    expect(JSON.stringify(status)).not.toContain(privateValue);
  const reopened = f.restart();
  await reopened.handle({
    operation: "device",
    sessionId: "session-1",
    requestId: "fire",
    expectedSequence: 1,
    actionId: "cue-1",
  });
  expect(f.dependencies.execute).toHaveBeenCalledTimes(1);
  expect(reopened.status()).toMatchObject({ mode: "active", ready: false });
});

it("keeps timer control responsive during a slow device action and saves the receipt before dispatch", async () => {
  let complete: (value: "acknowledged") => void = () => {};
  const f = fixture(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  f.prepare();
  await f.begin();
  const firing = f.device("pending", 0);
  expect(new LocalShowStore(f.file).load()).toMatchObject({
    session: { entries: [{ requestId: "pending", result: "pending" }] },
  });
  await f.transport("next", 1, { type: "timer-next" });
  await expect(f.device("second", 2)).rejects.toThrow(/pending action/);
  await expect(f.finish(2)).rejects.toThrow(/has not finished/);
  expect(await f.device("pending", 0)).toMatchObject({
    sequence: 2,
    results: [{ result: "pending" }],
  });
  expect(f.dependencies.execute).toHaveBeenCalledTimes(1);
  complete("acknowledged");
  await firing;
  expect(f.manager.status()).toMatchObject({
    sequence: 2,
    timer: { currentItemId: "first" },
    results: [{ result: "acknowledged" }],
  });
});

it("treats interrupted dispatch as unknown after restart and never sends it again", async () => {
  const f = fixture();
  f.prepare();
  await f.begin();
  const saved = f.store.load();
  if (!saved || typeof saved !== "object" || !("session" in saved))
    throw new Error("Missing persisted session");
  // This is the disk image left if the process dies after its pre-dispatch save.
  f.store.save({
    ...saved,
    session: {
      phase: "active",
      startedAt: at,
      entries: [
        {
          kind: "device",
          requestId: "interrupted",
          at,
          actionId: "cue-1",
          result: "pending",
        },
      ],
    },
  });
  const recovered = f.restart();
  expect(recovered.status()).toMatchObject({
    ready: false,
    results: [{ requestId: "interrupted", result: "unknown" }],
  });
  await recovered.handle({
    operation: "begin",
    sessionId: "session-1",
    confirmed: true,
  });
  await recovered.handle({
    operation: "device",
    sessionId: "session-1",
    requestId: "interrupted",
    expectedSequence: 0,
    actionId: "cue-1",
  });
  expect(f.dependencies.execute).not.toHaveBeenCalled();
  expect(f.restart().status()).toMatchObject({
    results: [{ result: "unknown" }],
  });
});

it.each([false, true])(
  "never dispatches if the receipt save fails, committed=%s",
  async (committed) => {
    const f = fixture();
    f.prepare();
    await f.begin();
    const save = f.store.save.bind(f.store);
    vi.spyOn(f.store, "save").mockImplementation((value) => {
      if (committed) save(value);
      throw new LocalShowStoreError(committed);
    });
    await expect(f.device("unsafe", 0)).rejects.toThrow(/could not confirm/);
    expect(f.dependencies.execute).not.toHaveBeenCalled();
    expect(f.manager.status()).toMatchObject({
      ready: false,
      sequence: committed ? 1 : 0,
      storageError: expect.any(String),
    });
    await expect(f.device("unsafe", 0)).rejects.toThrow(/could not confirm/);
    const recovered = f.restart();
    expect(recovered.status()).toMatchObject({ sequence: committed ? 1 : 0 });
    if (committed)
      expect(recovered.status()).toMatchObject({
        results: [{ result: "unknown" }],
      });
  },
);

it("retains an unknown receipt if equipment may have received a command before an error", async () => {
  const f = fixture(async () => {
    throw new Error("private-device-password");
  });
  f.prepare();
  await f.begin();
  const result = await f.device("uncertain", 0);
  expect(result).toMatchObject({ results: [{ result: "unknown" }] });
  expect(JSON.stringify(result)).not.toContain("private-device-password");
  await f.device("uncertain", 0);
  expect(f.dependencies.execute).toHaveBeenCalledTimes(1);
});

it("validates workspace, installation, cached endpoints, timer state, and expiry before local use", async () => {
  const f = fixture();
  const original = preparation();
  expect(() => f.manager.prepare(original, [])).toThrow(/unapproved/);
  for (const changed of [
    { ...original, orgId: "other-org" },
    { ...original, installationId: "other-bridge" },
    {
      ...original,
      actions: [{ ...original.actions[0], target: "127.0.0.2:8080" }],
    },
    {
      ...original,
      actions: [{ ...original.actions[0], settings: { host: "127.0.0.2" } }],
    },
    { ...original, timer: { ...original.timer, playback: "play" } },
    { ...original, items: [original.items[0], original.items[0]] },
  ])
    expect(() =>
      f.manager.prepare(changed, original.approvedTargets),
    ).toThrow();
  f.prepare();
  f.advance(86_400_001);
  await expect(f.begin()).rejects.toThrow(/expired/);
  expect(f.dependencies.activate).not.toHaveBeenCalled();
  expect(
    () =>
      new LocalShowManager({
        ...f.dependencies,
        scope: { orgId: "other-org", installationId: "bridge-1" },
      }),
  ).toThrow(/another workspace/);
});

it("protects pending journals against replacement and requires a finished session before discard", async () => {
  const f = fixture();
  f.prepare();
  await f.begin();
  await expect(
    f.manager.handle({
      operation: "discard",
      sessionId: "session-1",
      confirmed: true,
    }),
  ).rejects.toThrow(/Finish/);
  expect(() =>
    f.prepare({ ...preparation(), sessionId: "replacement" }),
  ).toThrow(/Reconcile/);
  await f.finish(0);
  await expect(
    f.manager.handle({
      operation: "reconciled",
      sessionId: "session-1",
      expectedSequence: 1,
    }),
  ).rejects.toThrow(/changed/);
  await f.manager.handle({
    operation: "discard",
    sessionId: "session-1",
    confirmed: true,
  });
  expect(f.restart().status()).toEqual({ mode: "empty", storageError: null });
});

it("can finish an expired session after a long shutdown and retains a bounded journal for cloud review", async () => {
  const f = fixture();
  f.prepare();
  await f.begin();
  await f.transport("start", 0, { type: "timer-next" });
  f.advance(2 * 86_400_000);
  await expect(f.transport("late", 1, { type: "timer-next" })).rejects.toThrow(
    /24-hour/,
  );
  const finished = await f.finish(1);
  if (!("journal" in finished)) throw new Error("Missing journal");
  expect(
    parseLocalRundownJournal(finished.journal, at + 2 * 86_400_000),
  ).toMatchObject({ endedAt: at + 86_400_000 });
  expect(finished).toMatchObject({
    mode: "finished",
    ready: false,
    timer: { playback: "pause" },
  });
});

it("rejects inconsistent or corrupted journals without opening any equipment", async () => {
  const f = fixture();
  f.prepare();
  await f.begin();
  await f.transport("start", 0, { type: "timer-next" });
  const saved = f.store.load();
  if (!saved || typeof saved !== "object" || !("session" in saved))
    throw new Error("Missing session");
  const malformed = [
    {
      phase: "active",
      startedAt: at,
      entries: [
        {
          kind: "transport",
          requestId: "bad-item",
          at,
          command: { type: "timer-start", itemId: "missing" },
        },
      ],
    },
    {
      phase: "active",
      startedAt: at,
      entries: [
        {
          kind: "device",
          requestId: "unapproved",
          at,
          actionId: "foreign",
          result: "acknowledged",
        },
      ],
    },
    {
      phase: "active",
      startedAt: at,
      entries: [
        {
          kind: "transport",
          requestId: "duplicate",
          at,
          command: { type: "timer-next" },
        },
        {
          kind: "transport",
          requestId: "duplicate",
          at,
          command: { type: "timer-next" },
        },
      ],
    },
    { phase: "finished", startedAt: at, endedAt: at - 1, entries: [] },
  ];
  f.dependencies.activate.mockClear();
  for (const session of malformed) {
    f.store.save({ ...saved, session });
    expect(() => f.restart()).toThrow(/invalid/);
  }
  expect(f.dependencies.activate).not.toHaveBeenCalled();
  expect(f.dependencies.execute).not.toHaveBeenCalled();
});

it("allows independent equipment while one output is pending and never loses concurrent timer writes", async () => {
  let resolveFirst: (value: "acknowledged") => void = () => {};
  const f = fixture((action) =>
    action.id === "cue-1"
      ? new Promise((resolve) => {
          resolveFirst = resolve;
        })
      : Promise.resolve("acknowledged"),
  );
  const prepared = preparation();
  prepared.actions.push({
    ...prepared.actions[0],
    id: "cue-2",
    deviceId: "device-2",
    target: "127.0.0.1:8081",
  });
  prepared.approvedTargets.push({ ...prepared.approvedTargets[0], port: 8081 });
  f.prepare(prepared);
  await f.begin();
  const first = f.device("first-device", 0);
  await f.device("second-device", 1, "cue-2");
  await f.transport("next", 2, { type: "timer-next" });
  resolveFirst("acknowledged");
  await first;
  expect(f.restart().status()).toMatchObject({
    sequence: 3,
    timer: { currentItemId: "first" },
    results: [
      { requestId: "first-device", result: "acknowledged" },
      { requestId: "second-device", result: "acknowledged" },
    ],
  });
});

it("runs native loopback → encrypted manager → equipment and suppresses duplicate HTTP retries", async () => {
  let commands = 0;
  const device = http.createServer((request, response) => {
    if (request.method === "POST" && request.url === "/go") commands++;
    response.end("OK");
  });
  await new Promise<void>((resolve) => device.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        device.close(() => resolve());
        device.closeAllConnections();
      }),
  );
  const address = device.address();
  if (!address || typeof address === "string")
    throw new Error("No device port");
  const f = fixture(async (action) => {
    expect(new LocalShowStore(f.file).load()).toMatchObject({
      session: { entries: [{ kind: "device", result: "pending" }] },
    });
    const response = await fetch(`http://${action.target}/go`, {
      method: "POST",
    });
    await response.text();
    return response.ok ? "acknowledged" : "failed";
  });
  const prepared = preparation();
  prepared.actions[0].target = `127.0.0.1:${address.port}`;
  prepared.approvedTargets[0].port = address.port;
  f.prepare(prepared);
  const token = randomBytes(32).toString("hex");
  const control = await startLocalShowControl(token, (request) =>
    f.manager.handle(request),
  );
  cleanups.push(control.close);
  const request = async (body: unknown) => {
    const response = await fetch(
      `http://127.0.0.1:${control.port}/local-show`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      },
    );
    expect(response.status).toBe(200);
    return response.json();
  };
  await request({
    operation: "begin",
    sessionId: "session-1",
    confirmed: true,
  });
  const fire = {
    operation: "device",
    sessionId: "session-1",
    requestId: "native-fire",
    expectedSequence: 0,
    actionId: "cue-1",
  };
  expect(await request(fire)).toMatchObject({
    ok: true,
    result: { results: [{ result: "acknowledged" }] },
  });
  await request(fire);
  expect(commands).toBe(1);
  expect(fs.readFileSync(f.file, "utf8")).not.toContain(
    "private-device-password",
  );
});

it("does not resurrect a preparation revoked while native ownership is changing", async () => {
  const f = fixture();
  f.prepare();
  let activated: () => void = () => {};
  f.dependencies.activate.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        activated = resolve;
      }),
  );
  const entering = f.begin();
  f.manager.applyCloudPolicy([], false);
  activated();
  await expect(entering).rejects.toThrow(/revoked/);
  expect(f.dependencies.deactivate).toHaveBeenCalledTimes(1);
  expect(f.restart().status()).toMatchObject({ mode: "empty" });
  expect(f.dependencies.execute).not.toHaveBeenCalled();
});
