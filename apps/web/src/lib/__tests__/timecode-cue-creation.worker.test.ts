import { afterEach, expect, it } from "vitest";
import { abortAllDurableObjects, evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { timecodeFixture } from "@/test/timecode-fixtures";
import type { AutomationEvent } from "@/types/timecode";

afterEach(() => abortAllDurableObjects());
const cue = () => ({ id: crypto.randomUUID(), label: "Review this cue", action: "lyrics-clear",
  triggerTimecode: { hours: 0, minutes: 0, seconds: 10, frames: 0 }, payload: {},
  expectedFormat: { frameRate: 30, dropFrame: "ndf" }, toleranceFrames: 5 });
async function fixture() {
  const room = await timecodeFixture();
  return { ...room,
    command: async (action: string, payload?: Record<string, unknown>) => {
      const response = await room.stub.fetch(room.url("/command"), { method: "POST", body: JSON.stringify({ action, payload }) });
      return { status: response.status, body: await response.json() };
    },
    events: async () => (await room.stub.fetch(room.url("/events"))).json<AutomationEvent[]>(),
  };
}
it("returns the authoritative identity of the saved cue", async () => {
  const f = await fixture(), input = cue();
  expect(await f.command("add-event", input)).toMatchObject({ status: 200, body: { ok: true, orgId: f.orgId,
    userId: f.authority.userId, requestId: input.id, showId: f.target.showId, outcome: "applied" } });
});
it("does not resurrect a deleted cue when its original save is retried after eviction", async () => {
  const f = await fixture(), input = cue();
  expect((await f.command("add-event", input)).status).toBe(200);
  expect((await f.command("remove-event", { id: input.id })).status).toBe(200);
  await evictDurableObject(f.stub);
  const response = await f.command("add-event", input);
  expect(await f.events()).toEqual([]);
  expect(response).toMatchObject({ status: 200, body: { outcome: "removed", requestId: input.id } });
});
it("preserves later definition edits when an original save is retried", async () => {
  const f = await fixture(), input = cue();
  await f.command("add-event", input);
  await f.command("update-event", { id: input.id, updates: { label: "Later edit" } });
  expect(await f.command("add-event", input)).toMatchObject({ status: 200, body: { outcome: "applied" } });
  expect(await f.events()).toEqual([expect.objectContaining({ label: "Later edit" })]);
});
it("rejects a reused creation identity with different intent", async () => {
  const f = await fixture(), input = cue();
  await f.command("add-event", input);
  expect((await f.command("add-event", { ...input, label: "Different request" })).status).toBe(409);
  expect(await f.events()).toEqual([expect.objectContaining({ label: input.label })]);
});
it("rejects a newly submitted cue if the reviewed format changed", async () => {
  const f = await fixture(), input = cue();
  await f.command("set-format", { format: { frameRate: 25, dropFrame: "ndf" }, expectedFormat: input.expectedFormat, confirmed: true });
  expect((await f.command("add-event", input)).status).toBe(409);
  expect(await f.events()).toEqual([]);
});
it("confirms an old successful save after a later format change without replaying it", async () => {
  const f = await fixture(), input = cue();
  await f.command("add-event", input);
  await f.command("set-format", { format: { frameRate: 25, dropFrame: "ndf" }, expectedFormat: input.expectedFormat, confirmed: true });
  expect(await f.command("add-event", input)).toMatchObject({ status: 200, body: { outcome: "applied" } });
  expect((await f.events())[0].triggerFrame).toBe(250);
});
it("reports invalid cue time instead of silently acknowledging no change", async () => {
  const f = await fixture();
  expect((await f.command("add-event", { ...cue(), triggerTimecode: { hours: 0, minutes: 0, seconds: 10, frames: 30 } })).status).toBe(400);
  expect(await f.events()).toEqual([]);
});
it("commits one cue for concurrent retries of the same request", async () => {
  const f = await fixture(), input = cue();
  const replies = await Promise.all([f.command("add-event", input), f.command("add-event", input)]);
  expect(replies).toEqual([expect.objectContaining({ status: 200 }), expect.objectContaining({ status: 200 })]);
  expect(await f.events()).toHaveLength(1);
});
it("does not apply a rejected save when the original frame rate returns", async () => {
  const f = await fixture(), input = cue(), changed = { frameRate: 25, dropFrame: "ndf" };
  await f.command("set-format", { format: changed, expectedFormat: input.expectedFormat, confirmed: true });
  expect((await f.command("add-event", input)).status).toBe(409);
  await f.command("set-format", { format: input.expectedFormat, expectedFormat: changed, confirmed: true });
  await evictDurableObject(f.stub);
  expect((await f.command("add-event", input)).status).toBe(409);
  expect(await f.events()).toEqual([]);
});
it("does not expose a stored receipt after the member loses access", async () => {
  const f = await fixture(), input = cue();
  await f.command("add-event", input);
  await env.DB.prepare("DELETE FROM member WHERE organizationId = ? AND userId = ?").bind(f.orgId, f.authority.userId).run();
  await evictDurableObject(f.stub);
  const response = await f.stub.fetch(f.url("/command"), { method: "POST", body: JSON.stringify({ action: "add-event", payload: input }) });
  expect(response.status).toBe(401);
  expect(await response.text()).toBe("Unauthorized");
});
it("rejects a save reviewed for an older show date", async () => {
  const f = await fixture();
  expect(await f.command("add-event", { ...cue(), expectedServiceDate: "2020-01-01" })).toMatchObject({ status: 409, body: { outcome: "conflict" } });
  expect(await f.events()).toEqual([]);
});
it("echoes the requested sync identity in an authoritative snapshot", async () => {
  const f = await fixture(), input = cue();
  await f.command("add-event", input);
  const syncId = crypto.randomUUID();
  const response = new Promise<Record<string, unknown>>(resolve => {
    f.controlSocket!.addEventListener("message", function receive(message) {
      const value = JSON.parse(String(message.data));
      if (value.type === "hydrate" && value.syncId === syncId) {
        f.controlSocket!.removeEventListener("message", receive); resolve(value);
      }
    });
  });
  f.controlSocket!.send(JSON.stringify({ type: "sync", syncId }));
  expect(await response).toMatchObject({ syncId, showId: f.target.showId, events: [expect.objectContaining({ id: input.id })] });
});

it("adopts an identical cue from an older timeline and retains the receipt after removal", async () => {
  const f = await fixture(), input = { ...cue(), sourceKey: "legacy-song" };
  expect((await f.command("replace-event-group", { sourceKey: input.sourceKey, events: [input] })).status).toBe(200);
  const original = (await f.events())[0];
  expect(await f.command("add-event", input)).toMatchObject({ status: 200, body: { outcome: "applied" } });
  expect(await f.events()).toEqual([original]);
  await f.command("remove-event", { id: input.id });
  await evictDurableObject(f.stub);
  expect(await f.command("add-event", input)).toMatchObject({ status: 200, body: { outcome: "removed" } });
  expect(await f.events()).toEqual([]);
});
it("rejects a new save that collides with different details from an older timeline", async () => {
  const f = await fixture(), input = { ...cue(), sourceKey: "legacy-song" };
  await f.command("replace-event-group", { sourceKey: input.sourceKey, events: [input] });
  expect(await f.command("add-event", { ...input, label: "Changed draft" })).toMatchObject({ status: 409, body: { outcome: "conflict" } });
  expect(await f.events()).toEqual([expect.objectContaining({ label: input.label })]);
});
it("rejects a label that is structurally valid but absent at the reviewed frame rate", async () => {
  const f = await fixture(), input = cue(), format = { frameRate: 25, dropFrame: "ndf" };
  await f.command("set-format", { format, expectedFormat: input.expectedFormat, confirmed: true });
  expect(await f.command("add-event", { ...input, expectedFormat: format, triggerTimecode: { ...input.triggerTimecode, frames: 25 } }))
    .toMatchObject({ status: 400, body: { outcome: "rejected", message: expect.stringContaining("frame rate") } });
  expect(await f.events()).toEqual([]);
});
it("reports an absent cue payload instead of returning success", async () => {
  const f = await fixture();
  expect(await f.command("add-event")).toMatchObject({ status: 400, body: { ok: false, error: expect.stringContaining("Review the cue") } });
  expect(await f.events()).toEqual([]);
});
it.each(["", "x".repeat(129), 12])("rejects an unusable creation identity %j without saving a cue", async id => {
  const f = await fixture();
  expect(await f.command("add-event", { ...cue(), id })).toMatchObject({ status: 400, body: { ok: false, error: expect.stringContaining("identity") } });
  expect(await f.events()).toEqual([]);
});
