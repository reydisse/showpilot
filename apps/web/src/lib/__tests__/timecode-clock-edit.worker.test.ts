import { afterEach, expect, it, vi } from "vitest";
import { abortAllDurableObjects, evictDurableObject } from "cloudflare:test";
import { timecodeFixture } from "@/test/timecode-fixtures";
import type { TimecodeState, AutomationEvent } from "@/types/timecode";

afterEach(async () => { vi.unstubAllGlobals(); await abortAllDurableObjects(); });
async function fixture() {
  const room = await timecodeFixture();
  const command = async (action: string, payload?: unknown) => {
    const response = await room.stub.fetch(room.url("/command"), { method: "POST", body: JSON.stringify({ action, payload }) });
    return { status: response.status, body: await response.json() };
  };
  const state = async () => (await room.stub.fetch(room.url("/state"))).json<TimecodeState>();
  const review = async () => {
    const current = await state();
    return { showId: room.target.showId, serviceDate: room.target.serviceDate, frame: current.totalFrames,
      format: current.format, incomingFormatId: current.incomingFormat?.id ?? null };
  };
  const seek = async (seconds = 10) => ({ requestId: crypto.randomUUID(), kind: "seek", confirmed: true,
    expected: await review(), timecode: { hours: 0, minutes: 0, seconds, frames: 0 } });
  return { ...room, command, state, review, seek };
}
it("confirms a reviewed seek with actor and request identity", async () => {
  const f = await fixture(), input = await f.seek();
  expect(await f.command("edit-clock", input)).toMatchObject({ status: 200, body: {
    outcome: "applied", requestId: input.requestId, userId: f.authority.userId, showId: f.target.showId,
  } });
  expect(await f.state()).toMatchObject({ totalFrames: 300, running: false, triggersEnabled: false });
});
it("does not replay a successful seek after later clock movement and eviction", async () => {
  const f = await fixture(), input = await f.seek();
  await f.command("edit-clock", input);
  await f.command("set-timecode", { timecode: { hours: 0, minutes: 0, seconds: 20, frames: 0 } });
  await evictDurableObject(f.stub);
  expect(await f.command("edit-clock", input)).toMatchObject({ status: 200, body: { outcome: "applied" } });
  expect((await f.state()).totalFrames).toBe(600);
});
it("rejects a seek when the reviewed position changed", async () => {
  const f = await fixture(), input = await f.seek();
  await f.command("set-timecode", { timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 } });
  expect(await f.command("edit-clock", input)).toMatchObject({ status: 409, body: { outcome: "conflict" } });
  expect((await f.state()).totalFrames).toBe(30);
});
it("does not turn a rejected request into a seek if the old position returns", async () => {
  const f = await fixture(), input = await f.seek();
  await f.command("set-timecode", { timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 } });
  await f.command("edit-clock", input);
  await f.command("set-timecode", { timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 } });
  expect((await f.command("edit-clock", input)).status).toBe(409);
  expect((await f.state()).totalFrames).toBe(0);
});
it("rejects a running source even if its current frame matches the review", async () => {
  const f = await fixture(), input = await f.seek();
  await f.command("start");
  expect(await f.command("edit-clock", input)).toMatchObject({ status: 409, body: { outcome: "conflict" } });
  expect((await f.state()).totalFrames).toBe(0);
});
it("reformats only after an explicit current review and preserves an old receipt", async () => {
  const f = await fixture();
  const input = { requestId: crypto.randomUUID(), kind: "reformat", confirmed: true, expected: await f.review(), format: { frameRate: 25, dropFrame: "ndf" } };
  expect(await f.command("edit-clock", input)).toMatchObject({ status: 200, body: { outcome: "applied" } });
  await f.command("set-format", { format: { frameRate: 24, dropFrame: "ndf" }, expectedFormat: input.format, confirmed: true });
  expect(await f.command("edit-clock", input)).toMatchObject({ status: 200, body: { outcome: "applied" } });
  expect((await f.state()).format.frameRate).toBe(24);
});
it("rejects invalid target time with an authoritative result", async () => {
  const f = await fixture(), input = await f.seek();
  input.timecode.frames = 30;
  expect(await f.command("edit-clock", input)).toMatchObject({ status: 400, body: { outcome: "rejected" } });
  expect((await f.state()).totalFrames).toBe(0);
});
it("rejects different intent under an existing request identity", async () => {
  const f = await fixture(), input = await f.seek();
  await f.command("edit-clock", input);
  expect(await f.command("edit-clock", { ...input, timecode: { ...input.timecode, seconds: 20 } })).toMatchObject({ status: 409, body: { outcome: "conflict" } });
  expect((await f.state()).totalFrames).toBe(300);
});

it("recalculates dispatch frames with the new rate and preserves cue history", async () => {
  const f = await fixture(), id = crypto.randomUUID();
  await f.command("add-event", { id, label: "Timed cue", action: "lyrics-clear", payload: {}, leadMs: 1000,
    triggerTimecode: { hours: 0, minutes: 0, seconds: 10, frames: 0 } });
  await f.command("fire-event", { id });
  const read = async () => (await f.stub.fetch(f.url("/events"))).json<AutomationEvent[]>();
  const before = (await read())[0];
  expect(before.fired).toBe(true);
  expect(await f.command("edit-clock", { requestId: crypto.randomUUID(), kind: "reformat", confirmed: true,
    expected: await f.review(), format: { frameRate: 25, dropFrame: "ndf" } })).toMatchObject({ status: 200 });
  expect((await read())[0]).toMatchObject({ fired: true, executionId: before.executionId, triggerFrame: 250, dispatchFrame: 225 });
});
it("waits for in-flight cue acknowledgement before reformatting", async () => {
  const f = await fixture(), id = crypto.randomUUID();
  await f.command("add-event", { id, label: "In flight", action: "custom-webhook", payload: { url: "https://hooks.example.com/test" },
    triggerTimecode: { hours: 0, minutes: 0, seconds: 10, frames: 0 } });
  let dispatched = false;
  vi.stubGlobal("fetch", vi.fn(async () => {
    dispatched = true;
    await new Promise(resolve => setTimeout(resolve, 1000));
    return Response.json({ ok: true });
  }));
  const firing = f.command("fire-event", { id });
  await expect.poll(() => dispatched).toBe(true);
  try {
    expect(await f.command("edit-clock", { requestId: crypto.randomUUID(), kind: "reformat", confirmed: true,
      expected: await f.review(), format: { frameRate: 25, dropFrame: "ndf" } })).toMatchObject({ status: 400, body: { outcome: "rejected", message: expect.stringContaining("in-flight") } });
  } finally { await firing; }
  const events = await (await f.stub.fetch(f.url("/events"))).json<AutomationEvent[]>();
  expect(events[0]).toMatchObject({ fired: true, executionStatus: "acknowledged" });
});
it("commits one result for concurrent identical requests", async () => {
  const f = await fixture(), input = await f.seek();
  const results = await Promise.all([f.command("edit-clock", input), f.command("edit-clock", input)]);
  expect(results).toEqual([expect.objectContaining({ status: 200 }), expect.objectContaining({ status: 200 })]);
  expect((await f.state()).totalFrames).toBe(300);
});

it("reports malformed clock requests without an unhandled rejection", async () => {
  const f = await fixture();
  expect(await f.command("edit-clock")).toMatchObject({ status: 400, body: { ok: false } });
  expect(await f.command("edit-clock", { ...(await f.seek()), requestId: "invalid" })).toMatchObject({ status: 400, body: { ok: false } });
  expect(await f.command("edit-clock", { ...(await f.seek()), confirmed: false })).toMatchObject({ status: 400, body: { outcome: "rejected" } });
  expect((await f.state()).totalFrames).toBe(0);
});

it("reports invalid legacy clock positions instead of silently returning success", async () => {
  const f = await fixture();
  expect(await f.command("set-timecode", { timecode: { hours: 0, minutes: 60, seconds: 0, frames: 0 } }))
    .toMatchObject({ status: 400, body: { ok: false, error: expect.stringContaining("valid clock time") } });
  expect(await f.command("set-timecode")).toMatchObject({ status: 400, body: { ok: false } });
  expect((await f.state()).totalFrames).toBe(0);
});
