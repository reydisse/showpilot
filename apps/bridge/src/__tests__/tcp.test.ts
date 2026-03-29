import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import net from "net";
import { TcpConnection } from "../protocols/tcp";

describe("TcpConnection", () => {
  let server: net.Server;
  let serverPort: number;

  beforeEach(async () => {
    // Create a real TCP echo server for integration tests
    server = net.createServer((socket) => {
      socket.on("data", (data) => {
        // Echo back the data
        socket.write(data);
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as net.AddressInfo;
        serverPort = addr.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("connects to a TCP server", async () => {
    const conn = new TcpConnection();
    await conn.connect("127.0.0.1", serverPort);
    expect(conn.isConnected()).toBe(true);
    conn.disconnect();
  });

  it("sends command and receives response", async () => {
    const conn = new TcpConnection();
    await conn.connect("127.0.0.1", serverPort);

    const response = await conn.sendCommand("HELLO\r\n");
    expect(response).toBe("HELLO\r\n");

    conn.disconnect();
  });

  it("handles disconnect", async () => {
    const conn = new TcpConnection();
    await conn.connect("127.0.0.1", serverPort);
    conn.disconnect();
    expect(conn.isConnected()).toBe(false);
  });

  it("rejects on connection failure", async () => {
    const conn = new TcpConnection();
    await expect(conn.connect("127.0.0.1", 1)).rejects.toThrow();
  });

  it("rejects sendCommand when not connected", async () => {
    const conn = new TcpConnection();
    await expect(conn.sendCommand("test")).rejects.toThrow("Not connected");
  });
});
