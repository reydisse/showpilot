import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { abortAllDurableObjects, evictDurableObject } from "cloudflare:test";
import { timecodeFixture } from "@/test/timecode-fixtures";
import { automationEditReview } from "../automation-edit";
import type { AutomationEvent, TimecodeState } from "@/types/timecode";
afterEach(abortAllDurableObjects);
async function fixture() {
  const room = await timecodeFixture();
  const command = async (action: string, payload?: unknown) => {
    const response = await room.stub.fetch(room.url("/command"), { method: "POST", body: JSON.stringify({ action, payload }) });
    return { status: response.status, body: response.headers.get("content-type")?.includes("json") ? await response.json() : await response.text() };
  };
  const events = async () => (await room.stub.fetch(room.url("/events"))).json<AutomationEvent[]>();
  const state = async () => (await room.stub.fetch(room.url("/state"))).json<TimecodeState>();
  await command("add-event", { id: "cue", label: "Original", action: "lyrics-clear", payload: {},
    sourceKey: "song-map", triggerTimecode: { hours: 0, minutes: 0, seconds: 10, frames: 0 } });
  const edit = async (updates: Record<string, unknown> = { label: "Edited" }) => ({ requestId: crypto.randomUUID(), id: "cue", updates,
    expected: automationEditReview((await events())[0]), expectedFormat: (await state()).format, expectedServiceDate: room.target.serviceDate });
  return { ...room, command, events, state, edit };
}
it("recovers an edit after restart without overwriting a newer edit", async () => {
  const f = await fixture(), input = await f.edit();
  expect(await f.command("update-event", input)).toMatchObject({ status: 200, body: { outcome: "applied", requestId: input.requestId } });
  await f.command("update-event", { id: "cue", updates: { label: "Newer edit" } });
  await evictDurableObject(f.stub);
  expect(await f.command("update-event", input)).toMatchObject({ status: 200, body: { outcome: "applied" } });
  expect((await f.events())[0].label).toBe("Newer edit");
});
it("recovers a saved edit after deletion without recreating the cue", async () => {
  const f = await fixture(), input = await f.edit();
  await f.command("update-event", input); await f.command("remove-event", { id: "cue" });
  expect(await f.command("update-event", input)).toMatchObject({ status: 200, body: { outcome: "applied" } });
  expect(await f.events()).toEqual([]);
});
it("commits concurrent identical edits once and rejects a different intent with the same identity", async () => {
  const f = await fixture(), input = await f.edit();
  const results = await Promise.all([f.command("update-event", input), f.command("update-event", input)]);
  expect(results.map(result => result.status)).toEqual([200, 200]);
  expect(await f.command("update-event", { ...input, updates: { label: "Different" } })).toMatchObject({ status: 409, body: { outcome: "conflict" } });
  expect((await f.events())[0].label).toBe("Edited");
});
it("preserves execution and source identity while recalculating edited cue timing", async () => {
  const f = await fixture(); await f.command("fire-event", { id: "cue" });
  const original = (await f.events())[0];
  const input = await f.edit({ triggerTimecode: { hours: 0, minutes: 0, seconds: 20, frames: 0 }, toleranceFrames: 8, leadMs: 100 });
  expect(await f.command("update-event", input)).toMatchObject({ status: 200 });
  const event = (await f.events())[0];
  expect(event).toMatchObject({ id: original.id, sourceKey: original.sourceKey, action: original.action, fired: true,
    executionId: original.executionId, executionStatus: "acknowledged", executionAttempts: original.executionAttempts, triggerFrame: 600, toleranceFrames: 8, leadMs: 100 });
  expect(event.editRevision).not.toBe(original.editRevision);
});
it.each(["id", "action", "fired", "executionStatus", "triggerFrame", "sourceKey", "enabled"])("rejects attempts to edit server-owned %s", async field => {
  const f = await fixture(), input = await f.edit({ [field]: field === "fired" ? false : "other" });
  expect(await f.command("update-event", input)).toMatchObject({ status: 400, body: { outcome: "rejected" } });
  expect((await f.events())[0].label).toBe("Original");
});
it("makes stale review rejection permanent even if the cue later returns to its old state", async () => {
  const f = await fixture(), input = await f.edit();
  await f.command("set-event-enabled", { id: "cue", enabled: false });
  expect(await f.command("update-event", input)).toMatchObject({ status: 409, body: { outcome: "conflict" } });
  await f.command("set-event-enabled", { id: "cue", enabled: true });
  expect(await f.command("update-event", input)).toMatchObject({ status: 409 });
});
it.each(["expected", "expectedFormat", "expectedServiceDate"])("requires %s for recoverable edits", async field => {
  const f = await fixture(), input = await f.edit();
  expect(await f.command("update-event", { ...input, [field]: undefined })).toMatchObject({ status: 400, body: { outcome: "rejected" } });
});
it("rejects invalid request identities, rescheduled shows and frame-rate conflicts", async () => {
  const f = await fixture();
  expect(await f.command("update-event", { ...await f.edit(), requestId: "not-a-uuid" })).toMatchObject({ status: 400 });
  expect(await f.command("update-event", { ...await f.edit(), expectedServiceDate: "2000-01-01" })).toMatchObject({ status: 409 });
  expect(await f.command("update-event", { ...await f.edit(), expectedFormat: { frameRate: 25, dropFrame: "ndf" } })).toMatchObject({ status: 409 });
});
it("checks current membership before recovering a receipt", async () => {
  const f = await fixture(), input = await f.edit(); await f.command("update-event", input);
  await env.DB.prepare("DELETE FROM member WHERE organizationId = ? AND userId = ?").bind(f.orgId, f.authority.userId).run();
  expect((await f.command("update-event", input)).status).toBe(401);
});
