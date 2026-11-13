import { env } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { timecodeFixture } from "@/test/timecode-fixtures";
import { openTestBridge, approveTestBridgeTarget } from "@/test/bridge-fixtures";
import type { AutomationEvent } from "@/types/timecode";
import { timecodeRelayKey } from "../timecode-target.server";
import { resolveTimecodeDeviceAction } from "../timecode-device-actions";

afterEach(abortAllDurableObjects);
const atZero = { hours: 0, minutes: 0, seconds: 0, frames: 0 };
const format = { frameRate: 30, dropFrame: "ndf" } as const;
const cue = { id: "jump", label: "Jump to Message", triggerTimecode: atZero, action: "rundown-goto-item", payload: { itemId: "message" } };

async function fixture(orgId?: string, showId?: string) {
  const test = await timecodeFixture(orgId, showId);
  const rundown = env.RUNDOWN_RELAY.getByName(timecodeRelayKey(test.target));
  const rundownUrl = (path: string, access = "control") => { const url = test.url(path); url.searchParams.set("access", access); return url; };
  const rundownCommand = async (action: string, payload?: unknown, status = 200) => {
    const response = await rundown.fetch(rundownUrl("/command"), { method: "POST", body: JSON.stringify({ id: crypto.randomUUID(), action, payload }) });
    expect(response.status).toBe(status); await response.text();
  };
  for (const [id, title, type] of [["welcome", "Welcome", "segment"], ["heading", "Main", "header"], ["message", "Message", "segment"]]) {
    await rundownCommand("add-item", { id, title, type, duration: 60000, notes: "", assignee: "", cue: "", hardStop: false });
  }
  return {
    ...test, rundown, rundownCommand,
    state: async () => (await rundown.fetch(rundownUrl("/state"))).json<{ timer: { playback: string; currentItemId: string | null; elapsed: number; startedAt: number; pausedAt: number | null }; items: { id: string; status: string; actualStart: string; actualEnd: string | null }[] }>(),
    command: async (action: string, payload?: unknown, status = 200) => {
      const response = await test.stub.fetch(test.url("/command"), { method: "POST", body: JSON.stringify({ action, payload }) });
      expect(response.status).toBe(status); await response.text();
    },
    events: async () => (await test.stub.fetch(test.url("/events"))).json<AutomationEvent[]>(),
  };
}

it("fires a show-scoped named jump from a paused item and leaves unselected rows unchanged", async () => {
  const test = await fixture();
  await test.rundownCommand("timer-start", { itemId: "welcome" });
  await test.rundownCommand("timer-pause");
  await test.rundownCommand("timer-adjust", { deltaMs: -42000 });
  expect((await test.state()).timer.elapsed).toBeGreaterThanOrEqual(42000);
  await test.command("add-event", cue);
  await test.command("start");
  await test.command("feed-tc", { timecode: atZero, format });
  const result = await test.state();
  expect(result.timer).toMatchObject({ currentItemId: "message", elapsed: 0, playback: "play", pausedAt: null });
  expect(result.items.map(item => item.status)).toEqual(["complete", "upcoming", "live"]);
  expect((await test.events())[0]).toMatchObject({ fired: true, executionStatus: "acknowledged" });
  await test.command("feed-tc", { timecode: { ...atZero, frames: 1 }, format });
  expect((await test.state()).timer.startedAt).toBe(result.timer.startedAt);
});

it.each(["heading", "other-show-item", "removed"])("fails a jump to %s without altering the live item", async itemId => {
  const test = await fixture();
  if (itemId === "other-show-item") {
    const other = await fixture(test.orgId, `${test.orgId}-other-show`);
    await other.rundownCommand("add-item", { id: itemId, title: "Other show item", type: "segment", duration: 60000, notes: "", assignee: "", cue: "", hardStop: false });
  }
  if (itemId === "removed") {
    await test.rundownCommand("add-item", { id: itemId, title: "Removed item", type: "segment", duration: 60000, notes: "", assignee: "", cue: "", hardStop: false });
    await test.rundownCommand("remove-item", { id: itemId });
  }
  await test.rundownCommand("timer-start", { itemId: "welcome" });
  const before = await test.state();
  await test.command("add-event", { ...cue, payload: { itemId } });
  await test.command("fire-event", { id: cue.id });
  expect((await test.events())[0]).toMatchObject({ fired: false, executionStatus: "failed" });
  const after = await test.state();
  expect(after.items).toEqual(before.items);
  expect(after.timer).toMatchObject({ currentItemId: before.timer.currentItemId, elapsed: before.timer.elapsed, startedAt: before.timer.startedAt, playback: before.timer.playback });
});

it("validates jump details on every timeline write and honors disable, retry and reviewed re-fire", async () => {
  const test = await fixture();
  await test.command("add-event", { ...cue, enabled: false });
  await test.command("fire-event", { id: cue.id }, 400);
  for (const itemId of [null, "", " ", "x".repeat(201)]) {
    await test.command("add-event", { ...cue, id: crypto.randomUUID(), payload: { itemId } }, 400);
    await test.command("update-event", { id: cue.id, updates: { payload: { itemId } } }, 400);
    await test.command("replace-event-group", { sourceKey: "jump", events: [{ ...cue, payload: { itemId } }] }, 400);
  }
  await test.command("set-event-enabled", { id: cue.id, enabled: true });
  await test.command("update-event", { id: cue.id, updates: { payload: { itemId: "missing" } } });
  await test.command("fire-event", { id: cue.id });
  expect((await test.events())[0].fired).toBe(false);
  await test.command("update-event", { id: cue.id, updates: { payload: cue.payload } });
  await test.command("retry-event", { id: cue.id });
  const first = (await test.events())[0];
  expect(first.fired).toBe(true);
  await test.command("fire-event", { id: cue.id }, 400);
  await test.rundownCommand("timer-pause");
  await test.rundownCommand("timer-adjust", { deltaMs: -42000 });
  await test.command("rearm-event", { id: cue.id, confirmed: true, expected: { fired: true, skipped: false, executionId: first.executionId } });
  await test.command("fire-event", { id: cue.id });
  expect((await test.state()).timer).toMatchObject({ elapsed: 0, playback: "play" });
});

async function device(orgId: string, id: string = crypto.randomUUID(), adapterType = "dmx-artnet", category = "lighting", enabled = 1) {
  await env.DB.prepare("INSERT INTO device (id,orgId,name,category,adapterType,settings,enabled,latencyMs,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,200,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)")
    .bind(id, orgId, id, category, adapterType, JSON.stringify({ host: "192.168.1.50", universe: 0, scenes: { bright: { "1": 255 } } }), enabled).run();
  return id;
}

it("sends only a dedicated blackout, with captured latency, and waits for its acknowledgment", async () => {
  const test = await fixture();
  const id = await device(test.orgId);
  const target = "192.168.1.50:6454";
  await approveTestBridgeTarget(test.orgId, "dmx-artnet", target);
  const bridge = await openTestBridge(test.orgId);
  bridge.socket.send(JSON.stringify({ type: "device-status", target, connected: true }));
  await expect.poll(async () => (await bridge.stub.getBridgeStatus()).connectedTargets).toContain(target);
  const messages: { id: string; command: string }[] = [];
  bridge.socket.addEventListener("message", event => { const message = JSON.parse(String(event.data)); if (message.type === "command") messages.push(message); });
  await test.command("add-event", { ...cue, id: "blackout", action: "lighting-blackout", enabled: false, toleranceFrames: 0, leadMs: 100, triggerTimecode: { ...atZero, seconds: 1 }, targetActionId: "restore", payload: { actionId: "recall_scene", params: { scene: "bright" } } });
  await test.command("fire-event", { id: "blackout" }, 400);
  expect(messages).toEqual([]);
  await test.command("set-event-enabled", { id: "blackout", enabled: true });
  await test.command("start");
  await test.command("feed-tc", { timecode: { ...atZero, frames: 20 }, format });
  expect(messages).toEqual([]);
  // A second device added after timing capture must not retarget this cue.
  await device(test.orgId);
  const feed = test.command("feed-tc", { timecode: { ...atZero, frames: 21 }, format });
  await expect.poll(() => messages.length).toBe(1);
  expect(JSON.parse(messages[0].command)).toEqual({ actionId: "blackout", params: {} });
  expect((await test.events())[0]).toMatchObject({ timingDeviceId: id, deviceLatencyMs: 200, dispatchFrame: 21, fired: false, executionStatus: "dispatching" });
  bridge.socket.send(JSON.stringify({ type: "command-response", id: messages[0].id, success: false, error: "Fixture blackout rejection" }));
  await feed;
  expect((await test.events())[0]).toMatchObject({ fired: false, executionStatus: "failed" });
  const retry = test.command("retry-event", { id: "blackout" });
  await expect.poll(() => messages.length).toBe(2);
  bridge.socket.send(JSON.stringify({ type: "command-response", id: messages[1].id, success: true }));
  await retry;
  const first = (await test.events())[0];
  expect(first).toMatchObject({ fired: true, executionStatus: "acknowledged" });
  await test.command("fire-event", { id: "blackout" }, 400);
  await test.command("rearm-event", { id: "blackout", confirmed: true, expected: { fired: true, skipped: false, executionId: first.executionId } });
  const refire = test.command("fire-event", { id: "blackout" });
  await expect.poll(() => messages.length).toBe(3);
  bridge.socket.send(JSON.stringify({ type: "command-response", id: messages[2].id, success: true }));
  await refire;
  expect((await test.events())[0].fired).toBe(true);
});

it("fails closed for disabled, missing, foreign, non-lighting, unsupported and ambiguous blackout targets", async () => {
  const test = await fixture();
  const selected = (targetDeviceId?: string) => resolveTimecodeDeviceAction(env.DB, test.orgId, { action: "lighting-blackout", payload: {}, targetDeviceId });
  await expect(selected()).rejects.toThrow("No enabled lighting");
  const other = await fixture();
  await device(other.orgId, "foreign-id");
  await expect(selected("foreign-id")).rejects.toThrow("does not exist");
  await expect(selected(await device(test.orgId, "disabled", "dmx-artnet", "lighting", 0))).rejects.toThrow("disabled");
  await expect(selected(await device(test.orgId, "non-lighting", "dmx-artnet", "video"))).rejects.toThrow("lighting device");
  await expect(selected(await device(test.orgId, "unsupported", "atem"))).rejects.toThrow("not available");
  await device(test.orgId, "dmx-one");
  await expect(selected()).rejects.toThrow("more than one");
});
