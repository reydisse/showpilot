import { env } from "cloudflare:workers";
import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { timecodeFixture } from "@/test/timecode-fixtures";
import type { AutomationEvent, TimecodeState } from "@/types/timecode";

afterEach(() => abortAllDurableObjects());
const feed = (frames: number) => ({ timecode: { hours: 0, minutes: 0, seconds: 0, frames }, format: { frameRate: 30, dropFrame: "ndf" } });
async function fixture() {
  const test = await timecodeFixture();
  const command = async (action: string, payload?: unknown) => {
    const response = await test.stub.fetch(test.url("/command"), { method: "POST", body: JSON.stringify({ action, payload }) });
    const value = await response.json(); expect(response.status, JSON.stringify(value)).toBe(200);
  };
  const internal = async (kind: "feed" | "transport", payload: unknown) => {
    const response = await test.stub.fetch(test.url(`/internal/bridge-${kind}`), { method: "POST", headers: { "x-showpilot-internal-secret": env.BETTER_AUTH_SECRET }, body: JSON.stringify({ payload }) });
    expect(response.status).toBe(200); await response.arrayBuffer();
  };
  return { ...test, command, internal,
    state: async () => (await test.stub.fetch(test.url("/state"))).json<TimecodeState>(),
    events: async () => (await test.stub.fetch(test.url("/events"))).json<AutomationEvent[]>(),
  };
}

it("DAW Stop holds through eviction, rejects trailing frames, and Continue resync skips intervening cues", async () => {
  const test = await fixture();
  for (const frames of [2, 3]) await test.command("add-event", { id: `cue-${frames}`, label: "Transport test", action: "lyrics-clear", triggerTimecode: feed(frames).timecode, payload: {}, toleranceFrames: 0 });
  await test.command("set-source", { source: "mtc" }); await test.command("start");
  await test.command("feed-tc", feed(1));
  const live = await test.state();
  await test.command("mtc-transport", { state: "stopped" });
  await test.command("feed-tc", feed(2));
  await evictDurableObject(test.stub);
  expect(await test.state()).toMatchObject({ running: false, totalFrames: 1, signal: { status: "midi-stopped", lastFeedAt: live.signal?.lastFeedAt } });
  expect(await runInDurableObject(test.stub, (_instance, ctx) => ctx.storage.getAlarm())).toBeGreaterThan(Date.now() + 20_000);
  expect((await test.events()).every(event => !event.fired)).toBe(true);
  await test.command("mtc-transport", { state: "waiting" });
  expect(await test.state()).toMatchObject({ running: false, signal: { status: "midi-waiting" } });
  await test.command("feed-tc", feed(3));
  expect(await test.state()).toMatchObject({ running: true, totalFrames: 3, signal: { status: "live" } });
  expect((await test.events()).map(event => [event.id, event.fired])).toEqual([["cue-2", false], ["cue-3", true]]);
  await test.command("mtc-transport", { state: "stopped" }); await test.command("mtc-transport", { state: "waiting" });
  await test.command("feed-tc", feed(0)); await test.command("feed-tc", feed(3));
  expect((await test.events()).find(event => event.id === "cue-3")?.executionAttempts).toBe(1);
  test.controlSocket?.close();
});

it("rejects transport changes without an MTC producer and rejects malformed native transport", async () => {
  const test = await fixture();
  const response = await test.stub.fetch(test.url("/command"), { method: "POST", body: JSON.stringify({ action: "mtc-transport", payload: { state: "stopped" } }) });
  expect(response.status).toBe(400); await response.arrayBuffer();
  for (const secret of [undefined, env.BETTER_AUTH_SECRET]) {
    const response = await test.stub.fetch(test.url("/internal/bridge-transport"), { method: "POST", headers: secret ? { "x-showpilot-internal-secret": secret } : {}, body: JSON.stringify({ payload: { state: "running" } }) });
    expect(response.status).toBe(secret ? 400 : 401); await response.arrayBuffer();
  }
  expect(await test.state()).toMatchObject({ running: false, source: "internal-freerun" });
  test.controlSocket?.close();
});

it("native Stop is durable and does not permit stale feed promotion or stop a browser master", async () => {
  const test = await fixture();
  await test.internal("feed", feed(1));
  await test.internal("transport", { state: "stopped" });
  await evictDurableObject(test.stub);
  await test.internal("feed", feed(2));
  expect(await test.state()).toMatchObject({ running: false, totalFrames: 1, signal: { status: "midi-stopped" } });
  await test.internal("transport", { state: "waiting" });
  await test.internal("feed", feed(3));
  expect(await test.state()).toMatchObject({ running: true, totalFrames: 3 });
  await test.command("start"); await test.command("set-source", { source: "internal-freerun" });
  await test.command("feed-tc", feed(4));
  await test.internal("feed", feed(8));
  await test.internal("transport", { state: "stopped" });
  expect(await test.state()).toMatchObject({ running: true, totalFrames: 4, source: "internal-freerun" });
  await test.internal("feed", feed(9));
  test.controlSocket?.close();
  await expect.poll(async () => (await test.state()).running).toBe(false);
  expect(await test.state()).toMatchObject({ totalFrames: 4 });
});

it("DAW Stop cancels same-output work queued behind an in-flight acknowledgement", async () => {
  const test = await fixture();
  const graphics = env.LOWER_THIRDS_RELAY.getByName(test.orgId);
  await (await graphics.fetch("https://test/test/delay", { method: "POST", body: "800" })).text();
  for (const action of ["lower-third-show", "lower-third-clear"]) await test.command("add-event", { id: action, action, label: action, triggerTimecode: feed(1).timecode, payload: { line1: "Keep visible" } });
  await test.command("set-source", { source: "mtc" }); await test.command("start");
  const firing = test.command("feed-tc", feed(1));
  await expect.poll(async () => (await test.events())[0]?.executionStatus).toBe("dispatching");
  await test.command("mtc-transport", { state: "stopped" });
  await firing;
  expect((await test.events()).map(event => [event.id, event.fired])).toEqual([["lower-third-show", true], ["lower-third-clear", false]]);
  expect(await test.state()).toMatchObject({ running: false, signal: { status: "midi-stopped" } });
  test.controlSocket?.close();
});
