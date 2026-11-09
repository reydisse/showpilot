import http from "node:http";
import { sealBridgeSettings } from "@showpilot/shared/bridge-settings";
import { ProPresenterBridge } from "../protocols/propresenter";
import net from "node:net";
import dgram from "node:dgram";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UdpConnection } from "../protocols/udp";
import { Bridge } from "../bridge";
import { resolveBridgeEndpoints, type BridgeEndpoint } from "@showpilot/shared/bridge-target";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const owner = { installationId: "main", label: "Main venue" };
const recipientKeys = new WeakMap<WebSocket, string>();
const outgoing = new WeakMap<WebSocket, Promise<void>>();
function send(socket: WebSocket, value: Record<string, unknown>) {
  const work = (outgoing.get(socket) ?? Promise.resolve()).then(async () => {
    if (value.type === "connect-device") {
      if (typeof value.protocol !== "string" || typeof value.target !== "string" || typeof value.settings !== "object" || !value.settings || Array.isArray(value.settings)) throw new Error("Invalid fixture connection");
      const protectedSettings = await sealBridgeSettings(recipientKeys.get(socket) ?? "", {
        orgId: "fixture-org", installationId: owner.installationId, protocol: value.protocol, target: value.target,
      }, Object.fromEntries(Object.entries(value.settings)));
      socket.send(JSON.stringify({ type: value.type, protocol: value.protocol, target: value.target, protectedSettings }));
    } else socket.send(JSON.stringify(value));
  });
  outgoing.set(socket, work);
  return work;
}
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
async function fixture(propresenter?: { host: string; port: number; apiPort: number; password?: string }) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  cleanups.push(() => new Promise<void>(resolve => { for (const client of server.clients) client.terminate(); server.close(() => resolve()); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No websocket address");
  const accepted = new Promise<{ socket: WebSocket; ready: Promise<Record<string, unknown>> }>(resolve => server.once("connection", (socket, request) => {
    const key = request.headers["x-showpilot-settings-key"];
    if (typeof key !== "string") throw new Error("Missing native recipient key");
    recipientKeys.set(socket, key);
    resolve({ socket, ready: next(socket, "bridge-status") });
  }));
  const bridge = new Bridge({ url: `ws://127.0.0.1:${address.port}`, reconnect: false, propresenter });
  cleanups.push(() => bridge.stop());
  bridge.start();
  const { socket, ready } = await accepted;
  await ready;
  return { bridge, socket };
}
async function role(socket: WebSocket, role: "active" | "standby", approvedTargets: BridgeEndpoint[] = [], selectionId = crypto.randomUUID()) {
  const applied = next(socket, "bridge-role-applied");
  send(socket, { type: "bridge-role", role, orgId: "fixture-org", installationId: owner.installationId, activeInstallation: owner, selectionId, approvedTargets });
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
  it("forwards native MIDI transport and timecode over the real Bridge socket", async () => {
    const { bridge, socket } = await fixture();
    await role(socket, "active");
    for (const state of ["stopped", "waiting"] as const) {
      const received = next(socket, "timecode-transport");
      bridge.transportTimecode(state);
      expect(await received).toEqual({ type: "timecode-transport", state });
    }
    const received = next(socket, "timecode-feed");
    bridge.feedTimecode({ timecode: { hours: 0, minutes: 0, seconds: 0, frames: 1 }, format: { frameRate: 30, dropFrame: "ndf" }, totalFrames: 1 });
    expect(await received).toMatchObject({ type: "timecode-feed", totalFrames: 1 });
  });
  it("blocks device traffic until selected, stops repeating lighting output before acknowledging standby, and can be activated again", async () => {
    const { packets, target } = await udp();
    const { bridge, socket } = await fixture();
    const connect = { type: "connect-device", protocol: "dmx-artnet", target, settings: {} };
    send(socket, connect);
    await barrier(socket);
    expect(bridge.getStatus().role).toBe("waiting");
    expect(packets).toHaveLength(0);
    await role(socket, "active", resolveBridgeEndpoints(connect));
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
    await role(socket, "active", resolveBridgeEndpoints(connect));
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
    await role(socket, "active", resolveBridgeEndpoints({ type: "connect-device", protocol: "tcp-command", target }));
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
    await role(socket, "active", resolveBridgeEndpoints({ type: "connect-device", protocol: "dmx-artnet", target }));
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
  await role(socket, "active", resolveBridgeEndpoints({ type: "connect-device", protocol: "http-command", target: approved.url }));
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

async function policy(socket: WebSocket, approvedTargets: BridgeEndpoint[]) {
  const policyId = crypto.randomUUID();
  const applied = next(socket, "bridge-policy-applied");
  send(socket, { type: "bridge-policy", policyId, approvedTargets });
  expect(await applied).toMatchObject({ policyId });
}

it("rejects unapproved targets in the native Bridge even when the server sends them", async () => {
  const { target, packets } = await udp();
  const { socket } = await fixture();
  await role(socket, "active");
  const response = next(socket, "command-response");
  send(socket, { type: "command", id: "unapproved", protocol: "udp", target, command: "fixture" });
  expect(await response).toMatchObject({ success: false, error: expect.stringContaining("not approved") });
  expect(packets).toHaveLength(0);
  await policy(socket, resolveBridgeEndpoints({ type: "connect-device", protocol: "udp", target }));
  const connected = next(socket, "device-status");
  send(socket, { type: "connect-device", protocol: "udp", target, settings: { host: "elsewhere.local" } });
  expect(await connected).toMatchObject({ connected: false });
  expect(packets).toHaveLength(0);
});

it("stops only revoked lighting destinations before acknowledging the policy and blocks their later commands", async () => {
  const first = await udp();
  const second = await udp();
  const destinations = [first, second].map(({ target }) => ({ type: "connect-device" as const, protocol: "dmx-artnet", target, settings: {} }));
  const { bridge, socket } = await fixture();
  await role(socket, "active", destinations.flatMap(resolveBridgeEndpoints));
  for (const destination of destinations) {
    const connected = next(socket, "device-status");
    send(socket, destination);
    expect(await connected).toMatchObject({ connected: true });
  }
  await expect.poll(() => first.packets.length).toBeGreaterThan(0);
  await expect.poll(() => second.packets.length).toBeGreaterThan(0);
  const status = next(socket, "bridge-status");
  await policy(socket, resolveBridgeEndpoints(destinations[1]));
  expect((await status).targets).toEqual([second.target]);
  const firstCount = first.packets.length;
  const secondCount = second.packets.length;
  await new Promise(resolve => setTimeout(resolve, 1000));
  expect(first.packets).toHaveLength(firstCount);
  expect(second.packets.length).toBeGreaterThan(secondCount);
  const rejected = next(socket, "command-response");
  send(socket, { type: "command", id: "revoked", protocol: "dmx-artnet", target: first.target, command: '{"actionId":"blackout"}' });
  expect(await rejected).toMatchObject({ success: false, error: expect.stringContaining("not approved") });
});

it("requires both configured ProPresenter ports, then stops its polling when the API approval is removed", async () => {
  let apiRequests = 0;
  let stageRequests = 0;
  let holdPolling = false;
  const stage = await httpServer((_request, response) => { stageRequests++; response.end("{}"); });
  const api = await httpServer((_request, response) => {
    apiRequests++;
    if (holdPolling) return;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ current: { text: "Fixture lyric" }, next: { text: "Next fixture lyric" } }));
  });
  const target = `propresenter:127.0.0.1:${stage.port}`;
  const endpoints = resolveBridgeEndpoints({ type: "connect-device", protocol: "propresenter", target, settings: { apiPort: api.port } });
  const { bridge, socket } = await fixture({ host: "127.0.0.1", port: stage.port, apiPort: api.port, password: "local-only-fixture-password" });
  await role(socket, "active", [endpoints[0]]);
  await barrier(socket);
  expect(apiRequests).toBe(0);
  expect(stageRequests).toBe(0);
  const automatic = next(socket, "automatic-connection-requested");
  await policy(socket, endpoints);
  const request = await automatic;
  expect(request).toEqual({ type: "automatic-connection-requested", target, apiPort: api.port, requestId: expect.any(String) });
  expect(apiRequests).toBe(0);
  expect(stageRequests).toBe(0);
  send(socket, { type: "automatic-connection-approved", requestId: request.requestId, approved: true });
  await barrier(socket);
  await expect.poll(() => Object.keys(bridge.getStatus().propresenter)).toContain(target);
  expect(apiRequests).toBeGreaterThan(0);
  holdPolling = true;
  const beforeHold = apiRequests;
  await expect.poll(() => apiRequests).toBeGreaterThan(beforeHold);
  await policy(socket, [endpoints[0]]);
  expect(Object.keys(bridge.getStatus().propresenter)).not.toContain(target);
  const counts = [apiRequests, stageRequests];
  await new Promise(resolve => setTimeout(resolve, 1000));
  expect([apiRequests, stageRequests]).toEqual(counts);
});

it("waits for a matching connection audit receipt, reuses TCP, and audits a dropped retained socket again", async () => {
  const tcp = net.createServer();
  tcp.listen(0, "127.0.0.1");
  await once(tcp, "listening");
  const connections: net.Socket[] = [];
  tcp.on("connection", socket => {
    connections.push(socket);
    socket.on("data", () => socket.write("OK\r"));
  });
  cleanups.push(() => new Promise<void>(resolve => { for (const socket of connections) socket.destroy(); tcp.close(() => resolve()); }));
  const address = tcp.address();
  if (!address || typeof address === "string") throw new Error("No TCP address");
  const target = `127.0.0.1:${address.port}`;
  const { socket } = await fixture();
  await role(socket, "active", resolveBridgeEndpoints({ type: "connect-device", protocol: "tcp-command", target }));
  const requests: Record<string, unknown>[] = [];
  socket.on("message", data => {
    const value = JSON.parse(String(data));
    if (value.type === "command-connection-requested") requests.push(value);
  });
  const command = { type: "command", protocol: "tcp-command", target, command: "fixture\r" };
  const requested = next(socket, "command-connection-requested");
  const response = next(socket, "command-response");
  send(socket, { ...command, id: "first" });
  const request = await requested;
  expect(request).toEqual({ type: "command-connection-requested", id: "first", requestId: expect.any(String) });
  expect(connections).toHaveLength(0);
  send(socket, { ...request, type: "command-connection-approved", requestId: "wrong-receipt", approved: true });
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(connections).toHaveLength(0);
  send(socket, { ...request, type: "command-connection-approved", approved: true });
  expect(await response).toMatchObject({ id: "first", success: true });
  const reused = next(socket, "command-response");
  send(socket, { ...command, id: "reuse" });
  expect(await reused).toMatchObject({ success: true });
  expect(requests).toHaveLength(1);
  const closed = once(connections[0], "close");
  connections[0].destroy(); await closed;
  await new Promise(resolve => setTimeout(resolve, 30));
  const reopen = next(socket, "command-connection-requested");
  const reopened = next(socket, "command-response");
  send(socket, { ...command, id: "reopen" });
  const newRequest = await reopen;
  expect(connections).toHaveLength(1);
  expect(newRequest.requestId).not.toBe(request.requestId);
  send(socket, { ...newRequest, type: "command-connection-approved", approved: true });
  expect(await reopened).toMatchObject({ id: "reopen", success: true });
  expect(connections).toHaveLength(2);
  expect(requests).toHaveLength(2);
});

it.each(["osc", "udp"])("requires an audit receipt for implicit %s connections and sends no packet on denial", async protocol => {
  const { target, packets } = await udp();
  const { socket } = await fixture();
  await role(socket, "active", resolveBridgeEndpoints({ type: "connect-device", protocol, target }));
  const command = { type: "command", protocol, target, command: protocol === "osc" ? "/fixture i:1" : "0102" };
  for (const approved of [false, true]) {
    const request = next(socket, "command-connection-requested");
    const response = next(socket, "command-response");
    send(socket, { ...command, id: `request-${approved}` });
    const requested = await request;
    expect(packets).toHaveLength(0);
    send(socket, { ...requested, type: "command-connection-approved", approved });
    expect(await response).toMatchObject({ success: approved });
  }
  await expect.poll(() => packets.length).toBe(1);
});

it("fails a missing audit receipt without opening UDP and ignores a late receipt", async () => {
  const { target, packets } = await udp();
  const { socket } = await fixture();
  await role(socket, "active", resolveBridgeEndpoints({ type: "connect-device", protocol: "udp", target }));
  const requested = next(socket, "command-connection-requested");
  const response = next(socket, "command-response");
  send(socket, { type: "command", id: "timeout", protocol: "udp", target, command: "0102" });
  const request = await requested;
  expect(await response).toMatchObject({ success: false, error: expect.stringContaining("not approved and recorded") });
  send(socket, { ...request, type: "command-connection-approved", approved: true });
  await barrier(socket);
  expect(packets).toHaveLength(0);
});

it("cancels a pending connection when the cloud socket closes", async () => {
  const { target, packets } = await udp();
  const { bridge, socket } = await fixture();
  await role(socket, "active", resolveBridgeEndpoints({ type: "connect-device", protocol: "udp", target }));
  const requested = next(socket, "command-connection-requested");
  send(socket, { type: "command", id: "disconnect", protocol: "udp", target, command: "0102" });
  await requested;
  socket.close();
  await expect.poll(() => bridge.getStatus().role).toBe("waiting");
  expect(packets).toHaveLength(0);
});

it("audits a direct HTTP target before its first request and reuses the configured target", async () => {
  let count = 0;
  const target = await httpServer((_request, response) => { count++; response.end("OK"); });
  const { socket } = await fixture();
  await role(socket, "active", resolveBridgeEndpoints({ type: "connect-device", protocol: "http-command", target: target.url }));
  const command = { type: "command", protocol: "http-command", target: target.url, command: "GET /fixture" };
  const requested = next(socket, "command-connection-requested");
  const response = next(socket, "command-response");
  send(socket, { ...command, id: "http-first" });
  const request = await requested;
  expect(count).toBe(0);
  send(socket, { ...request, type: "command-connection-approved", approved: true });
  expect(await response).toMatchObject({ success: true });
  const reused = next(socket, "command-response");
  send(socket, { ...command, id: "http-reuse" });
  expect(await reused).toMatchObject({ success: true });
  expect(count).toBe(2);
});

it("does not connect automatic ProPresenter when its audit is denied", async () => {
  let requests = 0;
  const target = await httpServer((_request, response) => { requests++; response.end("{}"); });
  const { bridge, socket } = await fixture({ host: "127.0.0.1", port: target.port, apiPort: target.port, password: "never-forward" });
  const destination = `propresenter:127.0.0.1:${target.port}`;
  const requested = next(socket, "automatic-connection-requested");
  const selected = role(socket, "active", resolveBridgeEndpoints({ type: "connect-device", protocol: "propresenter", target: destination, settings: { apiPort: target.port } }));
  const request = await requested;
  expect(JSON.stringify(request)).not.toContain("never-forward");
  send(socket, { type: "automatic-connection-approved", requestId: request.requestId, approved: false });
  await selected;
  await barrier(socket);
  expect(requests).toBe(0);
  expect(bridge.getStatus().propresenter).toEqual({});
});

it("replaces changed ProPresenter credentials and API ports without stale disconnect acknowledgements", async () => {
  const stage = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(stage, "listening");
  cleanups.push(() => new Promise<void>(resolve => { for (const socket of stage.clients) socket.terminate(); stage.close(() => resolve()); }));
  const address = stage.address();
  if (typeof address === "string") throw new Error("Missing Stage socket address");
  let expectedPassword = "first-secret";
  const passwords: string[] = [];
  stage.on("connection", socket => socket.on("message", data => {
    const message = JSON.parse(String(data));
    if (message.acn !== "ath") return;
    passwords.push(message.pwd);
    socket.send(JSON.stringify({ acn: "ath", ath: message.pwd === expectedPassword }));
  }));
  const api = await httpServer((_request, response) => { response.statusCode = 404; response.end("{}"); });
  const replacementApi = await httpServer((_request, response) => { response.statusCode = 404; response.end("{}"); });
  const target = `propresenter:127.0.0.1:${address.port}`;
  const { socket } = await fixture();
  const connection = { type: "connect-device", protocol: "propresenter", target, settings: { apiPort: api.port, password: expectedPassword } };
  await role(socket, "active", [...resolveBridgeEndpoints(connection), { protocol: "propresenter", host: "127.0.0.1", port: replacementApi.port }]);
  async function configure(password: string, apiPort = api.port, success = true) {
    const reply = next(socket, "device-status");
    await send(socket, { ...connection, settings: { password, apiPort } });
    expect(await reply).toMatchObject({ target, connected: success });
    await barrier(socket);
  }
  await configure(expectedPassword);
  await configure(expectedPassword);
  expect(passwords).toEqual(["first-secret"]);
  expectedPassword = "replacement-secret";
  await configure(expectedPassword);
  await configure(expectedPassword, replacementApi.port);
  expectedPassword = "";
  await configure(expectedPassword, replacementApi.port);
  await configure("wrong-password", replacementApi.port, false);
  await configure(expectedPassword, replacementApi.port);
  expect(passwords).toEqual(["first-secret", "replacement-secret", "replacement-secret", "", "wrong-password", ""]);
});

it("requires a fresh receipt for each Wake-on-LAN socket and never broadcasts on denial", async () => {
  // Do not broadcast wake packets onto the developer's real venue network.
  const connect = vi.spyOn(UdpConnection.prototype, "connect").mockResolvedValue();
  const transmit = vi.spyOn(UdpConnection.prototype, "send").mockResolvedValue();
  cleanups.push(() => { connect.mockRestore(); transmit.mockRestore(); });
  const { socket } = await fixture();
  const command = { type: "command", protocol: "wol", target: "wol", command: "AA:BB:CC:DD:EE:FF" };
  await role(socket, "active", resolveBridgeEndpoints(command));
  for (const [index, approved] of [false, true, true].entries()) {
    const requested = next(socket, "command-connection-requested");
    const response = next(socket, "command-response");
    send(socket, { ...command, id: `wake-${index}` });
    const request = await requested;
    expect(connect).toHaveBeenCalledTimes(Math.max(0, index - 1));
    send(socket, { ...request, type: "command-connection-approved", approved });
    expect(await response).toMatchObject({ success: approved });
  }
  expect(connect).toHaveBeenCalledTimes(2);
  expect(connect).toHaveBeenCalledWith("255.255.255.255", 9);
  expect(transmit).toHaveBeenCalledTimes(2);
});

it("opens a fresh PJLink handshake when a retained socket has dropped", async () => {
  const tcp = net.createServer();
  tcp.listen(0, "127.0.0.1");
  await once(tcp, "listening");
  const connections: net.Socket[] = [];
  tcp.on("connection", socket => { connections.push(socket); socket.write("PJLINK 0\r"); });
  cleanups.push(() => new Promise<void>(resolve => { for (const socket of connections) socket.destroy(); tcp.close(() => resolve()); }));
  const address = tcp.address();
  if (!address || typeof address === "string") throw new Error("No PJLink address");
  const target = `127.0.0.1:${address.port}`;
  const { socket } = await fixture();
  const connect = { type: "connect-device", protocol: "pjlink", target, settings: {} };
  await role(socket, "active", resolveBridgeEndpoints(connect));
  const first = next(socket, "device-status"); send(socket, connect);
  expect(await first).toMatchObject({ connected: true });
  const closed = once(connections[0], "close"); connections[0].destroy(); await closed;
  await new Promise(resolve => setTimeout(resolve, 30));
  const second = next(socket, "device-status"); send(socket, connect);
  expect(await second).toMatchObject({ connected: true });
  expect(connections).toHaveLength(2);
});

it("refuses plaintext connection settings even from the authenticated relay", async () => {
  const { target, packets } = await udp();
  const { socket } = await fixture();
  await role(socket, "active", resolveBridgeEndpoints({ type: "connect-device", protocol: "udp", target }));
  const rejected = next(socket, "device-status");
  socket.send(JSON.stringify({ type: "connect-device", protocol: "udp", target, settings: { password: "must-not-be-used" } }));
  expect(await rejected).toMatchObject({ target, connected: false });
  await barrier(socket);
  expect(packets).toHaveLength(0);
});
