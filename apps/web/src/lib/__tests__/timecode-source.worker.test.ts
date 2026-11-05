import { timecodeFixture } from "@/test/timecode-fixtures";
import { abortAllDurableObjects } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

afterEach(() => abortAllDurableObjects());

describe("TimecodeRelay implemented sources", () => {
  it.each(["ltc-bridge", "network", "internal-rundown", "unknown", null, 1])("rejects unimplemented source %s without changing the clock", async (source) => {
    const { stub, url } = await timecodeFixture();
    const response = await stub.fetch(new Request(url("/command"), {
      method: "POST", body: JSON.stringify({ action: "set-source", payload: { source } }),
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: "This timecode source is not implemented." });
    const state = await (await stub.fetch(url("/state"))).json();
    expect(state).toMatchObject({ source: "internal-freerun", running: false });
  });

  it("accepts supported sources and reports unsupported socket commands to the sender", async () => {
    const { stub, url } = await timecodeFixture();
    for (const source of ["mtc", "internal-freerun"]) {
      const response = await stub.fetch(new Request(url("/command"), {
        method: "POST", body: JSON.stringify({ action: "set-source", payload: { source } }),
      }));
      expect(response.status).toBe(200);
      await response.arrayBuffer();
      expect(await (await stub.fetch(url("/state"))).json()).toMatchObject({ source });
    }
    const response = await stub.fetch(new Request(url("/ws"), { headers: { Upgrade: "websocket" } }));
    const socket = response.webSocket;
    if (!socket) throw new Error("Missing fixture socket");
    const rejected = new Promise(resolve => socket.addEventListener("message", event => {
      const data: unknown = JSON.parse(String(event.data));
      if (data && typeof data === "object" && "type" in data && data.type === "command-rejected") resolve(data);
    }));
    socket.accept();
    socket.send(JSON.stringify({ type: "command", action: "set-source", payload: { source: "network" } }));
    expect(await rejected).toEqual({ type: "command-rejected", action: "set-source", error: "This timecode source is not implemented." });
    socket.close();
  });
});
