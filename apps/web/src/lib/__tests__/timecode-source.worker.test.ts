import { timecodeFixture } from "@/test/timecode-fixtures";
import { abortAllDurableObjects } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

afterEach(() => abortAllDurableObjects());

describe("TimecodeRelay implemented sources", () => {
  it.each(["network", "internal-rundown", "unknown", null, 1])("rejects unimplemented source %s without changing the clock", async (source) => {
    const { stub, url, target } = await timecodeFixture();
    const response = await stub.fetch(new Request(url("/command"), {
      method: "POST", body: JSON.stringify({ action: "set-source", payload: { source } }),
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: "This timecode source is not implemented.", showId: target.showId, serviceDate: target.serviceDate });
    const state = await (await stub.fetch(url("/state"))).json();
    expect(state).toMatchObject({ source: "internal-freerun", running: false });
  });

  it("requires actual Bridge audio before claiming LTC as active", async () => {
    const { stub, url } = await timecodeFixture();
    const response = await stub.fetch(url("/command"), { method: "POST", body: JSON.stringify({ action: "set-source", payload: { source: "ltc-bridge" } }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "Select the LTC audio input in ShowPilot Bridge. Valid audio activates the source." });
    expect(await (await stub.fetch(url("/state"))).json()).toMatchObject({ source: "internal-freerun", running: false });
  });

  it("accepts supported sources and reports unsupported socket commands to the sender", async () => {
    const { stub, url, controlSocket, target } = await timecodeFixture();
    for (const source of ["mtc", "internal-freerun"]) {
      const response = await stub.fetch(new Request(url("/command"), {
        method: "POST", body: JSON.stringify({ action: "set-source", payload: { source } }),
      }));
      expect(response.status).toBe(200);
      await response.arrayBuffer();
      expect(await (await stub.fetch(url("/state"))).json()).toMatchObject({ source });
    }
    const socket = controlSocket;
    if (!socket) throw new Error("Missing fixture socket");
    const rejected = new Promise(resolve => socket.addEventListener("message", event => {
      const data: unknown = JSON.parse(String(event.data));
      if (data && typeof data === "object" && "type" in data && data.type === "command-rejected") resolve(data);
    }));
    socket.send(JSON.stringify({ type: "command", action: "set-source", payload: { source: "network" } }));
    expect(await rejected).toEqual({ type: "command-rejected", action: "set-source", error: "This timecode source is not implemented.", showId: target.showId, serviceDate: target.serviceDate });
    socket.close();
  });
});
