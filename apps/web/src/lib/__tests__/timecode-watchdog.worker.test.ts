import { abortAllDurableObjects, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { timecodeFixture, startFixtureTimecodeFeed } from "@/test/timecode-fixtures";
import type { TimecodeState, TimecodeWsMessage } from "@/types/timecode";
import { TestTimecodeRelay } from "@/test/worker-entry";

afterEach(() => abortAllDurableObjects());
const format = { frameRate: 30, dropFrame: "ndf" };
const feed = (seconds: number) => ({ timecode: { hours: 0, minutes: 0, seconds, frames: 0 }, format });

async function clock() {
  const test = await timecodeFixture(undefined, undefined, false);
  const response = await test.stub.fetch(test.url("/ws"), { headers: { Upgrade: "websocket" } });
  const socket = response.webSocket;
  if (!socket) throw new Error("Missing timecode socket");
  const messages: TimecodeWsMessage[] = [];
  socket.addEventListener("message", message => { messages.push(JSON.parse(String(message.data))); });
  socket.accept();
  await expect.poll(() => messages.some(message => message.type === "hydrate")).toBe(true);
  socket.send(JSON.stringify({ type: "command", action: "claim-control" }));
  await expect.poll(() => messages.some(message => message.type === "control-status" && message.control === "yours")).toBe(true);
  return {
    ...test, socket, messages,
    state: async () => (await test.stub.fetch(test.url("/state"))).json<TimecodeState>(),
    command: async (action: string, payload?: unknown) => {
      if (action === "feed-tc") await startFixtureTimecodeFeed(test.stub, test.url);
      const response = await test.stub.fetch(test.url("/command"), { method: "POST", body: JSON.stringify({ action, payload }) });
      expect(response.status).toBe(200); await response.arrayBuffer();
    },
    bridge: async (seconds: number) => {
      const response = await test.stub.fetch(test.url("/internal/bridge-feed"), { method: "POST",
        headers: { "x-showpilot-internal-secret": env.BETTER_AUTH_SECRET }, body: JSON.stringify({ payload: feed(seconds) }) });
      expect(response.status).toBe(200); await response.arrayBuffer();
    },
  };
}

it("persists feed position through eviction and broadcasts stall then loss without D1 broadcast polling", async () => {
  const test = await clock();
  await test.command("feed-tc", feed(5));
  const live = await test.state();
  expect(live).toMatchObject({ running: true, totalFrames: 150, signal: { status: "live", lastFeedAt: expect.any(Number) } });
  const snapshot = await runInDurableObject(test.stub, (_instance, ctx) => ctx.storage.get("clock"));
  expect(snapshot).toMatchObject({ previousFeedFrame: 150, state: { signal: live.signal, totalFrames: 150 } });
  await evictDurableObject(test.stub);
  expect(await test.state()).toMatchObject({ totalFrames: 150, signal: { lastFeedAt: live.signal?.lastFeedAt } });
  const queries = await runInDurableObject(test.stub, instance => {
    if (!(instance instanceof TestTimecodeRelay)) throw new Error("Wrong fixture");
    return instance.getQueryCount();
  });
  // Observe actual alarm delivery over the socket, not a direct method invocation.
  await expect.poll(() => test.messages.some(message => message.type === "tc-update" && message.state.signal?.status === "timecode-stalled"), { timeout: 2000 }).toBe(true);
  await expect.poll(() => test.messages.some(message => message.type === "tc-update" && message.state.signal?.status === "timecode-lost"), { timeout: 4000 }).toBe(true);
  const after = await runInDurableObject(test.stub, instance => {
    if (!(instance instanceof TestTimecodeRelay)) throw new Error("Wrong fixture");
    return instance.getQueryCount();
  });
  expect(after).toBe(queries);
  expect(await test.state()).toMatchObject({ running: false, totalFrames: 150, signal: { status: "timecode-lost", lastFeedAt: live.signal?.lastFeedAt } });
  test.socket.close();
});

it("crosses a cue after eviction using the persisted previous frame", async () => {
  const test = await clock();
  await test.command("add-event", { id: "crossing", action: "lyrics-clear", label: "Crossed frame", triggerTimecode: { ...feed(1).timecode, frames: 5 }, payload: {}, toleranceFrames: 0 });
  await test.command("feed-tc", feed(1));
  await evictDurableObject(test.stub);
  await test.command("feed-tc", { ...feed(1), timecode: { ...feed(1).timecode, frames: 8 } });
  expect(await (await test.stub.fetch(test.url("/events"))).json()).toEqual([expect.objectContaining({ id: "crossing", fired: true, executionStatus: "acknowledged" })]);
  test.socket.close();
});

it("retains the socket master through eviction and accepts a genuinely fresh resumed feed without catch-up firing", async () => {
  const test = await clock();
  const feedAt = Date.now();
  const time = vi.spyOn(Date, "now").mockReturnValue(feedAt);
  try {
    test.socket.send(JSON.stringify({ type: "command", action: "start" }));
    await expect.poll(() => test.messages.some(message => message.type === "master-status" && message.granted)).toBe(true);
    test.socket.send(JSON.stringify({ type: "command", action: "feed-tc", payload: feed(1) }));
    await expect.poll(async () => (await test.state()).totalFrames).toBe(30);
    await test.command("add-event", { id: "gap", action: "lyrics-clear", label: "Do not catch up", triggerTimecode: feed(2).timecode, payload: {}, toleranceFrames: 0 });
    await evictDurableObject(test.stub);
    // Test recovery across an explicit gap, independently of runner speed.
    // Automatic alarm delivery is covered separately above.
    time.mockReturnValue(feedAt + 800);
    await runDurableObjectAlarm(test.stub);
    expect(await test.state()).toMatchObject({ running: false, signal: { status: "timecode-stalled" } });
    test.socket.send(JSON.stringify({ type: "command", action: "feed-tc", payload: feed(3) }));
    await expect.poll(async () => (await test.state()).totalFrames).toBe(90);
    expect(await test.state()).toMatchObject({ running: true, signal: { status: "live", lastFeedAt: feedAt + 800 } });
    expect(await (await test.stub.fetch(test.url("/events"))).json()).toEqual([expect.objectContaining({ id: "gap", fired: false })]);
    time.mockReturnValue(feedAt + 1300);
    await runDurableObjectAlarm(test.stub);
    expect(await test.state()).toMatchObject({ running: false, totalFrames: 90, signal: { status: "timecode-stalled" } });
  } finally {
    time.mockRestore();
    test.socket.close();
  }
});

it("keeps a live Bridge feed on standby and promotes it when the operator master disconnects", async () => {
  const test = await clock();
  test.socket.send(JSON.stringify({ type: "command", action: "start" }));
  await expect.poll(() => test.messages.some(message => message.type === "master-status" && message.granted)).toBe(true);
  test.socket.send(JSON.stringify({ type: "command", action: "feed-tc", payload: feed(1) }));
  await expect.poll(async () => (await test.state()).totalFrames).toBe(30);
  await test.bridge(8);
  expect(await test.state()).toMatchObject({ totalFrames: 30 });
  await evictDurableObject(test.stub);
  test.socket.close();
  await expect.poll(async () => (await test.state()).totalFrames).toBe(240);
  expect(await test.state()).toMatchObject({ running: true, source: "mtc", signal: { status: "live" } });
});

it.each(["stale", "disconnected"])("does not promote a %s Bridge feed", async reason => {
  const test = await clock();
  test.socket.send(JSON.stringify({ type: "command", action: "start" }));
  await expect.poll(() => test.messages.some(message => message.type === "master-status" && message.granted)).toBe(true);
  await test.bridge(8);
  if (reason === "stale") await new Promise(resolve => setTimeout(resolve, 550));
  else {
    const disconnected = await test.stub.fetch(test.url("/internal/bridge-disconnected"), { method: "POST", headers: { "x-showpilot-internal-secret": env.BETTER_AUTH_SECRET } });
    expect(disconnected.status).toBe(200); await disconnected.arrayBuffer();
  }
  test.socket.close();
  await expect.poll(async () => (await test.state()).running).toBe(false);
  expect(await test.state()).toMatchObject({ totalFrames: 0, signal: { status: "timecode-stalled" } });
});

it("does not label an intentional Stop as signal loss", async () => {
  const test = await clock();
  await test.command("feed-tc", feed(3));
  await test.command("stop");
  await evictDurableObject(test.stub);
  expect(await test.state()).toMatchObject({ running: false, totalFrames: 90, signal: { status: "idle" } });
  const deadline = await runInDurableObject(test.stub, (_instance, ctx) => ctx.storage.getAlarm());
  expect(deadline).toBeGreaterThan(Date.now() + 20_000);
  test.socket.close();
});

it.each([
  { acknowledgementAge: 800, status: "timecode-stalled" },
  { acknowledgementAge: 2100, status: "timecode-lost" },
])("freezes scheduled same-output work behind an acknowledgement at $status", async ({ acknowledgementAge, status }) => {
  const test = await clock();
  const graphics = env.LOWER_THIRDS_RELAY.getByName(test.orgId);
  const feedAt = Date.now();
  const time = vi.spyOn(Date, "now").mockReturnValue(feedAt);
  try {
    await runInDurableObject(graphics, instance => {
      const fetch = instance.fetch.bind(instance);
      vi.spyOn(instance, "fetch").mockImplementation(request => {
        // Advance during the first output request, before its real acknowledgement.
        // Queue safety must not depend on how fast the runner returns from I/O.
        if (new URL(request.url).pathname === "/internal/trigger") {
          time.mockReturnValue(feedAt + acknowledgementAge);
        }
        return fetch(request);
      });
    });
    for (const action of ["lower-third-show", "lower-third-clear"]) {
      await test.command("add-event", { id: action, action, label: action, triggerTimecode: feed(1).timecode, payload: { line1: "Held on loss" } });
    }
    await test.command("feed-tc", feed(1));
    expect(Date.now()).toBe(feedAt + acknowledgementAge);
    await runDurableObjectAlarm(test.stub);
    expect(await (await test.stub.fetch(test.url("/events"))).json()).toEqual([
      expect.objectContaining({ id: "lower-third-show", fired: true }),
      expect.objectContaining({ id: "lower-third-clear", fired: false, executionStatus: "scheduled" }),
    ]);
    expect(await (await graphics.fetch("https://test/current")).json()).toMatchObject({ current: { line1: "Held on loss" } });
    expect(await test.state()).toMatchObject({ running: false, signal: { status } });
  } finally {
    try {
      await runInDurableObject(graphics, instance => { vi.mocked(instance.fetch).mockRestore(); });
    } finally {
      time.mockRestore();
      test.socket.close();
    }
  }
});
