import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { timecodeFixture } from "@/test/timecode-fixtures";
import type { AutomationEvent } from "@/types/timecode";

afterEach(() => abortAllDurableObjects());
const cue = { id: "default", label: "Tolerance", action: "lyrics-clear", triggerTimecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 }, payload: {} };
async function timeline() {
  const fixture = await timecodeFixture();
  return {
    ...fixture,
    async command(action: string, payload?: unknown, status = 200) {
      const response = await fixture.stub.fetch(fixture.url("/command"), { method: "POST", body: JSON.stringify({ action, payload }) });
      expect(response.status).toBe(status); return response.json();
    },
    async events() { return (await fixture.stub.fetch(fixture.url("/events"))).json<AutomationEvent[]>(); },
  };
}

it("uses five frames for new/missing values while preserving explicit zero and stored custom tolerances", async () => {
  const test = await timeline();
  await test.command("add-event", cue);
  await test.command("add-event", { ...cue, id: "exact", toleranceFrames: 0 });
  await test.command("replace-event-group", { sourceKey: "group", events: [{ ...cue, id: "mapped" }, { ...cue, id: "custom", toleranceFrames: 13 }] });
  await runInDurableObject(test.stub, async (_instance, ctx) => {
    const saved = await ctx.storage.get<{ events: Partial<AutomationEvent>[] }>("timecode");
    if (!saved) throw new Error("Missing timeline snapshot");
    delete saved.events[0].toleranceFrames;
    await ctx.storage.put("timecode", saved);
  });
  await evictDurableObject(test.stub);
  expect((await test.events()).map(event => [event.id, event.toleranceFrames])).toEqual([
    ["default", 5], ["exact", 0], ["mapped", 5], ["custom", 13],
  ]);
  await test.command("update-event", { id: "custom", updates: { toleranceFrames: 2 } });
  expect((await test.events()).find(event => event.id === "custom")?.toleranceFrames).toBe(2);
});

it.each([-1, 1.5, 9001, null, "5"])("rejects invalid tolerance %s on add, atomic group replacement, and update", async toleranceFrames => {
  const test = await timeline();
  await test.command("add-event", { ...cue, toleranceFrames }, 400);
  expect(await test.events()).toEqual([]);
  await test.command("replace-event-group", { sourceKey: "group", events: [cue] });
  const before = await test.events();
  await test.command("replace-event-group", { sourceKey: "group", events: [{ ...cue, id: "valid" }, { ...cue, id: "invalid", toleranceFrames }] }, 400);
  expect(await test.events()).toEqual(before);
  await test.command("update-event", { id: cue.id, updates: { toleranceFrames } }, 400);
  expect(await test.events()).toEqual(before);
});

it("uses the window only at startup and fires exact-zero cues when sparse forward feeds cross them", async () => {
  const test = await timeline();
  await test.command("add-event", cue);
  await test.command("add-event", { ...cue, id: "exact", toleranceFrames: 0 });
  await test.command("start");
  const feed = (frames: number) => test.command("feed-tc", { timecode: { hours: 0, minutes: 0, seconds: Math.floor(frames / 30), frames: frames % 30 }, format: { frameRate: 30, dropFrame: "ndf" } });
  await feed(26);
  expect((await test.events()).map(event => event.fired)).toEqual([true, false]);
  await feed(28);
  expect((await test.events()).map(event => event.fired)).toEqual([true, false]);
  await feed(31);
  expect((await test.events()).map(event => [event.fired, event.executionAttempts])).toEqual([[true, 1], [true, 1]]);
});
