import { env } from "cloudflare:workers";
import { abortAllDurableObjects, evictDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { timecodeFixture } from "@/test/timecode-fixtures";
import { cueReviewState } from "@/lib/automation-cues";
import type { AutomationEvent, TimecodeState } from "@/types/timecode";

afterEach(() => abortAllDurableObjects());
const tc = (seconds: number) => ({ hours: 0, minutes: 0, seconds, frames: 0 });
async function fixture() {
  const test = await timecodeFixture();
  const command = async (action: string, payload?: unknown, status = 200) => {
    const response = await test.stub.fetch(test.url("/command"), { method: "POST", body: JSON.stringify({ action, payload }) });
    const body = await response.json(); expect(response.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const events = async () => (await test.stub.fetch(test.url("/events"))).json<AutomationEvent[]>();
  return { ...test, command, events,
    state: async () => (await test.stub.fetch(test.url("/state"))).json<TimecodeState>(),
    cue: (id: string, seconds: number, enabled = true) => command("add-event", { id, label: id, action: "lower-third-show", payload: { line1: id }, enabled, triggerTimecode: tc(seconds), toleranceFrames: 0 }),
    feed: (seconds: number) => command("feed-tc", { timecode: tc(seconds), format: { frameRate: 30, dropFrame: "ndf" } }),
    graphic: async () => (await env.LOWER_THIRDS_RELAY.getByName(test.orgId).fetch("https://test/current")).json(),
  };
}

it("fires the authoritative next ready cue without moving the clock or replaying past cues", async () => {
  const test = await fixture();
  await test.cue("later", 8); await test.cue("past", 1); await test.cue("disabled", 3, false); await test.cue("skip", 4); await test.cue("next", 5);
  await test.command("set-timecode", { timecode: tc(2) });
  await test.command("skip-event", { id: "skip" });
  await test.command("fire-next");
  expect(await test.graphic()).toMatchObject({ current: { line1: "next" } });
  expect(await test.state()).toMatchObject({ running: false, totalFrames: 60 });
  await test.command("fire-next");
  expect(await test.graphic()).toMatchObject({ current: { line1: "later" } });
  await test.command("fire-next", undefined, 400);
  expect((await test.events()).filter(event => event.fired).map(event => event.id)).toEqual(["next", "later"]);
  test.controlSocket?.close();
});

it("persists Skip through eviction and ignores it on clock crossings until confirmed Re-arm", async () => {
  const test = await fixture();
  await test.cue("skip", 2);
  await test.command("skip-event", { id: "skip" });
  await evictDurableObject(test.stub);
  const skipped = (await test.events())[0];
  expect(skipped).toMatchObject({ enabled: true, fired: false, skipped: true });
  await test.command("start"); await test.feed(1); await test.feed(3);
  expect((await test.events())[0]).toMatchObject({ fired: false, executionAttempts: 0 });
  await test.command("stop");
  await test.command("rearm-event", { id: "skip", expected: cueReviewState(skipped) }, 400);
  await test.command("rearm-event", { id: "skip", expected: cueReviewState(skipped), confirmed: true });
  expect((await test.events())[0]).toMatchObject({ fired: false, executionStatus: "scheduled", executionAttempts: 0 });
  expect((await test.events())[0].skipped).toBeUndefined();
  await test.command("fire-event", { id: "skip" });
  expect(await test.graphic()).toMatchObject({ current: { line1: "skip" } });
  test.controlSocket?.close();
});

it("does not re-fire an acknowledged cue and rejects stale re-arm confirmations", async () => {
  const test = await fixture(); await test.cue("one", 5);
  const before = cueReviewState((await test.events())[0]);
  await test.command("fire-event", { id: "one" });
  await test.command("fire-event", { id: "one" }, 400);
  await test.command("skip-event", { id: "one" }, 400);
  await test.command("rearm-event", { id: "one", expected: before, confirmed: true }, 400);
  const fired = (await test.events())[0];
  expect(fired).toMatchObject({ fired: true, executionAttempts: 1 });
  await test.command("rearm-event", { id: "one", expected: cueReviewState(fired), confirmed: true });
  const armed = (await test.events())[0];
  expect(armed).toMatchObject({ fired: false, executionStatus: "scheduled", executionAttempts: 0 });
  expect(armed.executionId).toBeUndefined(); expect(armed.executedAt).toBeUndefined();
  await test.command("fire-event", { id: "one" });
  expect((await test.events())[0].executionId).not.toBe(fired.executionId);
  test.controlSocket?.close();
});

it("honors the automation switch, disabled and skipped cues, and missing cue IDs", async () => {
  const test = await fixture(); await test.cue("one", 2); await test.cue("disabled", 3, false);
  await test.command("fire-event", { id: "disabled" }, 400);
  await test.command("set-triggers-enabled", { enabled: false });
  await test.command("fire-event", { id: "one" }, 400); await test.command("fire-next", undefined, 400);
  await test.command("set-triggers-enabled", { enabled: true });
  await test.command("skip-event", { id: "one" });
  await test.command("fire-event", { id: "one" }, 400); await test.command("retry-event", { id: "one" }, 400);
  for (const action of ["fire-event", "skip-event", "rearm-event"]) await test.command(action, { id: "missing" }, 400);
  expect((await test.events()).every(event => !event.fired)).toBe(true);
  test.controlSocket?.close();
});

it("reserves one firing before yielding and blocks Skip/Re-arm while its output is in flight", async () => {
  const test = await fixture(); await test.cue("slow", 3);
  const output = env.LOWER_THIRDS_RELAY.getByName(test.orgId);
  await (await output.fetch("https://test/test/delay", { method: "POST", body: "200" })).text();
  const firing = test.command("fire-event", { id: "slow" });
  await expect.poll(async () => (await test.events())[0].executionStatus).toBe("dispatching");
  for (const action of ["fire-event", "skip-event", "rearm-event"]) await test.command(action, { id: "slow" }, 400);
  await firing;
  expect((await test.events())[0]).toMatchObject({ fired: true, executionAttempts: 1 });
  test.controlSocket?.close();
});

it("leaves failed attempts visible and never retries them through Fire Next or Fire", async () => {
  const test = await fixture(); await test.cue("failed", 2); await test.cue("ready", 3);
  const output = env.LOWER_THIRDS_RELAY.getByName(test.orgId);
  await (await output.fetch("https://test/test/status", { method: "POST", body: "503" })).text();
  await test.command("fire-event", { id: "failed" });
  const failed = (await test.events())[0];
  expect(failed).toMatchObject({ fired: false, executionStatus: "failed", executionAttempts: 1 });
  await (await output.fetch("https://test/test/status", { method: "POST", body: "200" })).text();
  await test.command("fire-event", { id: "failed" }, 400);
  await test.command("fire-next");
  expect(await test.graphic()).toMatchObject({ current: { line1: "ready" } });
  await test.command("skip-event", { id: "failed" });
  expect((await test.events())[0]).toMatchObject({ fired: false, skipped: true, executionStatus: "failed", executionId: failed.executionId });
  test.controlSocket?.close();
});

it("does not let cue creation, group replacement or editing forge the server-owned skipped state", async () => {
  const test = await fixture();
  const event = { id: "one", label: "one", action: "lyrics-clear", payload: {}, triggerTimecode: tc(2), skipped: true };
  await test.command("add-event", event);
  await test.command("update-event", { id: "one", updates: { skipped: true } }, 400);
  expect((await test.events())[0].skipped).toBeUndefined();
  await test.command("replace-event-group", { sourceKey: "fixture", events: [{ ...event, id: "two" }] });
  expect((await test.events()).every(event => !event.skipped)).toBe(true);
  test.controlSocket?.close();
});

it("Reset All clears skips but preserves disabled state", async () => {
  const test = await fixture(); await test.cue("one", 2, false);
  await test.command("skip-event", { id: "one" }); await test.command("reset-events");
  expect((await test.events())[0]).toMatchObject({ enabled: false, fired: false, executionStatus: "scheduled" });
  expect((await test.events())[0].skipped).toBeUndefined();
  test.controlSocket?.close();
});
