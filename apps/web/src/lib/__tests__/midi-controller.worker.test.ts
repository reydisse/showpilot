import { env } from "cloudflare:workers";
import { abortAllDurableObjects, evictDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { timecodeFixture } from "@/test/timecode-fixtures";
import { emptyMidiController, apcMiniMk2CueBindings } from "@/lib/midi-controller";
import type { TimecodeWsMessage, TimecodeState } from "@/types/timecode";

afterEach(() => abortAllDurableObjects());
async function fixture() {
  const test = await timecodeFixture();
  const command = async (action: string, payload?: unknown) => {
    const response = await test.stub.fetch(test.url("/command"), { method: "POST", body: JSON.stringify({ action, payload }) });
    await response.arrayBuffer(); return response;
  };
  const state = async () => (await test.stub.fetch(test.url("/state"))).json<TimecodeState>();
  const hydrate = async (access = "write") => {
    const url = test.url("/ws", access);
    if (access === "read") { url.searchParams.delete("authUserId"); url.searchParams.delete("authSessionId"); }
    const response = await test.stub.fetch(url, { headers: { Upgrade: "websocket" } });
    const socket = response.webSocket; if (!socket) throw new Error("Missing socket");
    const message = new Promise<TimecodeWsMessage>(resolve => socket.addEventListener("message", event => resolve(JSON.parse(String(event.data))), { once: true }));
    socket.accept(); const result = await message; socket.close(); return result;
  };
  return { ...test, command, state, hydrate };
}
const config = { ...emptyMidiController().config, input: { id: "pads", name: "APC", manufacturer: "Akai" }, bindings: apcMiniMk2CueBindings() };
const format = { frameRate: 30, dropFrame: "ndf" };
const timecode = (frames: number) => ({ hours: 0, minutes: 0, seconds: 0, frames });

it("persists show-specific mappings through eviction without exposing them to display clients", async () => {
  const test = await fixture();
  expect((await test.command("save-controller", { revision: 0, config })).status).toBe(200);
  await evictDurableObject(test.stub);
  expect(await test.hydrate()).toMatchObject({ type: "hydrate", controller: { revision: 1, config } });
  expect(await test.hydrate("read")).not.toHaveProperty("controller");
  const other = await timecodeFixture(test.orgId, `${test.orgId}-other`);
  const socket = (await other.stub.fetch(other.url("/ws"), { headers: { Upgrade: "websocket" } })).webSocket;
  if (!socket) throw new Error("Missing socket");
  const data = new Promise<unknown>(resolve => socket.addEventListener("message", event => resolve(JSON.parse(String(event.data))), { once: true }));
  socket.accept(); expect(await data).toMatchObject({ controller: emptyMidiController() });
  socket.close(); other.controlSocket?.close(); test.controlSocket?.close();
});
it("allows only one concurrent mapping save and rejects malformed mappings", async () => {
  const test = await fixture();
  const responses = await Promise.all([test.command("save-controller", { revision: 0, config }), test.command("save-controller", { revision: 0, config: emptyMidiController().config })]);
  expect(responses.map(response => response.status).sort()).toEqual([200, 400]);
  expect((await test.command("save-controller", { revision: 1, config: { ...config, armed: true } })).status).toBe(400);
  expect((await test.command("save-controller", { revision: 1, config: { ...config, bindings: [config.bindings[0], config.bindings[0]] } })).status).toBe(400);
  expect(await test.hydrate()).toMatchObject({ controller: { revision: 1 } }); test.controlSocket?.close();
});
it("Pause holds the source through late feeds and eviction, and Start resumes without rearming cues", async () => {
  const test = await fixture();
  await test.command("add-event", { id: "cue", label: "Cue", action: "lyrics-clear", payload: {}, triggerTimecode: timecode(2), toleranceFrames: 0 });
  await test.command("start"); await test.command("feed-tc", { timecode: timecode(2), format });
  expect((await test.command("pause")).status).toBe(200);
  await test.command("feed-tc", { timecode: timecode(8), format });
  await evictDurableObject(test.stub);
  expect(await test.state()).toMatchObject({ totalFrames: 2, running: false, signal: { status: "paused" } });
  await test.command("start"); await test.command("feed-tc", { timecode: timecode(3), format });
  expect(await test.state()).toMatchObject({ totalFrames: 3, running: true });
  const events = await (await test.stub.fetch(test.url("/events"))).json();
  expect(events).toEqual([expect.objectContaining({ fired: true, executionAttempts: 1 })]); test.controlSocket?.close();
});
it("does not promote standby timecode when a paused source disconnects", async () => {
  const test = await fixture(); await test.command("start"); await test.command("feed-tc", { timecode: timecode(2), format });
  const bridge = () => test.stub.fetch(test.url("/internal/bridge-feed"), { method: "POST", headers: { "x-showpilot-internal-secret": env.BETTER_AUTH_SECRET }, body: JSON.stringify({ payload: { timecode: timecode(9), format } }) });
  await bridge(); await test.command("pause"); test.controlSocket?.close();
  await expect.poll(async () => (await test.hydrate())).toMatchObject({ control: "available" });
  await bridge(); expect(await test.state()).toMatchObject({ totalFrames: 2, running: false, signal: { status: "paused" } });
});
