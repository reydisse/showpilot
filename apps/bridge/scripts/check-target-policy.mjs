// Exercise a compiled sidecar against disposable local network fixtures.
// Usage: node apps/bridge/scripts/check-target-policy.mjs /absolute/path/to/sidecar
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { WebSocketServer } from "ws";

const executable = process.argv[2];
if (!executable) throw new Error("Pass the compiled Bridge executable path.");
const receivers = [];
let child;
let server;
const send = (socket, value) => socket.send(JSON.stringify(value));
function next(socket, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off("message", receive); reject(new Error(`No ${type} acknowledgement`)); }, 10_000);
    const receive = data => {
      const value = JSON.parse(String(data));
      if (value.type !== type) return;
      clearTimeout(timer); socket.off("message", receive); resolve(value);
    };
    socket.on("message", receive);
  });
}
async function receiver() {
  const socket = dgram.createSocket("udp4");
  receivers.push(socket);
  socket.bind(0, "127.0.0.1");
  await once(socket, "listening");
  const endpoint = { host: "127.0.0.1", port: socket.address().port, protocol: "dmx-artnet" };
  const result = { endpoint, target: `${endpoint.host}:${endpoint.port}`, count: 0 };
  socket.on("message", () => result.count++);
  return result;
}
try {
  const first = await receiver();
  const second = await receiver();
  server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const connection = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Sidecar did not connect")), 10_000);
    server.once("connection", socket => { clearTimeout(timer); resolve({ socket, ready: next(socket, "bridge-status") }); });
  });
  let diagnostic = "";
  child = spawn(resolve(executable), ["--desktop", "--no-open"], {
    env: {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      SHOWPILOT_BRIDGE_URL: `ws://127.0.0.1:${server.address().port}`,
      SHOWPILOT_BRIDGE_KEY: "local-policy-fixture",
      SHOWPILOT_PARENT_PID: String(process.pid),
    },
    stdio: ["pipe", "ignore", "pipe"],
  });
  child.stderr.on("data", data => { diagnostic = (diagnostic + String(data)).slice(-2000); });
  child.on("error", error => { diagnostic = error.message; });
  const { socket, ready } = await connection.catch(error => { throw new Error(`${error.message}: ${diagnostic}`); });
  await ready;
  const selected = next(socket, "bridge-role-applied");
  send(socket, { type: "bridge-role", role: "active", activeInstallation: { installationId: "fixture", label: "Fixture" }, selectionId: "select", approvedTargets: [] });
  await selected;
  const denied = next(socket, "command-response");
  send(socket, { type: "command", id: "denied", protocol: "dmx-artnet", target: first.target, command: '{"actionId":"blackout"}' });
  assert.equal((await denied).success, false);
  assert.equal(first.count, 0);
  const approved = next(socket, "bridge-policy-applied");
  send(socket, { type: "bridge-policy", policyId: "approve", approvedTargets: [first.endpoint, second.endpoint] });
  await approved;
  for (const device of [first, second]) {
    const connected = next(socket, "device-status");
    send(socket, { type: "connect-device", protocol: "dmx-artnet", target: device.target, settings: {} });
    assert.equal((await connected).connected, true);
  }
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.ok(first.count > 0 && second.count > 0);
  const revoked = next(socket, "bridge-policy-applied");
  send(socket, { type: "bridge-policy", policyId: "remove", approvedTargets: [second.endpoint] });
  assert.equal((await revoked).policyId, "remove");
  const counts = [first.count, second.count];
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(first.count, counts[0], "Revoked destination kept receiving output");
  assert.ok(second.count > counts[1], "Unrelated destination stopped receiving output");
  console.log(JSON.stringify({ compiledSidecar: "passed", unapprovedCommand: "blocked", revokedLighting: "stopped", unrelatedLighting: "continues" }, null, 2));
} finally {
  if (child?.pid && child.exitCode === null) { const stopped = once(child, "exit"); child.kill("SIGTERM"); await stopped; }
  if (server) { for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); }
  for (const socket of receivers) await new Promise(resolve => socket.close(resolve));
}
