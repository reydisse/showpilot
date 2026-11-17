import { env } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { timecodeFixture } from "@/test/timecode-fixtures";
afterEach(() => abortAllDurableObjects());

it("CueSheetRelay closes connection 201 with room full 4413", async () => {
  const stub = env.CUE_SHEET_RELAY.getByName(crypto.randomUUID());
  const sockets: WebSocket[] = [];
  try {
    for (let i = 0; i < 200; i++) {
      const response = await stub.fetch("https://test/ws", { headers: { Upgrade: "websocket" } });
      const socket = response.webSocket!;
      socket.accept();
      sockets.push(socket);
    }
    const response = await stub.fetch("https://test/ws", { headers: { Upgrade: "websocket" } });
    const socket = response.webSocket!;
    let code = 0;
    socket.addEventListener("close", event => { code = event.code; });
    socket.accept();
    await expect.poll(() => code).toBe(4413);
  } finally { for (const socket of sockets) socket.close(); }
});

it("TimecodeRelay closes an inbound flood with 1008", async () => {
  const test = await timecodeFixture(undefined, undefined, false);
  const response = await test.stub.fetch(test.url("/ws"), { headers: { Upgrade: "websocket" } });
  const socket = response.webSocket!;
  let code = 0;
  socket.addEventListener("close", event => { code = event.code; });
  socket.accept();
  for (let i = 0; i < 1000; i++) socket.send("{}");
  await expect.poll(() => code).toBe(1008);
});

it("TimecodeRelay processes 300 master feed frames at 10 Hz without closing", async () => {
  const test = await timecodeFixture(undefined, undefined, false);
  const response = await test.stub.fetch(test.url("/ws"), { headers: { Upgrade: "websocket" } });
  const socket = response.webSocket!;
  const messages: any[] = [];
  let closed = false;
  socket.addEventListener("close", () => { closed = true; });
  socket.addEventListener("message", event => messages.push(JSON.parse(String(event.data))));
  socket.accept();
  await expect.poll(() => messages.some(m => m.type === "hydrate")).toBe(true);
  socket.send(JSON.stringify({ type: "command", action: "claim-control" }));
  await expect.poll(() => messages.some(m => m.type === "control-status" && m.control === "yours")).toBe(true);
  socket.send(JSON.stringify({ type: "command", action: "start" }));
  await expect.poll(() => messages.some(m => m.type === "master-status" && m.granted)).toBe(true);
  const start = Date.now();
  const time = vi.spyOn(Date, "now");
  try {
    for (let i = 1; i <= 300; i++) {
      time.mockReturnValue(start + i * 100);
      socket.send(JSON.stringify({ type: "command", action: "feed-tc", payload: {
        timecode: { hours: 0, minutes: 0, seconds: Math.floor(i / 30), frames: i % 30 },
        format: { frameRate: 30, dropFrame: "ndf" },
      } }));
      await expect.poll(async () => (await (await test.stub.fetch(test.url("/state"))).json<any>()).totalFrames).toBe(i);
    }
    expect(closed).toBe(false);
  } finally { time.mockRestore(); socket.close(); }
});
