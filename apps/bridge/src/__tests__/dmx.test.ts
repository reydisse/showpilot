import dgram from "node:dgram";
import { describe, expect, it } from "vitest";
import { DmxConnection, artNetDmxPacket, sacnDmxPacket } from "../protocols/dmx.js";

function nextPacket(socket: dgram.Socket): Promise<Buffer> {
  return new Promise((resolve) => socket.once("message", resolve));
}

async function bindUdpServer(): Promise<{ socket: dgram.Socket; port: number }> {
  const socket = dgram.createSocket("udp4");
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  const address = socket.address();
  if (typeof address === "string") throw new Error("Expected an IPv4 UDP address");
  return { socket, port: address.port };
}

describe("DMX protocol output", () => {
  it("encodes complete Art-Net and sACN frames", () => {
    const channels = new Uint8Array(512);
    channels[0] = 255;
    channels[511] = 64;

    const artNet = artNetDmxPacket(0x1234, 7, channels);
    expect(artNet.subarray(0, 8).toString("ascii")).toBe("Art-Net\0");
    expect(artNet.readUInt16LE(8)).toBe(0x5000);
    expect(artNet.readUInt16BE(16)).toBe(512);
    expect(artNet[14]).toBe(0x34);
    expect(artNet[15]).toBe(0x12);
    expect(artNet[18]).toBe(255);
    expect(artNet[529]).toBe(64);

    const cid = Buffer.alloc(16, 0xab);
    const sacn = sacnDmxPacket({ universe: 42, sequence: 9, channels, cid });
    expect(sacn).toHaveLength(638);
    expect(sacn.subarray(4, 16).toString("ascii")).toBe("ASC-E1.17\0\0\0");
    expect(sacn.readUInt32BE(18)).toBe(4);
    expect(sacn.subarray(22, 38)).toEqual(cid);
    expect(sacn[111]).toBe(9);
    expect(sacn.readUInt16BE(113)).toBe(42);
    expect(sacn.readUInt16BE(123)).toBe(513);
    expect(sacn[126]).toBe(255);
    expect(sacn[637]).toBe(64);
  });

  it("preserves changes made during blackout when output is restored", async () => {
    const { socket, port } = await bindUdpServer();
    const states: Array<{ activeScene: string; blackoutActive: boolean; masterLevel: number }> = [];
    const connection = new DmxConnection("dmx-artnet", (state) => states.push(state));

    try {
      let packetPromise = nextPacket(socket);
      await connection.connect("127.0.0.1", port, { universe: 0 });
      await packetPromise;

      packetPromise = nextPacket(socket);
      await connection.executeAction("set_channel", { channel: 1, value: 100 });
      expect((await packetPromise)[18]).toBe(100);

      packetPromise = nextPacket(socket);
      await connection.executeAction("blackout", {});
      expect((await packetPromise)[18]).toBe(0);

      packetPromise = nextPacket(socket);
      await connection.executeAction("set_channel", { channel: 1, value: 200 });
      expect((await packetPromise)[18]).toBe(0);

      packetPromise = nextPacket(socket);
      await connection.executeAction("restore", {});
      expect((await packetPromise)[18]).toBe(200);

      expect(states.map((state) => state.blackoutActive)).toEqual([false, false, true, true, false]);
      expect(new Set(states).size).toBe(states.length);
    } finally {
      connection.disconnect();
      socket.close();
    }
  });

  it("rejects Art-Net universes that cannot fit its 15-bit port address", async () => {
    const connection = new DmxConnection("dmx-artnet", () => {});
    await expect(connection.connect("127.0.0.1", 6454, { universe: 32_768 }))
      .rejects.toThrow("Universe must be between 0 and 32767");
  });
});
