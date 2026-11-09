import { abortAllDurableObjects, evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { timecodeFixture } from "@/test/timecode-fixtures";
import type { TimecodeState } from "@/types/timecode";

afterEach(() => abortAllDurableObjects());
const feed = (seconds: number) => ({ source: "ltc-bridge", timecode: { hours: 0, minutes: 0, seconds, frames: 0 }, format: { frameRate: 30, dropFrame: "ndf" } });
async function clock() {
  const test = await timecodeFixture();
  return {
    ...test,
    state: async () => (await test.stub.fetch(test.url("/state"))).json<TimecodeState>(),
    internal: async (path: string, payload?: unknown) => {
      const response = await test.stub.fetch(test.url(`/internal/${path}`), { method: "POST", headers: { "x-showpilot-internal-secret": env.BETTER_AUTH_SECRET }, body: JSON.stringify({ payload }) });
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    },
    command: async (action: string, payload?: unknown) => {
      const response = await test.stub.fetch(test.url("/command"), { method: "POST", body: JSON.stringify({ action, payload }) });
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    },
  };
}

it("requires authenticated valid audio frames and retains LTC identity through eviction", async () => {
  const test = await clock();
  const unauthorized = await test.stub.fetch(test.url("/internal/bridge-feed"), { method: "POST", body: JSON.stringify({ payload: feed(5) }) });
  expect(unauthorized.status).toBe(401);
  await unauthorized.arrayBuffer();
  for (const payload of [{ ...feed(5), source: "network" }, { ...feed(5), timecode: { ...feed(5).timecode, frames: 30 } }]) {
    const invalid = await test.stub.fetch(test.url("/internal/bridge-feed"), { method: "POST", headers: { "x-showpilot-internal-secret": env.BETTER_AUTH_SECRET }, body: JSON.stringify({ payload }) });
    expect(invalid.status).toBe(400);
    await invalid.arrayBuffer();
  }
  expect(await test.state()).toMatchObject({ source: "internal-freerun", running: false, totalFrames: 0 });
  await test.internal("bridge-feed", feed(5));
  expect(await test.state()).toMatchObject({ source: "ltc-bridge", running: true, totalFrames: 150, signal: { status: "live" } });
  await evictDurableObject(test.stub);
  expect(await test.state()).toMatchObject({ source: "ltc-bridge", totalFrames: 150 });
  await test.internal("bridge-disconnected");
  expect(await test.state()).toMatchObject({ source: "ltc-bridge", running: false, totalFrames: 150, signal: { status: "timecode-stalled" } });
  test.controlSocket?.close();
});

it("activates LTC after stopped MIDI without replaying MIDI transport state", async () => {
  const test = await clock();
  await test.internal("bridge-transport", { state: "stopped" });
  expect(await test.state()).toMatchObject({ source: "mtc", running: false, signal: { status: "midi-stopped" } });
  await test.internal("bridge-feed", { ...feed(1), source: "mtc" });
  expect(await test.state()).toMatchObject({ totalFrames: 0, running: false });
  await test.internal("bridge-feed", feed(2));
  expect(await test.state()).toMatchObject({ source: "ltc-bridge", running: true, totalFrames: 60, signal: { status: "live" } });
  test.controlSocket?.close();
});

it("holds lost LTC and resumes from fresh audio without firing cues crossed during silence", async () => {
  const test = await clock();
  await test.command("add-event", { id: "silent-gap", action: "lyrics-clear", label: "Do not catch up", triggerTimecode: feed(2).timecode, payload: {}, toleranceFrames: 0 });
  await test.internal("bridge-feed", feed(1));
  await expect.poll(async () => (await test.state()).signal?.status, { timeout: 2000 }).toBe("timecode-stalled");
  expect(await test.state()).toMatchObject({ source: "ltc-bridge", running: false, totalFrames: 30 });
  await test.internal("bridge-feed", feed(3));
  expect(await test.state()).toMatchObject({ source: "ltc-bridge", running: true, totalFrames: 90, signal: { status: "live" } });
  expect(await (await test.stub.fetch(test.url("/events"))).json()).toEqual([expect.objectContaining({ id: "silent-gap", fired: false })]);
  test.controlSocket?.close();
});

it("promotes the persisted LTC standby when the browser master disconnects", async () => {
  const test = await clock();
  const socket = test.controlSocket;
  if (!socket) throw new Error("Missing operator socket");
  const granted = new Promise<void>(resolve => socket.addEventListener("message", event => {
    const data = JSON.parse(String(event.data));
    if (data.type === "master-status" && data.granted) resolve();
  }));
  socket.send(JSON.stringify({ type: "command", action: "start" }));
  await granted;
  socket.send(JSON.stringify({ type: "command", action: "feed-tc", payload: { ...feed(1), source: undefined } }));
  await expect.poll(async () => (await test.state()).totalFrames).toBe(30);
  await test.internal("bridge-feed", feed(8));
  expect(await test.state()).toMatchObject({ totalFrames: 30, source: "internal-freerun" });
  await evictDurableObject(test.stub);
  socket.close();
  await expect.poll(async () => (await test.state()).totalFrames).toBe(240);
  expect(await test.state()).toMatchObject({ source: "ltc-bridge", running: true, signal: { status: "live" } });
});

it("holds a changed LTC format for confirmation without rearming fired cues", async () => {
  const test = await clock();
  await test.command("add-event", { id: "fired-before-format", action: "lyrics-clear", label: "Already fired", triggerTimecode: feed(1).timecode, payload: {}, toleranceFrames: 0 });
  await test.internal("bridge-feed", feed(1));
  expect(await (await test.stub.fetch(test.url("/events"))).json()).toEqual([expect.objectContaining({ fired: true })]);
  for (let frames = 0; frames < 5; frames++) {
    await test.internal("bridge-feed", { ...feed(2), timecode: { ...feed(2).timecode, frames }, format: { frameRate: 25, dropFrame: "ndf" } });
  }
  expect(await test.state()).toMatchObject({ source: "ltc-bridge", running: false, totalFrames: 30, format: { frameRate: 30, dropFrame: "ndf" }, incomingFormat: { format: { frameRate: 25, dropFrame: "ndf" } }, signal: { status: "format-mismatch" } });
  expect(await (await test.stub.fetch(test.url("/events"))).json()).toEqual([expect.objectContaining({ fired: true })]);
  test.controlSocket?.close();
});
