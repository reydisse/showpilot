import { env } from "cloudflare:workers";
import { abortAllDurableObjects, evictDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { timecodeFixture } from "@/test/timecode-fixtures";
import { automationEditReview } from "@/lib/automation-edit";
import { resolveTimecodeDeviceAction } from "@/lib/timecode-device-actions";
import { cueReviewState } from "@/lib/automation-cues";
import type { AutomationEvent, TimecodeFormat } from "@/types/timecode";

afterEach(() => abortAllDurableObjects());
const format: TimecodeFormat = { frameRate: 30, dropFrame: "ndf" };
const time = { hours: 0, minutes: 0, seconds: 10, frames: 0 };
const cue = { id: "cue", action: "lower-third-show", label: "Original", sourceKey: "service", triggerTimecode: time, payload: { line1: "Original" } };
async function fixture() {
  const test = await timecodeFixture();
  const command = async (action: string, payload?: unknown, status = 200) => {
    const response = await test.stub.fetch(test.url("/command"), { method: "POST", body: JSON.stringify({ action, payload }) });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const events = async () => (await test.stub.fetch(test.url("/events"))).json<AutomationEvent[]>();
  return { ...test, command, events, current: async () => (await events())[0] };
}

it("edits a completed cue without changing its identity, routing, enable state or execution history", async () => {
  const test = await fixture();
  await test.command("add-event", cue);
  await test.command("fire-event", { id: cue.id });
  await test.command("set-event-enabled", { id: cue.id, enabled: false });
  const before = await test.current();
  await test.command("update-event", { id: cue.id, expected: automationEditReview(before), expectedFormat: format,
    updates: { label: "Edited", triggerTimecode: { ...time, seconds: 20 }, toleranceFrames: 2, leadMs: 500, payload: { line1: "New text" } } });
  const after = await test.current();
  expect(after).toMatchObject({ id: before.id, action: before.action, sourceKey: before.sourceKey, enabled: false,
    fired: true, executionId: before.executionId, executedAt: before.executedAt, executionStatus: before.executionStatus,
    executionAttempts: before.executionAttempts, triggerFrame: 600, dispatchFrame: 585, label: "Edited", toleranceFrames: 2, payload: { line1: "New text" } });
  expect(after.editRevision).not.toBe(before.editRevision);
  await evictDurableObject(test.stub);
  expect(await test.current()).toEqual(after);
  await test.command("set-event-enabled", { id: cue.id, enabled: true });
  await test.command("fire-event", { id: cue.id }, 400);
});

it.each(["id", "action", "sourceKey", "fired", "executionStatus", "executionId", "executionAttempts", "triggerFrame", "dispatchFrame", "deviceLatencyMs", "enabled", "targetDeviceId", "skipped", "editRevision"])("rejects an entire patch containing server-owned %s", async key => {
  const test = await fixture(); await test.command("add-event", cue);
  const before = await test.current();
  await test.command("update-event", { id: cue.id, updates: { label: "Must not stick", [key]: "forged" } }, 400);
  expect(await test.current()).toEqual(before);
});

it("rejects stale definition reviews and reviews from before firing or re-arming", async () => {
  const test = await fixture(); await test.command("add-event", cue);
  const old = automationEditReview(await test.current());
  await test.command("update-event", { id: cue.id, expected: old, updates: { label: "First save" } });
  await test.command("update-event", { id: cue.id, expected: old, updates: { label: "Lost update" } }, 400);
  const beforeFire = automationEditReview(await test.current());
  await test.command("fire-event", { id: cue.id });
  await test.command("update-event", { id: cue.id, expected: beforeFire, updates: { label: "Not reviewed" } }, 400);
  const fired = await test.current();
  await test.command("rearm-event", { id: cue.id, expected: cueReviewState(fired), confirmed: true });
  await test.command("update-event", { id: cue.id, expected: beforeFire, updates: { label: "ABA overwrite" } }, 400);
  expect((await test.current()).label).toBe("First save");
});

it("rejects missing and dispatching cues explicitly, keeping the live execution intact", async () => {
  const test = await fixture();
  await test.command("update-event", { id: "missing", updates: { label: "New" } }, 400);
  await test.command("add-event", cue);
  const graphics = env.LOWER_THIRDS_RELAY.getByName(test.orgId);
  await (await graphics.fetch("https://test/test/delay", { method: "POST", body: "300" })).text();
  const firing = test.command("fire-event", { id: cue.id });
  await expect.poll(async () => (await test.current()).executionStatus).toBe("dispatching");
  await test.command("update-event", { id: cue.id, updates: { label: "Changed during dispatch" } }, 400);
  await firing;
  expect(await test.current()).toMatchObject({ label: "Original", fired: true, executionAttempts: 1 });
});

it("validates cue frames against the current format and rejects forms reviewed at another rate", async () => {
  const test = await fixture(); await test.command("add-event", cue);
  const newFormat: TimecodeFormat = { frameRate: 25, dropFrame: "ndf" };
  await test.command("set-format", { format: newFormat, expectedFormat: format, confirmed: true });
  const before = await test.current();
  await test.command("update-event", { id: cue.id, expectedFormat: format, updates: { label: "Wrong rate" } }, 400);
  await test.command("update-event", { id: cue.id, expectedFormat: newFormat, updates: { triggerTimecode: { ...time, frames: 25 } } }, 400);
  expect(await test.current()).toEqual(before);
  await test.command("update-event", { id: cue.id, expectedFormat: newFormat, updates: { triggerTimecode: { ...time, frames: 24 } } });
  expect((await test.current()).triggerFrame).toBe(274);
});

it("validates webhook targets on save and leaves rejected changes unapplied", async () => {
  const test = await fixture();
  await test.command("add-event", { ...cue, action: "custom-webhook", payload: { url: "https://example.com/original" } });
  const before = await test.current();
  for (const url of ["http://example.com", "https://127.0.0.1", "https://10.0.0.1", "https://user:pass@example.com", "javascript:alert(1)"]) {
    await test.command("update-event", { id: cue.id, updates: { label: "Unsafe", payload: { url } } }, 400);
    expect(await test.current()).toEqual(before);
  }
  await test.command("update-event", { id: cue.id, updates: { payload: { url: "https://example.com/updated" } } });
  expect(await test.current()).toMatchObject({ label: "Original", fired: false, payload: { url: "https://example.com/updated" } });
});


it("applies a structured device selection over legacy routing fields without re-arming", async () => {
  const test = await fixture();
  for (const [id, host] of [["old", "10.0.0.1"], ["new", "10.0.0.2"]]) {
    await env.DB.prepare("INSERT INTO device (id,orgId,name,adapterType,category,settings,enabled,createdAt,updatedAt) VALUES (?,?,?,'atem','video',?,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)")
      .bind(`${test.orgId}-${id}`, test.orgId, id, JSON.stringify({ host })).run();
  }
  await test.command("add-event", { ...cue, action: "device-action", targetDeviceId: `${test.orgId}-old`, targetActionId: "set_preview_input", payload: { input: 1 } });
  const before = await test.current();
  await test.command("update-event", { id: cue.id, expected: automationEditReview(before), updates: { payload: { deviceId: `${test.orgId}-new`, actionId: "set_program_input", params: { input: 3 } } } });
  const edited = await test.current();
  expect(edited.targetDeviceId).toBeUndefined(); expect(edited.targetActionId).toBeUndefined();
  expect(edited).toMatchObject({ id: cue.id, fired: false, executionAttempts: 0 });
  const resolved = await resolveTimecodeDeviceAction(env.DB, test.orgId, edited);
  expect(resolved).toMatchObject({ deviceId: `${test.orgId}-new`, target: "10.0.0.2:9910" });
  expect(JSON.parse(resolved.command)).toEqual({ actionId: "set_program_input", params: { input: 3 } });
  await test.command("update-event", { id: cue.id, updates: { payload: { deviceId: "", actionId: "set_program_input" } } }, 400);
  expect(await test.current()).toEqual(edited);
});
