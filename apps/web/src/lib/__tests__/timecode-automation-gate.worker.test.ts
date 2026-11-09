import { env } from "cloudflare:workers";
import { seedRelayMember } from "@/test/relay-fixtures";
import { afterEach, expect, it } from "vitest";
import { abortAllDurableObjects, evictDurableObject } from "cloudflare:test";
import { timecodeFixture } from "@/test/timecode-fixtures";
import type { TimecodeState } from "@/types/timecode";
afterEach(async () => { await abortAllDurableObjects(); });
async function fixture() {
  const room = await timecodeFixture();
  const command = async (action: string, payload?: unknown) => {
    const response = await room.stub.fetch(room.url("/command"), { method: "POST", body: JSON.stringify({ action, payload }) });
    return { status: response.status, body: await response.json() };
  };
  const state = async () => (await room.stub.fetch(room.url("/state"))).json<TimecodeState>();
  const gate = async (operation: "stop" | "resume" | "resume-automatic" = "stop") => {
    const current = await state();
    return { requestId: crypto.randomUUID(), operation, showId: room.target.showId, serviceDate: room.target.serviceDate,
      ...(operation !== "stop" ? { confirmed: true, expected: { revision: current.automationRevision, holdId: current.automationHold?.id ?? null } } : {}) };
  };
  return { ...room, command, state, gate };
}
it("stops automation without stopping the clock and does not repeat an old stop", async () => {
  const f = await fixture(); await f.command("start");
  const stop = await f.gate();
  expect(await f.command("edit-automation-gate", stop)).toMatchObject({ status: 200, body: { outcome: "applied", requestId: stop.requestId } });
  expect(await f.state()).toMatchObject({ triggersEnabled: false, running: true });
  await f.command("set-triggers-enabled", { enabled: true });
  await evictDurableObject(f.stub);
  expect(await f.command("edit-automation-gate", stop)).toMatchObject({ status: 200 });
  expect((await f.state()).triggersEnabled).toBe(true);
});
it("resumes a reviewed jump at the current frame without resetting fired cues", async () => {
  const f = await fixture();
  await f.command("set-timecode", { timecode: { hours: 0, minutes: 0, seconds: 20, frames: 0 } });
  expect((await f.state()).automationHold).toBeTruthy();
  expect(await f.command("edit-automation-gate", await f.gate("resume"))).toMatchObject({ status: 200, body: { outcome: "applied" } });
  expect(await f.state()).toMatchObject({ triggersEnabled: true, automationHold: null, totalFrames: 600 });
});
it("a newer stop invalidates an older resume even when automation was already off", async () => {
  const f = await fixture(); await f.command("set-triggers-enabled", { enabled: false });
  const resume = await f.gate("resume");
  await f.command("edit-automation-gate", await f.gate());
  expect(await f.command("edit-automation-gate", resume)).toMatchObject({ status: 409, body: { outcome: "conflict" } });
  expect((await f.state()).triggersEnabled).toBe(false);
});
it("a lost resume reply cannot re-enable automation after a subsequent stop", async () => {
  const f = await fixture(); await f.command("set-triggers-enabled", { enabled: false });
  const resume = await f.gate("resume");
  await f.command("edit-automation-gate", resume);
  await f.command("edit-automation-gate", await f.gate());
  await evictDurableObject(f.stub);
  expect(await f.command("edit-automation-gate", resume)).toMatchObject({ status: 200, body: { outcome: "applied" } });
  expect((await f.state()).triggersEnabled).toBe(false);
});
it("requires a confirmed current review and rejects a different show date", async () => {
  const f = await fixture();
  expect(await f.command("edit-automation-gate", { ...await f.gate("resume"), confirmed: false })).toMatchObject({ status: 400 });
  expect(await f.command("edit-automation-gate", { ...await f.gate(), serviceDate: "2000-01-01" })).toMatchObject({ status: 409 });
  expect((await f.state()).triggersEnabled).toBe(true);
});
it("resolves one receipt for simultaneous copies and rejects identity reuse", async () => {
  const f = await fixture(), stop = await f.gate();
  const results = await Promise.all([f.command("edit-automation-gate", stop), f.command("edit-automation-gate", stop)]);
  expect(results.map(value => value.status)).toEqual([200, 200]);
  expect(await f.command("edit-automation-gate", { ...await f.gate("resume"), requestId: stop.requestId })).toMatchObject({ status: 409 });
  expect((await f.state()).triggersEnabled).toBe(false);
});

it("resumes automatic cues independently and cannot bypass the global kill switch", async () => {
  const f = await fixture();
  await f.command("add-event", { id: "pause", label: "Pause automatic cues", action: "triggers-disable", payload: {}, triggerTimecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 } });
  await f.command("fire-event", { id: "pause" });
  expect((await f.state()).automaticCuesEnabled).toBe(false);
  await f.command("edit-automation-gate", await f.gate());
  expect(await f.command("edit-automation-gate", await f.gate("resume-automatic"))).toMatchObject({ status: 409 });
  await f.command("edit-automation-gate", await f.gate("resume"));
  expect(await f.state()).toMatchObject({ triggersEnabled: true, automaticCuesEnabled: false });
  expect(await f.command("edit-automation-gate", await f.gate("resume-automatic"))).toMatchObject({ status: 200 });
  expect((await f.state()).automaticCuesEnabled).toBe(true);
});
it("keeps denied requests denied if a later change restores their original state", async () => {
  const f = await fixture(), resume = await f.gate("resume");
  await f.command("edit-automation-gate", await f.gate());
  expect(await f.command("edit-automation-gate", resume)).toMatchObject({ status: 409 });
  await f.command("set-triggers-enabled", { enabled: true });
  expect(await f.command("edit-automation-gate", resume)).toMatchObject({ status: 409 });
});
it("invalidates reviews after clock reformat and rejects malformed operations", async () => {
  const f = await fixture(), resume = await f.gate("resume");
  await f.command("set-format", { format: { frameRate: 25, dropFrame: "ndf" }, expectedFormat: { frameRate: 30, dropFrame: "ndf" }, confirmed: true });
  expect(await f.command("edit-automation-gate", resume)).toMatchObject({ status: 409 });
  expect(await f.command("edit-automation-gate", { ...await f.gate(), operation: "toggle" })).toMatchObject({ status: 400, body: { outcome: "rejected" } });
  expect(await f.command("edit-automation-gate")).toMatchObject({ status: 400, body: { ok: false } });
});

it("requires current membership and control even when returning an old receipt", async () => {
  const f = await fixture(), stop = await f.gate();
  await f.command("edit-automation-gate", stop);
  const other = await seedRelayMember(f.orgId, `${f.orgId}-other`);
  const url = f.url("/command"); url.searchParams.set("authUserId", other.userId); url.searchParams.set("authSessionId", other.sessionId);
  const response = await f.stub.fetch(url, { method: "POST", body: JSON.stringify({ action: "edit-automation-gate", payload: stop }) });
  expect(response.status).toBe(409); await response.arrayBuffer();
  await env.DB.prepare("DELETE FROM member WHERE organizationId = ? AND userId = ?").bind(f.orgId, f.authority.userId).run();
  const denied = await f.stub.fetch(f.url("/command"), { method: "POST", body: JSON.stringify({ action: "edit-automation-gate", payload: stop }) });
  expect(denied.status).toBe(401); await denied.arrayBuffer();
});
it("blocks resume until a detected input format has been reviewed", async () => {
  const f = await fixture(); await f.command("start");
  for (let frames = 0; frames < 5; frames++) await f.command("feed-tc", { timecode: { hours: 0, minutes: 0, seconds: 0, frames }, format: { frameRate: 25, dropFrame: "ndf" } });
  expect((await f.state()).incomingFormat).toBeTruthy();
  expect(await f.command("edit-automation-gate", await f.gate("resume"))).toMatchObject({ status: 409, body: { message: expect.stringContaining("input format") } });
  expect((await f.state()).triggersEnabled).toBe(false);
});
it("does not replay cues crossed while stopped or re-arm previously fired cues", async () => {
  const f = await fixture();
  for (const [id, frames] of [["fired", 1], ["crossed", 3]] as const) await f.command("add-event", { id, label: id, action: "lyrics-clear", payload: {}, toleranceFrames: 0, triggerTimecode: { hours: 0, minutes: 0, seconds: 0, frames } });
  await f.command("start");
  const feed = (frames: number) => f.command("feed-tc", { timecode: { hours: 0, minutes: 0, seconds: 0, frames }, format: { frameRate: 30, dropFrame: "ndf" } });
  await feed(0); await feed(1);
  await f.command("edit-automation-gate", await f.gate());
  await feed(4);
  await f.command("edit-automation-gate", await f.gate("resume"));
  await feed(5);
  const events = await (await f.stub.fetch(f.url("/events"))).json<{ id: string; fired: boolean }[]>();
  expect(events).toEqual([expect.objectContaining({ id: "fired", fired: true }), expect.objectContaining({ id: "crossed", fired: false })]);
});
