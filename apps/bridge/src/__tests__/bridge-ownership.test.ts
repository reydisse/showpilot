import http from "node:http";
import { ProPresenterBridge } from "../protocols/propresenter";
import net from "node:net";
import dgram from "node:dgram";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { Bridge } from "../bridge";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const owner = { installationId: "main", label: "Main venue" };
function send(socket: WebSocket, value: object) { socket.send(JSON.stringify(value)); }
function next(socket: WebSocket, type: string) {
  return new Promise<Record<string, unknown>>(resolve => {
    const handler = (data: WebSocket.RawData) => {
      const value = JSON.parse(String(data));
      if (value.type !== type) return;
      socket.off("message", handler);
      resolve(value);
    };
    socket.on("message", handler);
  });
}
async function fixture() {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  cleanups.push(() => new Promise<void>(resolve => { for (const client of server.clients) client.terminate(); server.close(() => resolve()); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No websocket address");
  const accepted = new Promise<{ socket: WebSocket; ready: Promise<Record<string, unknown>> }>(resolve => server.once("connection", socket => resolve({ socket, ready: next(socket, "bridge-status") })));
  const bridge = new Bridge({ url: `ws://127.0.0.1:${address.port}`, reconnect: false });
  cleanups.push(() => bridge.stop());
  bridge.start();
  const { socket, ready } = await accepted;
  await ready;
  return { bridge, socket };
}
async function role(socket: WebSocket, role: "active" | "standby", selectionId = crypto.randomUUID()) {
  const applied = next(socket, "bridge-role-applied");
  send(socket, { type: "bridge-role", role, activeInstallation: owner, selectionId });
  expect(await applied).toMatchObject({ role, selectionId });
}
async function barrier(socket: WebSocket) {
  const pong = next(socket, "pong");
  send(socket, { type: "ping" });
  await pong;
}
async function udp() {
  const receiver = dgram.createSocket("udp4");
  receiver.bind(0, "127.0.0.1");
  await once(receiver, "listening");
  cleanups.push(() => new Promise<void>(resolve => receiver.close(() => resolve())));
  const packets: Buffer[] = [];
  receiver.on("message", packet => packets.push(packet));
  return { receiver, packets, target: `127.0.0.1:${receiver.address().port}` };
}

describe("Bridge active and standby transport", () => {
  it("blocks device traffic until selected, stops repeating lighting output before acknowledging standby, and can be activated again", async () => {
    const { packets, target } = await udp();
    const { bridge, socket } = await fixture();
    const connect = { type: "connect-device", protocol: "dmx-artnet", target, settings: {} };
    send(socket, connect);
    await barrier(socket);
    expect(bridge.getStatus().role).toBe("waiting");
    expect(packets).toHaveLength(0);
    await role(socket, "active");
    const connected = next(socket, "device-status");
    send(socket, connect);
    expect(await connected).toMatchObject({ connected: true, target });
    await expect.poll(() => packets.length).toBeGreaterThan(0);
    await role(socket, "standby");
    expect(bridge.getStatus()).toMatchObject({ role: "standby", activeInstallation: owner });
    const count = packets.length;
    send(socket, connect);
    send(socket, { type: "command", id: "ignored", protocol: "udp", target, command: "must not send" });
    await barrier(socket);
    await new Promise(resolve => setTimeout(resolve, 1000)); // Longer than the real 800ms DMX resend interval.
    expect(packets).toHaveLength(count);
    await role(socket, "active");
    const reconnected = next(socket, "device-status");
    send(socket, connect);
    expect(await reconnected).toMatchObject({ connected: true });
    await expect.poll(() => packets.length).toBeGreaterThan(count);
  });

  it("finishes an in-flight TCP command and closes its socket before acknowledging demotion", async () => {
    const tcp = net.createServer();
    tcp.listen(0, "127.0.0.1");
    await once(tcp, "listening");
    const connections: net.Socket[] = [];
    tcp.on("connection", socket => connections.push(socket));
    cleanups.push(() => new Promise<void>(resolve => { for (const socket of connections) socket.destroy(); tcp.close(() => resolve()); }));
    const address = tcp.address();
    if (!address || typeof address === "string") throw new Error("No TCP address");
    const target = `127.0.0.1:${address.port}`;
    const { socket } = await fixture();
    await role(socket, "active");
    const deviceConnection = once(tcp, "connection");
    const connected = next(socket, "device-status");
    send(socket, { type: "connect-device", protocol: "tcp-command", target, settings: {} });
    await connected;
    const [device] = await deviceConnection as [net.Socket];
    const received = once(device, "data");
    const response = next(socket, "command-response");
    send(socket, { type: "command", id: "in-flight", protocol: "tcp-command", target, command: "fixture\r" });
    await received;
    let demoted = false;
    const applied = role(socket, "standby").then(() => { demoted = true; });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(demoted).toBe(false);
    const closed = once(device, "close");
    device.write("OK\r");
    expect(await response).toMatchObject({ id: "in-flight", success: true, response: "OK\r" });
    await applied;
    await closed;
    expect(device.destroyed).toBe(true);
  });

  it("stops autonomous lighting output on cloud disconnect", async () => {
    const { packets, target } = await udp();
    const { bridge, socket } = await fixture();
    await role(socket, "active");
    const connected = next(socket, "device-status");
    send(socket, { type: "connect-device", protocol: "dmx-artnet", target, settings: {} });
    await connected;
    await expect.poll(() => packets.length).toBeGreaterThan(0);
    socket.close();
    await expect.poll(() => bridge.getStatus().role).toBe("waiting");
    const count = packets.length;
    await new Promise(resolve => setTimeout(resolve, 1000));
    expect(packets).toHaveLength(count);
  });
});

async function httpServer(handler: http.RequestListener) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP address");
  return { port: address.port, url: `http://127.0.0.1:${address.port}` };
}

it("does not let a configured HTTP device redirect commands or credentials to another destination", async () => {
  let unapprovedRequests = 0;
  const other = await httpServer((_request, response) => { unapprovedRequests++; response.end("unexpected"); });
  const approved = await httpServer((_request, response) => { response.writeHead(302, { Location: other.url }); response.end(); });
  const { socket } = await fixture();
  await role(socket, "active");
  const connected = next(socket, "device-status");
  send(socket, { type: "connect-device", protocol: "http-command", target: approved.url, settings: { authToken: "private-fixture-token" } });
  await connected;
  const reply = next(socket, "command-response");
  send(socket, { type: "command", id: "redirect", protocol: "http-command", target: approved.url, command: "GET /action" });
  expect(await reply).toMatchObject({ id: "redirect", success: false });
  expect(unapprovedRequests).toBe(0);
});

it("does not follow ProPresenter command, discovery, or polling redirects outside its configured ports", async () => {
  let unapprovedRequests = 0;
  let approvedRequests = 0;
  const other = await httpServer((_request, response) => { unapprovedRequests++; response.end("{}"); });
  const approved = await httpServer((_request, response) => { approvedRequests++; response.writeHead(302, { Location: other.url }); response.end(); });
  const pp = new ProPresenterBridge({ host: "127.0.0.1", port: approved.port, apiPort: approved.port, onSlideChange: () => {}, onStatusChange: () => {} });
  cleanups.push(() => pp.disconnect());
  await expect(pp.sendCommand("next")).rejects.toThrow();
  await expect(pp.sendCommand(JSON.stringify({ action: "query-presentations" }))).rejects.toThrow();
  const beforePolling = approvedRequests;
  pp.connect();
  await expect.poll(() => approvedRequests).toBeGreaterThan(beforePolling);
  pp.disconnect();
  expect(unapprovedRequests).toBe(0);
});
