import { env } from "cloudflare:workers";
import { TimecodeRelay } from "@/durable-objects/TimecodeRelay";
import {
  abortAllDurableObjects,
  evictDurableObject,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { timecodeFixture } from "@/test/timecode-fixtures";
import { openTestBridge } from "@/test/bridge-fixtures";
import { framesToTimecode } from "@/lib/timecode";
import type { AutomationEvent, TimecodeState } from "@/types/timecode";

afterEach(async () => {
  vi.restoreAllMocks();
  await abortAllDurableObjects();
});
const format = { frameRate: 30, dropFrame: "ndf" } as const;
const cue = {
  id: "cue",
  label: "Compensated cue",
  action: "lyrics-clear",
  triggerTimecode: framesToTimecode(300, format),
  payload: {},
  toleranceFrames: 0,
};

async function timeline() {
  const fixture = await timecodeFixture();
  const command = async (action: string, payload?: unknown, status = 200) => {
    const response = await fixture.stub.fetch(fixture.url("/command"), {
      method: "POST",
      body: JSON.stringify({ action, payload }),
    });
    expect(response.status).toBe(status);
    return response.json();
  };
  return {
    ...fixture,
    command,
    events: () =>
      fixture.stub
        .fetch(fixture.url("/events"))
        .then((response) => response.json<AutomationEvent[]>()),
    state: () =>
      fixture.stub
        .fetch(fixture.url("/state"))
        .then((response) => response.json<TimecodeState>()),
    feed: (frame: number) =>
      command("feed-tc", { timecode: framesToTimecode(frame, format), format }),
    device: async (
      id: string,
      latencyMs: number,
      category = "video",
      orgId = fixture.orgId,
    ) => {
      await env.DB.prepare(
        "INSERT INTO device (id,orgId,name,category,adapterType,settings,enabled,latencyMs,createdAt,updatedAt) VALUES (?,?,?,?,'atem','{}',1,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
      )
        .bind(id, orgId, id, category, latencyMs)
        .run();
    },
  };
}

it.each([-1, 0.5, 60001, null, "100"])(
  "rejects invalid cue lead %s on add, update and atomic replacement",
  async (leadMs) => {
    const test = await timeline();
    await test.command("add-event", { ...cue, leadMs }, 400);
    expect(await test.events()).toEqual([]);
    await test.command("replace-event-group", {
      sourceKey: "group",
      events: [cue],
    });
    const before = await test.events();
    await test.command(
      "replace-event-group",
      {
        sourceKey: "group",
        events: [
          { ...cue, id: "valid" },
          { ...cue, id: "invalid", leadMs },
        ],
      },
      400,
    );
    await test.command(
      "update-event",
      { id: cue.id, updates: { leadMs } },
      400,
    );
    expect(await test.events()).toEqual(before);
  },
);

it("lets Stop cancel a source start while timing preparation is pending", async () => {
  const test = await timeline();
  await runInDurableObject(test.stub, async (instance, ctx) => {
    let release = () => {};
    let entered = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const preparing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const put = ctx.storage.put.bind(ctx.storage);
    const spy = vi
      .spyOn(ctx.storage, "put")
      .mockImplementationOnce(async (entries, options) => {
        entered();
        await pending;
        await put(entries, options);
      });
    const request = (action: string) =>
      new Request(test.url("/command"), {
        method: "POST",
        body: JSON.stringify({ action }),
      });
    const starting = instance.fetch(request("start"));
    try {
      await preparing;
      expect((await instance.fetch(request("stop"))).status).toBe(200);
    } finally {
      release();
    }
    expect((await starting).status).toBe(400);
    spy.mockRestore();
    expect(
      await (await instance.fetch(new Request(test.url("/state")))).json(),
    ).toMatchObject({ running: false, signal: { status: "idle" } });
  });
});

it("enforces the device latency range and whole milliseconds in D1", async () => {
  const test = await timeline();
  await test.device("bounded", 0);
  for (const latency of [-1, 0.5, 60001, null, "invalid"]) {
    await expect(
      env.DB.prepare(
        "UPDATE device SET latencyMs = ? WHERE id = 'bounded' AND orgId = ?",
      )
        .bind(latency, test.orgId)
        .run(),
    ).rejects.toThrow();
  }
  expect(
    await env.DB.prepare(
      "SELECT latencyMs FROM device WHERE id = 'bounded' AND orgId = ?",
    )
      .bind(test.orgId)
      .first("latencyMs"),
  ).toBe(0);
});

it("orders cues sharing an output by compensated dispatch time when one feed crosses both", async () => {
  const test = await timeline();
  const graphics = env.LOWER_THIRDS_RELAY.getByName(test.orgId);
  await test.command("add-event", {
    ...cue,
    id: "clear",
    action: "lower-third-clear",
  });
  await test.command("add-event", {
    ...cue,
    id: "show",
    action: "lower-third-show",
    leadMs: 100,
    triggerTimecode: framesToTimecode(301, format),
    payload: { line1: "Shown early, then cleared" },
  });
  await test.command("start");
  await test.feed(297);
  await test.feed(300);
  expect((await test.events()).every((event) => event.fired)).toBe(true);
  expect(
    await (await graphics.fetch("https://test/current")).json(),
  ).toMatchObject({ current: null });
});

it("fires at the compensated crossing exactly once while preserving nominal time and zero-tolerance semantics", async () => {
  const test = await timeline();
  await test.command("add-event", {
    ...cue,
    leadMs: 1000,
    deviceLatencyMs: 60000,
    dispatchFrame: 0,
    timingDeviceId: "forged",
  });
  expect((await test.events())[0]).toMatchObject({
    leadMs: 1000,
    deviceLatencyMs: 0,
    dispatchFrame: 270,
    triggerFrame: 300,
  });
  expect((await test.events())[0].timingDeviceId).toBeUndefined();
  await test.command("start");
  await test.feed(260);
  await test.feed(269);
  expect((await test.events())[0].fired).toBe(false);
  await test.feed(271);
  await test.feed(300);
  expect((await test.events())[0]).toMatchObject({
    fired: true,
    executionAttempts: 1,
    triggerTimecode: cue.triggerTimecode,
    triggerFrame: 300,
  });
  await test.command("update-event", {
    id: cue.id,
    updates: { leadMs: 500, deviceLatencyMs: 60000, dispatchFrame: 0 },
  }, 400);
  const unchanged = (await test.events())[0];
  expect(unchanged.leadMs).not.toBe(500);
  await test.command("update-event", { id: cue.id, updates: { leadMs: 500 } });
  expect((await test.events())[0]).toMatchObject({
    fired: true,
    leadMs: 500,
    deviceLatencyMs: 0,
    dispatchFrame: 285,
    executionAttempts: 1,
  });
});

it("captures org-scoped device latency at source start, retains it across eviction, and refreshes only on re-arm or restart", async () => {
  const test = await timeline();
  const other = await timeline();
  await test.device("mine", 200);
  await other.device("theirs", 900);
  await test.command("add-event", {
    ...cue,
    action: "device-action",
    targetDeviceId: "mine",
    leadMs: 100,
    enabled: false,
  });
  await test.command("add-event", {
    ...cue,
    id: "foreign",
    action: "device-action",
    targetDeviceId: "theirs",
    enabled: false,
  });
  await test.command("start");
  await test.feed(0);
  expect((await test.events())[0]).toMatchObject({
    deviceLatencyMs: 200,
    dispatchFrame: 291,
    timingDeviceId: "mine",
  });
  expect((await test.events())[1]).toMatchObject({
    deviceLatencyMs: 0,
    dispatchFrame: 300,
  });
  await env.DB.prepare(
    "UPDATE device SET latencyMs = 500 WHERE id = 'mine' AND orgId = ?",
  )
    .bind(test.orgId)
    .run();
  await test.feed(1);
  await evictDurableObject(test.stub);
  await test.feed(2);
  expect((await test.events())[0]).toMatchObject({
    deviceLatencyMs: 200,
    dispatchFrame: 291,
  });
  await test.command("set-triggers-enabled", { enabled: false });
  await test.command("set-triggers-enabled", { enabled: true });
  expect((await test.events())[0]).toMatchObject({
    deviceLatencyMs: 500,
    dispatchFrame: 282,
  });
  await env.DB.prepare(
    "UPDATE device SET latencyMs = 100 WHERE id = 'mine' AND orgId = ?",
  )
    .bind(test.orgId)
    .run();
  await test.command("stop");
  await test.command("start");
  expect((await test.events())[0]).toMatchObject({
    deviceLatencyMs: 100,
    dispatchFrame: 294,
  });
});

it("captures timing for native LTC without a browser Start and clamps lead before zero", async () => {
  const test = await timeline();
  await test.device("lights", 200, "lighting");
  await test.command("add-event", {
    ...cue,
    id: "lighting",
    action: "lighting-scene",
    enabled: false,
  });
  await test.command("add-event", {
    ...cue,
    id: "zero",
    triggerTimecode: framesToTimecode(1, format),
    leadMs: 1000,
  });
  // Native Bridge prepares the bound room before forwarding each sample.
  expect(await test.stub.bindShow(test.target)).toEqual({ ok: true });
  const response = await test.stub.fetch(test.url("/internal/bridge-feed"), {
    method: "POST",
    headers: { "x-showpilot-internal-secret": env.BETTER_AUTH_SECRET },
    body: JSON.stringify({
      payload: {
        source: "ltc-bridge",
        timecode: framesToTimecode(0, format),
        format,
      },
    }),
  });
  expect(response.status).toBe(200);
  expect(
    (await test.events()).find((event) => event.id === "zero"),
  ).toMatchObject({ dispatchFrame: 0, fired: true });
  expect(
    (await test.events()).find((event) => event.id === "lighting"),
  ).toMatchObject({
    dispatchFrame: 294,
    deviceLatencyMs: 200,
    timingDeviceId: "lights",
  });
});

it("drops a native frame delayed by room preparation but still forwards transport Stop", async () => {
  const test = await timeline();
  const bridge = await openTestBridge(test.orgId);
  await test.command("add-event", {
    ...cue,
    triggerTimecode: framesToTimecode(0, format),
  });
  let prepared = false;
  const bind = TimecodeRelay.prototype.bindShow;
  const spy = vi.spyOn(TimecodeRelay.prototype, "bindShow");
  const delayBinding = () =>
    spy.mockImplementationOnce(async function (this: TimecodeRelay, ...args) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      const result = await bind.call(this, ...args);
      prepared = true;
      return result;
    });
  await delayBinding();
  bridge.socket.send(
    JSON.stringify({
      type: "timecode-feed",
      timecode: framesToTimecode(0, format),
      format,
    }),
  );
  await expect.poll(() => prepared, { timeout: 3000 }).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(await test.state()).toMatchObject({
    running: false,
    signal: { status: "idle" },
  });
  expect((await test.events())[0].fired).toBe(false);
  bridge.socket.send(
    JSON.stringify({
      type: "timecode-feed",
      timecode: framesToTimecode(1, format),
      format,
    }),
  );
  await expect.poll(async () => (await test.state()).totalFrames).toBe(1);
  expect((await test.events())[0].fired).toBe(false);
  await delayBinding();
  bridge.socket.send(
    JSON.stringify({ type: "timecode-transport", state: "stopped" }),
  );
  await expect
    .poll(async () => (await test.state()).signal?.status, { timeout: 3000 })
    .toBe("midi-stopped");
});

it("bounds transient retries by the compensated frame rather than the nominal cue", async () => {
  const test = await timeline();
  const graphics = env.LOWER_THIRDS_RELAY.getByName(test.orgId);
  await graphics.fetch(
    new Request("https://test/test/status", { method: "POST", body: "503" }),
  );
  await test.command("add-event", {
    ...cue,
    action: "lower-third-show",
    payload: { line1: "Test" },
    leadMs: 1000,
    toleranceFrames: 10,
  });
  await test.command("start");
  await test.feed(270);
  await test.feed(271);
  expect((await test.events())[0].executionAttempts).toBe(2);
  await test.feed(281);
  await test.feed(300);
  expect((await test.events())[0]).toMatchObject({
    executionAttempts: 2,
    fired: false,
  });
});
