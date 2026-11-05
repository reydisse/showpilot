import { env } from "cloudflare:workers";
import { abortAllDurableObjects, evictDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { timecodeFixture } from "@/test/timecode-fixtures";
import type { AutomationEvent, TimecodeState } from "@/types/timecode";

afterEach(() => abortAllDurableObjects());
const format = { frameRate: 30, dropFrame: "ndf" };
const timecode = (seconds: number) => ({ hours: 0, minutes: 0, seconds, frames: 0 });
async function timeline() {
  const fixture = await timecodeFixture();
  const command = async (action: string, payload?: unknown, status = 200) => {
    const response = await fixture.stub.fetch(fixture.url("/command"), { method: "POST", body: JSON.stringify({ action, payload }) });
    expect(response.status).toBe(status); await response.arrayBuffer();
  };
  return {
    ...fixture, command,
    cue: (id: string, seconds: number) => command("add-event", { id, label: id, action: "lyrics-clear", triggerTimecode: timecode(seconds), payload: {}, toleranceFrames: 0 }),
    feed: (seconds: number) => command("feed-tc", { timecode: timecode(seconds), format }),
    state: async () => (await fixture.stub.fetch(fixture.url("/state"))).json<TimecodeState>(),
    events: async () => (await fixture.stub.fetch(fixture.url("/events"))).json<AutomationEvent[]>(),
    resume: (holdId: string, status = 200) => command("set-triggers-enabled", { enabled: true, confirmed: true, expectedHoldId: holdId }, status),
  };
}

it("persists a large-jump hold through eviction and resumes without firing skipped or landing cues", async () => {
  const test = await timeline();
  for (const [id, second] of [["fired", 1], ["skipped", 2], ["landing", 10], ["held", 11], ["future", 12]] as const) await test.cue(id, second);
  await test.command("start");
  await test.feed(1);
  await test.feed(10);
  expect(await test.state()).toMatchObject({ running: true, totalFrames: 300, triggersEnabled: false,
    automationHold: { reason: "timecode-jump", from: "00:00:01:00", to: "00:00:10:00" } });
  await test.feed(11);
  await evictDurableObject(test.stub);
  const held = await test.state();
  expect(held.triggersEnabled).toBe(false);
  if (!held.automationHold) throw new Error("Jump review was lost during hibernation");
  await test.command("set-triggers-enabled", { enabled: true }, 400);
  await test.resume(held.automationHold.id);
  await expect.poll(async () => (await test.state()).running, { timeout: 2000 }).toBe(false);
  await test.feed(11); // A repeated landing frame cannot replay a held cue.
  await test.feed(12);
  expect((await test.events()).map(event => [event.id, event.fired])).toEqual([
    ["fired", true], ["skipped", false], ["landing", false], ["held", false], ["future", true],
  ]);
  expect(await test.state()).toMatchObject({ automationHold: null, triggersEnabled: true });
  const displayUrl = test.url("/state", "read");
  displayUrl.searchParams.delete("authSessionId");
  expect(await (await test.stub.fetch(displayUrl)).json()).not.toHaveProperty("automationHold");
});

it("never rearms an acknowledged cue on rewind, even after the operator resumes", async () => {
  const test = await timeline();
  await test.cue("once", 10);
  await test.command("start");
  await test.feed(10);
  await test.feed(1);
  const hold = (await test.state()).automationHold;
  if (!hold) throw new Error("Expected rewind hold");
  expect((await test.events())[0]).toMatchObject({ fired: true, executionAttempts: 1 });
  await test.resume(hold.id);
  for (let seconds = 2; seconds <= 10; seconds++) await test.feed(seconds);
  expect((await test.events())[0]).toMatchObject({ fired: true, executionAttempts: 1 });
});

it("requires a fresh confirmation after another jump and does not clear the hold through Reset or Stop", async () => {
  const test = await timeline();
  await test.command("set-timecode", { timecode: timecode(10) });
  const first = (await test.state()).automationHold;
  if (!first) throw new Error("Expected explicit seek hold");
  await test.command("set-timecode", { timecode: timecode(20) });
  const latest = (await test.state()).automationHold;
  if (!latest) throw new Error("Expected second seek hold");
  expect(latest.id).not.toBe(first.id);
  await test.resume(first.id, 400);
  await test.command("reset-events");
  await test.command("stop");
  expect(await test.state()).toMatchObject({ triggersEnabled: false, automationHold: latest });
  await test.resume(latest.id);
  await test.resume(first.id, 400);
});

it("continues ordinary sparse-feed crossings at the two-second boundary", async () => {
  const test = await timeline();
  await test.cue("crossed", 2);
  await test.command("start");
  await test.feed(1);
  await test.feed(3);
  expect((await test.events())[0].fired).toBe(true);
  expect((await test.state()).triggersEnabled).toBe(true);
});

it("cancels old queued output even if the operator resumes before its predecessor acknowledges", async () => {
  const test = await timeline();
  const graphics = env.LOWER_THIRDS_RELAY.getByName(test.orgId);
  await (await graphics.fetch("https://test/test/delay", { method: "POST", body: "350" })).text();
  for (const action of ["lower-third-show", "lower-third-clear"]) {
    await test.command("add-event", { id: action, action, label: action, triggerTimecode: timecode(1), payload: { line1: "Already dispatched" } });
  }
  await test.command("start");
  const pending = test.feed(1);
  await expect.poll(async () => (await test.events()).filter(event => event.executionStatus === "dispatching").length).toBe(2);
  await test.feed(10);
  const hold = (await test.state()).automationHold;
  if (!hold) throw new Error("Expected jump to interrupt queued work");
  await test.resume(hold.id);
  await pending;
  expect(await test.events()).toEqual([
    expect.objectContaining({ id: "lower-third-show", fired: true }),
    expect.objectContaining({ id: "lower-third-clear", fired: false, executionStatus: "scheduled" }),
  ]);
  expect(await (await graphics.fetch("https://test/current")).json()).toMatchObject({ current: { line1: "Already dispatched" } });
});

it("holds automation if a fresh Bridge standby is far from the disconnecting generator", async () => {
  const test = await timeline();
  await test.cue("bridge-landing", 10);
  await test.command("start");
  await test.feed(1);
  const feed = await test.stub.fetch(test.url("/internal/bridge-feed"), { method: "POST",
    headers: { "x-showpilot-internal-secret": env.BETTER_AUTH_SECRET }, body: JSON.stringify({ payload: { timecode: timecode(10), format } }) });
  expect(feed.status).toBe(200); await feed.arrayBuffer();
  test.controlSocket?.close();
  await expect.poll(async () => (await test.state()).totalFrames).toBe(300);
  expect(await test.state()).toMatchObject({ running: true, source: "mtc", triggersEnabled: false, automationHold: { reason: "timecode-jump" } });
  expect((await test.events())[0].fired).toBe(false);
});
