import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Bridge } from "../bridge";

interface TestableBridge {
  handleConnectDevice(message: {
    type: "connect-device";
    protocol: string;
    target: string;
    settings: Record<string, unknown>;
  }): Promise<void>;
  send(message: Record<string, unknown>): void;
}

describe("Bridge device lifecycle", () => {
  const servers: net.Server[] = [];
  const sockets: net.Socket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    for (const server of servers) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("opens a fresh PJLink handshake when a retained socket has dropped", async () => {
    let connections = 0;
    const server = net.createServer((socket) => {
      sockets.push(socket);
      connections++;
      socket.write("PJLINK 0\r");
      if (connections === 1) setTimeout(() => socket.destroy(), 5);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected PJLink test address");

    const bridge = new Bridge({ url: "ws://bridge.invalid", reconnect: false }) as unknown as TestableBridge;
    const send = vi.fn();
    bridge.send = send;
    const message = {
      type: "connect-device" as const,
      protocol: "pjlink",
      target: `127.0.0.1:${address.port}`,
      settings: {},
    };
    await bridge.handleConnectDevice(message);
    await new Promise((resolve) => setTimeout(resolve, 15));
    await bridge.handleConnectDevice(message);

    expect(connections).toBe(2);
    expect(send).toHaveBeenCalledWith({ type: "device-status", target: message.target, connected: true });
  });
});
