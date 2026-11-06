import { env } from "cloudflare:workers";
import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { timecodeFixture } from "@/test/timecode-fixtures";
import { timecodeRelayKey } from "../timecode-target.server";
import { cueReviewState } from "../automation-cues";
import type { AutomationEvent, TimecodeState, TimecodeDisplayState } from "@/types/timecode";

afterEach(abortAllDurableObjects);
const zero = { hours: 0, minutes: 0, seconds: 0, frames: 0 };
const format = { frameRate: 30, dropFrame: "ndf" };
const start = { id: "start", action: "timer-start", label: "Speaker", triggerTimecode: zero, toleranceFrames: 0, payload: { name: "Speaker countdown", durationMs: 300000 } };
const stop = { id: "stop", action: "timer-stop", label: "Stop speaker", triggerTimecode: { ...zero, frames: 1 }, toleranceFrames: 0, payload: { name: "Speaker countdown" } };
async function fixture(orgId?: string, showId?: string) {
  const test = await timecodeFixture(orgId, showId);
  const command = async (action: string, payload?: unknown, status = 200) => {
    const response = await test.stub.fetch(test.url("/command"), { method: "POST", body: JSON.stringify({ action, payload }) });
    const body = await response.text(); expect(response.status, body).toBe(status);
  };
  return { ...test, command,
    state: async () => (await test.stub.fetch(test.url("/state"))).json<TimecodeState>(),
    display: async () => (await test.stub.fetch(test.url("/state", "read"))).json<TimecodeDisplayState>(),
    events: async () => (await test.stub.fetch(test.url("/events"))).json<AutomationEvent[]>(),
    feed: (frames: number) => command("feed-tc", { timecode: { ...zero, frames }, format }),
  };
}
async function interrupt(test: Awaited<ReturnType<typeof fixture>>, id: string) {
  await runInDurableObject(test.stub, async (_instance, ctx) => {
    const snapshot = await ctx.storage.get<{ events: AutomationEvent[] }>("timecode");
    const event = snapshot?.events.find(event => event.id === id);
    if (!snapshot || !event) throw new Error("Missing cue");
    Object.assign(event, { fired: false, executionStatus: "dispatching" });
    await ctx.storage.put("timecode", snapshot);
  });
  await evictDurableObject(test.stub);
  expect((await test.events()).find(event => event.id === id)?.executionStatus).toBe("failed");
}

it("fires Start and Stop by timecode and publishes only named countdown output to display clients", async () => {
  const test = await fixture();
  const displayUrl = test.url("/ws", "read");
  displayUrl.searchParams.delete("authUserId"); displayUrl.searchParams.delete("authSessionId");
  displayUrl.searchParams.set("authDisplayExpiresAt", String(Date.now() + 60000));
  const response = await test.stub.fetch(displayUrl, { headers: { Upgrade: "websocket" } });
  const socket = response.webSocket;
  if (!socket) throw new Error("Missing display socket");
  const messages: Array<{ type: string; state?: TimecodeDisplayState }> = [];
  socket.addEventListener("message", event => { messages.push(JSON.parse(String(event.data))); }); socket.accept();
  await test.command("add-event", start); await test.command("add-event", stop);
  await test.command("start"); await test.feed(0);
  const sample = (await test.display()).namedTimers;
  expect(sample?.timers).toHaveLength(1);
  expect(sample?.timers[0]).toMatchObject({ name: "Speaker countdown", durationMs: 300000 });
  expect(sample!.timers[0].endsAt - sample!.serverTime).toBeGreaterThan(295000);
  expect(Object.keys(sample!.timers[0]).sort()).toEqual(["durationMs", "endsAt", "name"]);
  await expect.poll(() => messages.some(message => message.state?.namedTimers?.timers.length === 1)).toBe(true);
  await test.feed(1);
  expect((await test.display()).namedTimers?.timers ?? []).toEqual([]);
  expect((await test.events()).every(event => event.fired && event.executionStatus === "acknowledged")).toBe(true);
  expect(await test.display()).not.toHaveProperty("events");
  socket.close(1000, "Test complete");
});

it("keeps independent timer deadlines through timecode Stop, kill switch, reset and relay eviction", async () => {
  const test = await fixture();
  const rundown = env.RUNDOWN_RELAY.getByName(timecodeRelayKey(test.target));
  const before = await (await rundown.fetch(test.url("/state", "read"))).json<{ timer: { currentItemId: string | null; playback: string } }>();
  await test.command("add-event", start); await test.command("fire-event", { id: "start" });
  await test.command("add-event", { ...start, id: "other", payload: { name: "Intermission", durationMs: 10000 } });
  await test.command("fire-event", { id: "other" });
  const outputs = (await test.state()).namedTimers?.timers;
  await test.command("start"); await test.feed(0); await test.command("stop");
  await test.command("set-triggers-enabled", { enabled: false }); await test.command("reset-events");
  await evictDurableObject(test.stub);
  expect((await test.state()).namedTimers?.timers).toEqual(outputs);
  const after = await (await rundown.fetch(test.url("/state", "read"))).json<{ timer: { currentItemId: string | null; playback: string } }>();
  expect(after.timer.currentItemId).toBe(before.timer.currentItemId);
  expect(after.timer.playback).toBe(before.timer.playback);
});

it("retries an interrupted Start without moving its deadline, and reviewed Re-fire starts a new duration", async () => {
  const test = await fixture();
  await test.command("add-event", start); await test.command("fire-event", { id: "start" });
  const original = (await test.state()).namedTimers?.timers[0];
  const attempt = (await test.events())[0].executionId;
  await interrupt(test, "start");
  await test.command("retry-event", { id: "start" });
  expect((await test.state()).namedTimers?.timers[0]).toEqual(original);
  expect((await test.events())[0].executionId).toBe(attempt);
  await test.command("retry-event", { id: "start" }, 400);
  await test.command("update-event", { id: "start", updates: { payload: { name: "Speaker countdown", durationMs: 600000 } } });
  await test.command("retry-event", { id: "start", confirmed: true, expected: cueReviewState((await test.events())[0]) });
  expect((await test.state()).namedTimers?.timers[0].durationMs).toBe(600000);
  expect((await test.state()).namedTimers!.timers[0].endsAt).toBeGreaterThan(original!.endsAt);
  expect((await test.events())[0].executionId).not.toBe(attempt);
});

it("does not resurrect a stopped timer when an older interrupted Start is retried", async () => {
  const test = await fixture();
  await test.command("add-event", start); await test.command("add-event", stop);
  await test.command("fire-event", { id: "start" }); await test.command("fire-event", { id: "stop" });
  await interrupt(test, "start"); await test.command("retry-event", { id: "start" });
  expect((await test.state()).namedTimers?.timers ?? []).toEqual([]);
  expect((await test.events())[0]).toMatchObject({ fired: true, executionStatus: "acknowledged" });
});

it("does not stop a restarted timer when an older interrupted Stop is retried", async () => {
  const test = await fixture();
  await test.command("add-event", start); await test.command("add-event", stop);
  await test.command("fire-event", { id: "start" }); await test.command("fire-event", { id: "stop" });
  await test.command("retry-event", { id: "start", confirmed: true, expected: cueReviewState((await test.events())[0]) });
  const restarted = (await test.state()).namedTimers?.timers;
  await interrupt(test, "stop"); await test.command("retry-event", { id: "stop" });
  expect((await test.state()).namedTimers?.timers).toEqual(restarted);
});

it("rejects changed-content receipt reuse and permits an explicit reviewed re-arm", async () => {
  const test = await fixture();
  await test.command("add-event", start); await test.command("fire-event", { id: "start" });
  const outputs = (await test.state()).namedTimers?.timers;
  await interrupt(test, "start");
  await test.command("update-event", { id: "start", updates: { payload: { name: "Speaker countdown", durationMs: 60000 } } });
  await test.command("retry-event", { id: "start" });
  expect((await test.events())[0].executionError).toContain("different details");
  expect((await test.state()).namedTimers?.timers).toEqual(outputs);
  await test.command("rearm-event", { id: "start", confirmed: true, expected: cueReviewState((await test.events())[0]) });
  await test.command("fire-event", { id: "start" });
  expect((await test.state()).namedTimers?.timers[0].durationMs).toBe(60000);
});

it("commits output and receipt atomically when persistence fails, then retries successfully", async () => {
  const test = await fixture();
  await test.command("add-event", start);
  await runInDurableObject(test.stub, (_instance, ctx) => {
    ctx.storage.sql.exec("CREATE TRIGGER reject_timer_receipt BEFORE INSERT ON named_timer_receipts BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END");
  });
  await test.command("fire-event", { id: "start" });
  expect((await test.events())[0]).toMatchObject({ fired: false, executionStatus: "failed" });
  expect((await test.state()).namedTimers?.timers ?? []).toEqual([]);
  await evictDurableObject(test.stub);
  expect((await test.state()).namedTimers?.timers ?? []).toEqual([]);
  await runInDurableObject(test.stub, (_instance, ctx) => { ctx.storage.sql.exec("DROP TRIGGER reject_timer_receipt"); });
  await test.command("retry-event", { id: "start" });
  expect((await test.state()).namedTimers?.timers).toHaveLength(1);
});

it("isolates identical timer names across shows and organizations", async () => {
  const first = await fixture();
  const second = await fixture(first.orgId, `${first.orgId}-other`);
  const foreign = await fixture();
  await first.command("add-event", start); await first.command("fire-event", { id: "start" });
  expect((await second.state()).namedTimers?.timers ?? []).toEqual([]);
  expect((await foreign.state()).namedTimers?.timers ?? []).toEqual([]);
  await second.command("add-event", stop); await second.command("fire-event", { id: "stop" });
  expect((await second.events())[0].executionError).toContain("has not started in this show");
  expect((await first.state()).namedTimers?.timers).toHaveLength(1);
});

it.each([start, stop])("honors disabled, skipped, safety kill and reviewed re-fire for $action", async cue => {
  const test = await fixture();
  if (cue.action === "timer-stop") {
    await test.command("add-event", start); await test.command("fire-event", { id: "start" });
  }
  await test.command("add-event", { ...cue, enabled: false });
  await test.command("fire-event", { id: cue.id }, 400);
  await test.command("set-event-enabled", { id: cue.id, enabled: true });
  await test.command("skip-event", { id: cue.id });
  await test.command("retry-event", { id: cue.id }, 400);
  await test.command("rearm-event", { id: cue.id, confirmed: true, expected: cueReviewState((await test.events()).find(event => event.id === cue.id)!) });
  await test.command("set-triggers-enabled", { enabled: false });
  await test.command("fire-event", { id: cue.id }, 400);
  await test.command("set-triggers-enabled", { enabled: true });
  await test.command("fire-event", { id: cue.id });
  const sent = (await test.events()).find(event => event.id === cue.id)!;
  await test.command("retry-event", { id: cue.id }, 400);
  await test.command("retry-event", { id: cue.id, confirmed: true, expected: cueReviewState(sent) });
  expect((await test.events()).find(event => event.id === cue.id)).toMatchObject({ fired: true, executionStatus: "acknowledged" });
});

it.each([
  { name: "", durationMs: 300000 }, { name: "Speaker", durationMs: 0 },
  { name: "Speaker", durationMs: 86400001 }, { name: "Speaker", durationMs: "300000" },
  { name: "Speaker\ncountdown", durationMs: 300000 }, { name: "Speaker", durationMs: 300000, other: true },
])("validates timer payload on add, update and atomic group replacement: %j", async payload => {
  const test = await fixture();
  await test.command("add-event", { ...start, payload }, 400);
  await test.command("add-event", start);
  await test.command("update-event", { id: start.id, updates: { payload } }, 400);
  await test.command("replace-event-group", { sourceKey: "timers", events: [{ ...start, id: "replacement", payload }] }, 400);
  expect(await test.events()).toHaveLength(1);
  expect((await test.events())[0].payload).toEqual(start.payload);
});

it("normalizes timer identity and preserves Start/Stop ordering when the same feed crosses both", async () => {
  const test = await fixture();
  await test.command("add-event", { ...start, payload: { name: "  Café  ", durationMs: 300000 } });
  await test.command("add-event", { ...stop, payload: { name: "CAFE\u0301" } });
  await test.command("start"); await test.feed(0); await test.feed(1);
  expect((await test.state()).namedTimers?.timers ?? []).toEqual([]);
  expect((await test.events()).every(event => event.fired)).toBe(true);
});

it("purges timer outputs and receipts with their show", async () => {
  const test = await fixture();
  await test.command("add-event", start); await test.command("fire-event", { id: "start" });
  const url = test.url("/internal/purge-show");
  const response = await test.stub.fetch(url, { method: "POST", headers: { "x-showpilot-internal-secret": env.BETTER_AUTH_SECRET } });
  expect(response.ok).toBe(true); await response.text();
  await runInDurableObject(test.stub, (_instance, ctx) => {
    expect(ctx.storage.sql.exec("SELECT * FROM named_timers").toArray()).toEqual([]);
    expect(ctx.storage.sql.exec("SELECT * FROM named_timer_receipts").toArray()).toEqual([]);
  });
});

it("bounds visible timers and frees output capacity when a named Stop runs", async () => {
  const test = await fixture();
  for (let index = 0; index < 17; index++) {
    const id = `timer-${index}`;
    await test.command("add-event", { ...start, id, payload: { name: id, durationMs: 300000 } });
    await test.command("fire-event", { id });
  }
  expect((await test.state()).namedTimers?.timers).toHaveLength(16);
  expect((await test.events()).find(event => event.id === "timer-16")?.executionError).toContain("Stop a named timer");
  await test.command("add-event", { ...stop, payload: { name: "timer-0" } }); await test.command("fire-event", { id: "stop" });
  await test.command("retry-event", { id: "timer-16" });
  expect((await test.state()).namedTimers?.timers).toHaveLength(16);
  expect((await test.state()).namedTimers?.timers.some(timer => timer.name === "timer-16")).toBe(true);
});
