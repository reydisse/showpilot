import { env } from "cloudflare:workers";
import { seedRelayMember } from "@/test/relay-fixtures";
import { afterEach, expect, it, vi } from "vitest";
import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { timecodeFixture } from "@/test/timecode-fixtures";
import type { AutomationEvent, TimecodeState } from "@/types/timecode";
afterEach(async () => { vi.unstubAllGlobals(); await abortAllDurableObjects(); });
function review(event: AutomationEvent) {
  return { id: event.id, revision: event.editRevision ?? null, executionId: event.executionId ?? null,
    status: event.executionStatus ?? "scheduled", attempts: event.executionAttempts ?? 0,
    fired: event.fired, skipped: event.skipped === true, enabled: event.enabled };
}
async function fixture() {
  const room = await timecodeFixture();
  const command = async (action: string, payload?: unknown) => {
    const response = await room.stub.fetch(room.url("/command"), { method: "POST", body: JSON.stringify({ action, payload }) });
    return { status: response.status, body: await response.json() };
  };
  const state = async () => (await room.stub.fetch(room.url("/state"))).json<TimecodeState>();
  const events = async () => (await room.stub.fetch(room.url("/events"))).json<AutomationEvent[]>();
  const cue = async (id = "cue", action = "lyrics-clear", payload = {}) => command("add-event", { id, label: id, action, payload,
    triggerTimecode: { hours: 0, minutes: 0, seconds: 10, frames: 0 } });
  const control = async (operation: string, id = "cue") => {
    const current = await state(), timeline = await events();
    return { requestId: crypto.randomUUID(), showId: room.target.showId, serviceDate: room.target.serviceDate, operation, confirmed: true, gateRevision: current.automationRevision,
      expected: timeline.filter(event => operation === "reset" || event.id === id).map(review),
      ...(operation === "reset" ? { clock: { showId: room.target.showId, serviceDate: room.target.serviceDate, frame: current.totalFrames,
        format: current.format, incomingFormatId: current.incomingFormat?.id ?? null } } : {}) };
  };
  await cue(); return { ...room, command, state, events, cue, control };
}
it("disables one cue and preserves later enable on same-request recovery", async () => {
  const f = await fixture(), input = await f.control("disable");
  expect(await f.command("control-cues", input)).toMatchObject({ status: 200, body: { outcome: "applied" } });
  expect((await f.events())[0].enabled).toBe(false);
  await f.command("set-event-enabled", { id: "cue", enabled: true });
  await evictDurableObject(f.stub);
  expect(await f.command("control-cues", input)).toMatchObject({ status: 200 });
  expect((await f.events())[0].enabled).toBe(true);
});
it("refuses a delete if the cue changed after confirmation was opened", async () => {
  const f = await fixture(), input = await f.control("remove");
  await f.command("update-event", { id: "cue", updates: { label: "Changed" } });
  expect(await f.command("control-cues", input)).toMatchObject({ status: 409, body: { outcome: "conflict" } });
  expect((await f.events())[0].label).toBe("Changed");
});
it("re-arms only the reviewed cue and cannot erase a later firing on retry", async () => {
  const f = await fixture(); await f.cue("other");
  await f.command("fire-event", { id: "cue" }); await f.command("fire-event", { id: "other" });
  const input = await f.control("rearm");
  expect(await f.command("control-cues", input)).toMatchObject({ status: 200 });
  expect((await f.events()).map(event => [event.id, event.fired])).toEqual([["cue", false], ["other", true]]);
  await f.command("fire-event", { id: "cue" });
  await f.command("control-cues", input);
  expect((await f.events())[0].fired).toBe(true);
});
it("reset requires the same stopped clock and complete reviewed timeline", async () => {
  const f = await fixture(), input = await f.control("reset");
  await f.cue("new");
  expect(await f.command("control-cues", input)).toMatchObject({ status: 409 });
  const next = await f.control("reset"); await f.command("start");
  expect(await f.command("control-cues", next)).toMatchObject({ status: 409 });
});

it("retry reserves one dispatch across concurrent requests and preserves later firing", async () => {
  const f = await fixture(); await f.command("remove-event", { id: "cue" });
  await f.cue("hook", "custom-webhook", { url: "https://hooks.example.com/test" });
  const fetcher = vi.fn().mockImplementationOnce(async () => new Response("Failed", { status: 500 })).mockImplementation(async () => Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetcher);
  await f.command("fire-event", { id: "hook" });
  expect((await f.events())[0].executionStatus).toBe("failed");
  const retry = await f.control("retry", "hook");
  const replies = await Promise.all([f.command("control-cues", retry), f.command("control-cues", retry)]);
  expect(replies.map(reply => reply.status)).toEqual([200, 200]); expect(fetcher).toHaveBeenCalledTimes(2);
  expect((await f.events())[0]).toMatchObject({ fired: true, executionStatus: "acknowledged" });
  await evictDurableObject(f.stub); await f.command("control-cues", retry);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(await f.command("control-cues", await f.control("refire", "hook"))).toMatchObject({ status: 200 });
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it("keeps failed delivery separate from accepting a retry request", async () => {
  const f = await fixture(); await f.cue("hook", "custom-webhook", { url: "https://hooks.example.com/test" });
  const fetcher = vi.fn(async () => new Response("Failed", { status: 500 })); vi.stubGlobal("fetch", fetcher);
  await f.command("fire-event", { id: "hook" }); const retry = await f.control("retry", "hook");
  expect(await f.command("control-cues", retry)).toMatchObject({ status: 200, body: { outcome: "applied" } });
  expect((await f.events()).find(event => event.id === "hook")).toMatchObject({ fired: false, executionStatus: "failed" });
  await f.command("control-cues", retry); expect(fetcher).toHaveBeenCalledTimes(2);
});
it("disables a dispatching cue without losing its later acknowledgement", async () => {
  const f = await fixture(); await f.cue("hook", "custom-webhook", { url: "https://hooks.example.com/test" });
  let sent = false;
  vi.stubGlobal("fetch", vi.fn(async () => { sent = true; await new Promise(resolve => setTimeout(resolve, 1000)); return Response.json({ ok: true }); }));
  const firing = f.command("control-cues", await f.control("fire", "hook"));
  await expect.poll(() => sent).toBe(true);
  try {
    expect(await f.command("control-cues", await f.control("remove", "hook"))).toMatchObject({ status: 409 });
    expect(await f.command("control-cues", await f.control("disable", "hook"))).toMatchObject({ status: 200 });
  } finally { await firing; }
  expect((await f.events()).find(event => event.id === "hook")).toMatchObject({ enabled: false, fired: true, executionStatus: "acknowledged" });
});
it("a stop cancels a queued reviewed output even if automation resumes before dispatch", async () => {
  const f = await fixture();
  await f.cue("first", "custom-webhook", { url: "https://hooks.example.com/queue" });
  await f.cue("second", "custom-webhook", { url: "https://hooks.example.com/queue" });
  let sent = false;
  const fetcher = vi.fn(async () => { sent = true; await new Promise(resolve => setTimeout(resolve, 1000)); return Response.json({ ok: true }); });
  vi.stubGlobal("fetch", fetcher);
  const first = f.command("fire-event", { id: "first" }); await expect.poll(() => sent).toBe(true);
  const queued = f.command("control-cues", await f.control("fire", "second"));
  await expect.poll(async () => (await f.events()).find(event => event.id === "second")?.executionStatus).toBe("dispatching");
  try {
    await f.command("set-triggers-enabled", { enabled: false }); await f.command("set-triggers-enabled", { enabled: true });
  } finally { await Promise.all([first, queued]); }
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((await f.events()).find(event => event.id === "second")).toMatchObject({ fired: false, executionStatus: "failed", executionError: expect.stringContaining("changed") });
});
it("old delete receipts cannot remove a replacement cue with the same ID", async () => {
  const f = await fixture(), input = await f.control("remove");
  await f.command("control-cues", input);
  await f.command("replace-event-group", { sourceKey: "replacement", events: [{ id: "cue", label: "Replacement", action: "lyrics-clear", payload: {}, triggerTimecode: { hours: 0, minutes: 0, seconds: 10, frames: 0 } }] });
  await f.command("control-cues", input);
  expect((await f.events())[0].label).toBe("Replacement");
});
it("rejects malformed, unconfirmed and reused identities without changing cues", async () => {
  const f = await fixture(), input = await f.control("remove");
  expect(await f.command("control-cues")).toMatchObject({ status: 400 });
  expect(await f.command("control-cues", { ...input, confirmed: false })).toMatchObject({ status: 400 });
  expect(await f.command("control-cues", { ...input, confirmed: true })).toMatchObject({ status: 409 });
  expect(await f.command("control-cues", { ...input, requestId: crypto.randomUUID(), serviceDate: "2000-01-01" })).toMatchObject({ status: 409 });
  expect(await f.events()).toHaveLength(1);
});
it("reset preserves disabled flags and old reset receipts cannot erase newer execution", async () => {
  const f = await fixture(); await f.command("fire-event", { id: "cue" }); await f.cue("disabled");
  await f.command("set-event-enabled", { id: "disabled", enabled: false });
  const input = await f.control("reset"); expect(await f.command("control-cues", input)).toMatchObject({ status: 200 });
  expect((await f.events()).map(event => [event.id, event.fired, event.enabled])).toEqual([["cue", false, true], ["disabled", false, false]]);
  await f.command("fire-event", { id: "cue" }); await f.command("control-cues", input);
  expect((await f.events())[0].fired).toBe(true);
});
it("does not reset after clock movement and rejects fire while disabled or already fired", async () => {
  const f = await fixture(), reset = await f.control("reset");
  await f.command("set-timecode", { timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 } });
  expect(await f.command("control-cues", reset)).toMatchObject({ status: 409 });
  await f.command("set-event-enabled", { id: "cue", enabled: false });
  expect(await f.command("control-cues", await f.control("fire"))).toMatchObject({ status: 409 });
  await f.command("control-cues", await f.control("enable"));
  expect(await f.command("control-cues", await f.control("fire"))).toMatchObject({ status: 200 });
  expect(await f.command("control-cues", await f.control("fire"))).toMatchObject({ status: 409 });
  expect(await f.command("control-cues", await f.control("retry"))).toMatchObject({ status: 409 });
});

it("rechecks permission after a reviewed cue waits behind another output", async () => {
  const f = await fixture(); await f.cue("first", "custom-webhook", { url: "https://hooks.example.com/queue" }); await f.cue("second", "custom-webhook", { url: "https://hooks.example.com/queue" });
  let sent = false; const fetcher = vi.fn(async () => { sent = true; await new Promise(resolve => setTimeout(resolve, 1000)); return Response.json({ ok: true }); });
  vi.stubGlobal("fetch", fetcher);
  const first = f.command("fire-event", { id: "first" }); await expect.poll(() => sent).toBe(true);
  const second = f.command("control-cues", await f.control("fire", "second"));
  await expect.poll(async () => (await f.events()).find(event => event.id === "second")?.executionStatus).toBe("dispatching");
  await env.DB.prepare("DELETE FROM member WHERE organizationId = ? AND userId = ?").bind(f.orgId, f.authority.userId).run();
  await Promise.all([first, second]);
  await seedRelayMember(f.orgId, f.authority.userId);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((await f.events()).find(event => event.id === "second")).toMatchObject({ executionStatus: "failed", executionError: expect.stringContaining("access changed") });
});
it("an interrupted timer retry preserves its delivery identity and original deadline", async () => {
  const f = await fixture(); await f.cue("timer", "timer-start", { name: "Speaker", durationMs: 300000 });
  await f.command("fire-event", { id: "timer" });
  const first = (await f.events()).find(event => event.id === "timer");
  const timers = async () => (await f.stub.fetch(f.url("/state", "read"))).json<{ namedTimers: { timers: unknown[] } }>();
  const original = (await timers()).namedTimers.timers;
  await runInDurableObject(f.stub, async (_instance, ctx) => {
    const snapshot = await ctx.storage.get<{ events: AutomationEvent[] }>("timecode");
    const event = snapshot?.events.find(event => event.id === "timer");
    if (!snapshot || !event) throw new Error("Missing timer fixture");
    event.fired = false; event.executionStatus = "dispatching"; await ctx.storage.put("timecode", snapshot);
  });
  await evictDurableObject(f.stub);
  expect(await f.command("control-cues", await f.control("retry", "timer"))).toMatchObject({ status: 200 });
  expect((await timers()).namedTimers.timers).toEqual(original);
  expect((await f.events()).find(event => event.id === "timer")?.executionId).toBe(first?.executionId);
});

it("rejects an old fire request that arrives after a newer Stop and Resume", async () => {
  const f = await fixture(), input = await f.control("fire");
  await f.command("set-triggers-enabled", { enabled: false });
  await f.command("set-triggers-enabled", { enabled: true });
  expect(await f.command("control-cues", input)).toMatchObject({ status: 409, body: { outcome: "conflict" } });
  expect((await f.events())[0].fired).toBe(false);
});
