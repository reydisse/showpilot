import { createHash } from "node:crypto";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { PjlinkConnection } from "../protocols/pjlink";

describe("PjlinkConnection", () => {
  let server: net.Server | undefined;
  const sockets = new Set<net.Socket>();

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    if (server?.listening) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
  });

  async function listen(handler: (socket: net.Socket) => void): Promise<number> {
    server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      handler(socket);
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP test address");
    return address.port;
  }

  it("waits for the unauthenticated greeting before sending commands", async () => {
    let received = "";
    const port = await listen((socket) => {
      socket.write("PJLINK ");
      setTimeout(() => socket.write("0\r"), 5);
      socket.on("data", (data) => {
        received += data.toString("ascii");
        socket.write("%1POWR=1\r");
      });
    });
    const connection = new PjlinkConnection();

    await connection.connect("127.0.0.1", port);
    await expect(connection.sendCommand("%1POWR ?\r")).resolves.toBe("%1POWR=1\r");
    expect(received).toBe("%1POWR ?\r");
    connection.disconnect();
  });

  it("prefixes authenticated commands with the PJLink MD5 digest", async () => {
    const password = "ShowPilot1";
    const random = "498e4a67";
    let received = "";
    const port = await listen((socket) => {
      socket.write(`PJLINK 1 ${random}\r`);
      socket.on("data", (data) => {
        received += data.toString("ascii");
        socket.write("%1POWR=OK\r");
      });
    });
    const connection = new PjlinkConnection();

    await connection.connect("127.0.0.1", port, password);
    await connection.sendCommand("%1POWR 1\r");
    const digest = createHash("md5").update(`${random}${password}`, "ascii").digest("hex");
    expect(received).toBe(`${digest}%1POWR 1\r`);
    connection.disconnect();
  });

  it("rejects authenticated devices when no password is configured", async () => {
    const port = await listen((socket) => socket.write("PJLINK 1 498e4a67\r"));
    const connection = new PjlinkConnection();

    await expect(connection.connect("127.0.0.1", port)).rejects.toThrow("requires a password");
    expect(connection.isConnected()).toBe(false);
  });

  it("rejects malformed and error responses", async () => {
    const port = await listen((socket) => {
      socket.write("PJLINK 0\r");
      socket.on("data", () => socket.write("%1POWR=ERR3\r"));
    });
    const connection = new PjlinkConnection();
    await connection.connect("127.0.0.1", port);

    await expect(connection.sendCommand("POWER ON\r")).rejects.toThrow("Invalid PJLink command");
    await expect(connection.sendCommand("%1POWR 1\r")).rejects.toThrow("ERR3");
    connection.disconnect();
  });
});
