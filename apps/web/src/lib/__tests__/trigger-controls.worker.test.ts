import { env } from "cloudflare:workers";
import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { timecodeFixture } from "@/test/timecode-fixtures";
import { timecodeRelayKey } from "../timecode-target.server";
import { cueReviewState } from "../automation-cues";
import { framesToTimecode } from "../timecode";
import type { AutomationEvent, TimecodeState } from "@/types/timecode";

afterEach(abortAllDurableObjects);
const format = { frameRate: 30, dropFrame: "ndf" } as const;
async function fixture() {
  const test = await timecodeFixture();
  const command = async (action: string, payload?: unknown, status = 200) => {
    const response = await test.stub.fetch(test.url("/command"), { method: "POST", body: JSON.stringify({ action, payload }) });
    const body = await response.text();
    expect(response.status, body).toBe(status);
  };
  return { ...test, command,
    cue: (id: string, action: AutomationEvent["action"], frame: number, enabled = true) => command("add-event", {
      id, action, label: id, enabled, triggerTimecode: framesToTimecode(frame, format), toleranceFrames: 0,
      payload: action === "stage-message" ? { message: id } : {},
    }),
    feed: (frame: number) => command("feed-tc", { timecode: framesToTimecode(frame, format), format }),
    state: async () => (await test.stub.fetch(test.url("/state"))).json<TimecodeState>(),
    events: async () => (await test.stub.fetch(test.url("/events"))).json<AutomationEvent[]>(),
    stage: async () => (await env.RUNDOWN_RELAY.getByName(timecodeRelayKey(test.target)).fetch(test.url("/state", "read"))).json<{ stageMessage: string }>(),
  };
}

it("pauses automatic cues without stopping the clock and lets a scheduled enable end the pause without replay", async () => {
  const test = await fixture();
  await test.cue("pause", "triggers-disable", 1);
  await test.cue("held", "stage-message", 2);
  await test.cue("resume", "triggers-enable", 3);
  await test.cue("future", "stage-message", 4);
  await test.command("start");
  await test.feed(0); await test.feed(1); await test.feed(2);
  expect(await test.state()).toMatchObject({ running: true, triggersEnabled: true, automaticCuesEnabled: false, totalFrames: 2 });
  expect(await test.stage()).toMatchObject({ stageMessage: "" });
  await test.feed(3); await test.feed(4);
  expect(await test.state()).toMatchObject({ running: true, automaticCuesEnabled: true });
  expect(await test.stage()).toMatchObject({ stageMessage: "future" });
  expect((await test.events()).map(event => [event.id, event.fired])).toEqual([["pause", true], ["held", false], ["resume", true], ["future", true]]);
});

it.each([false, true])("pause wins at the same dispatch frame regardless of insertion order: reversed=%s", async reverse => {
  const test = await fixture();
  const controls = ["triggers-disable", "triggers-enable"] as const;
  await test.cue("output", "stage-message", 1);
  for (const action of reverse ? [...controls].reverse() : controls) await test.cue(action, action, 1);
  await test.command("start"); await test.feed(0); await test.feed(1);
  expect(await test.state()).toMatchObject({ automaticCuesEnabled: false, triggersEnabled: true });
  expect(await test.stage()).toMatchObject({ stageMessage: "" });
  expect((await test.events()).filter(event => event.fired)).toHaveLength(2);
});

it("handles sparse feeds crossing pause, held output and resume in one evaluation", async () => {
  const test = await fixture();
  await test.cue("pause", "triggers-disable", 1);
  await test.cue("held", "stage-message", 2);
  await test.cue("resume", "triggers-enable", 3);
  await test.cue("future", "stage-message", 4);
  await test.command("start"); await test.feed(0); await test.feed(4);
  expect(await test.stage()).toMatchObject({ stageMessage: "future" });
  expect((await test.events()).find(event => event.id === "held")).toMatchObject({ fired: false, executionAttempts: 0 });
});

it("cancels reserved automatic outputs when a pause is crossed before they dispatch", async () => {
  const test = await fixture();
  await test.cue("queued", "stage-message", 1);
  await test.cue("pause", "triggers-disable", 2);
  await test.command("start"); await test.feed(0); await test.feed(2);
  expect(await test.stage()).toMatchObject({ stageMessage: "" });
  expect((await test.events())[0]).toMatchObject({ fired: false, executionStatus: "scheduled" });
});

it("allows deliberate manual Fire during a cue pause and resumes only future automatic cues", async () => {
  const test = await fixture();
  await test.cue("pause", "triggers-disable", 1);
  await test.cue("manual", "stage-message", 2);
  await test.cue("held", "stage-message", 3);
  await test.cue("future", "stage-message", 4);
  await test.command("start"); await test.feed(0); await test.feed(1); await test.feed(3);
  await test.command("fire-event", { id: "manual" });
  expect(await test.stage()).toMatchObject({ stageMessage: "manual" });
  await test.command("resume-automatic-cues"); await test.feed(3);
  expect(await test.stage()).toMatchObject({ stageMessage: "manual" });
  await test.feed(4);
  expect(await test.stage()).toMatchObject({ stageMessage: "future" });
  expect((await test.events()).find(event => event.id === "held")?.fired).toBe(false);
});

it("preserves a cue pause through Stop, Start and relay eviction", async () => {
  const test = await fixture();
  await test.cue("pause", "triggers-disable", 1);
  await test.cue("held", "stage-message", 2);
  await test.command("fire-event", { id: "pause" });
  await test.command("start"); await test.command("stop");
  await evictDurableObject(test.stub);
  expect(await test.state()).toMatchObject({ automaticCuesEnabled: false });
  await test.command("start"); await test.feed(2);
  expect(await test.stage()).toMatchObject({ stageMessage: "" });
  await test.command("resume-automatic-cues");
  expect(await test.state()).toMatchObject({ automaticCuesEnabled: true });
});

it.each(["triggers-disable", "triggers-enable"] as const)("honors disabled/skipped cues and reviewed re-fire for %s", async action => {
  const test = await fixture();
  await test.cue("control", action, 1, false);
  await test.command("fire-event", { id: "control" }, 400);
  await test.command("set-event-enabled", { id: "control", enabled: true });
  await test.command("skip-event", { id: "control" });
  await test.command("retry-event", { id: "control" }, 400);
  await test.command("rearm-event", { id: "control", confirmed: true, expected: cueReviewState((await test.events())[0]) });
  await test.command("fire-event", { id: "control" });
  const first = (await test.events())[0];
  expect(first).toMatchObject({ fired: true, executionStatus: "acknowledged" });
  await test.command("retry-event", { id: "control" }, 400);
  await test.command("retry-event", { id: "control", confirmed: true, expected: cueReviewState(first) });
  expect((await test.events())[0]).toMatchObject({ fired: true, executionStatus: "acknowledged" });
  expect((await test.events())[0].executionId).not.toBe(first.executionId);
});

it("never allows a resume cue or operator resume to override the safety kill switch or jump review", async () => {
  const test = await fixture();
  await test.cue("pause", "triggers-disable", 0);
  await test.cue("resume", "triggers-enable", 1);
  await test.command("fire-event", { id: "pause" });
  await test.command("set-triggers-enabled", { enabled: false });
  await test.command("start"); await test.feed(1);
  await test.command("fire-event", { id: "resume" }, 400);
  await test.command("resume-automatic-cues", undefined, 400);
  expect(await test.state()).toMatchObject({ automaticCuesEnabled: false, triggersEnabled: false });
  await test.command("set-triggers-enabled", { enabled: true });
  expect(await test.state()).toMatchObject({ automaticCuesEnabled: false });
  await test.feed(300);
  const hold = (await test.state()).automationHold;
  expect(hold).toBeTruthy();
  await test.command("resume-automatic-cues", undefined, 400);
  await test.command("fire-event", { id: "resume" }, 400);
  await test.command("set-triggers-enabled", { enabled: true, confirmed: true, expectedHoldId: hold?.id });
  await test.command("fire-event", { id: "resume" });
  expect(await test.state()).toMatchObject({ automaticCuesEnabled: true, triggersEnabled: true, automationHold: null });
});

it("keeps format review authoritative over an operator resume", async () => {
  const test = await fixture();
  await test.cue("pause", "triggers-disable", 0);
  await test.command("fire-event", { id: "pause" });
  await test.command("start"); await test.feed(0);
  for (let i = 0; i < 5; i++) await test.command("feed-tc", { timecode: framesToTimecode(i, format), format: { frameRate: 25, dropFrame: "ndf" } });
  expect((await test.state()).incomingFormat).toBeTruthy();
  await test.command("resume-automatic-cues", undefined, 400);
  expect(await test.state()).toMatchObject({ automaticCuesEnabled: false, triggersEnabled: false });
});

it.each(["triggers-disable", "triggers-enable"] as const)("recovers an interrupted %s cue with explicit idempotent Retry", async action => {
  const test = await fixture();
  await test.cue("control", action, 0);
  await runInDurableObject(test.stub, async (_instance, ctx) => {
    const snapshot = await ctx.storage.get<{ events: AutomationEvent[]; state: TimecodeState }>("timecode");
    const clock = await ctx.storage.get<{ state: TimecodeState }>("clock");
    if (!snapshot || !clock) throw new Error("Missing timeline");
    snapshot.state.automaticCuesEnabled = clock.state.automaticCuesEnabled = action === "triggers-enable";
    Object.assign(snapshot.events[0], { executionStatus: "dispatching", executionId: crypto.randomUUID(), executionAttempts: 1 });
    await ctx.storage.put({ timecode: snapshot, clock });
  });
  await evictDurableObject(test.stub);
  expect((await test.events())[0].executionStatus).toBe("failed");
  await test.command("retry-event", { id: "control" });
  expect(await test.state()).toMatchObject({ automaticCuesEnabled: action === "triggers-enable" });
  expect((await test.events())[0]).toMatchObject({ fired: true, executionStatus: "acknowledged" });
});

it("reserves a pause once across concurrent feeds and keeps subsequent outputs held", async () => {
  const test = await fixture();
  await test.cue("pause", "triggers-disable", 1);
  await test.cue("held", "stage-message", 2);
  await test.command("start"); await test.feed(0);
  await Promise.all([test.feed(1), test.feed(1), test.feed(1)]);
  await test.feed(2);
  expect((await test.events())[0]).toMatchObject({ fired: true, executionAttempts: 1 });
  expect(await test.state()).toMatchObject({ running: true, automaticCuesEnabled: false });
  expect(await test.stage()).toMatchObject({ stageMessage: "" });
});

it("does not apply disabled control cues during automatic playback", async () => {
  const test = await fixture();
  await test.cue("disabled-pause", "triggers-disable", 1, false);
  await test.cue("output", "stage-message", 2);
  await test.cue("pause", "triggers-disable", 3);
  await test.cue("disabled-resume", "triggers-enable", 4, false);
  await test.command("start");
  for (let frame = 0; frame <= 4; frame++) await test.feed(frame);
  expect(await test.stage()).toMatchObject({ stageMessage: "output" });
  expect(await test.state()).toMatchObject({ automaticCuesEnabled: false });
  for (const event of (await test.events()).filter(event => !event.enabled)) expect(event).toMatchObject({ fired: false, executionAttempts: 0 });
});
