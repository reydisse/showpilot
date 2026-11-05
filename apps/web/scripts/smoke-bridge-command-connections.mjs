// Real browser -> built Worker/D1 -> compiled native Bridge -> local TCP device.
// Usage after web/sidecar builds: node apps/web/scripts/smoke-bridge-command-connections.mjs <sidecar-path>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { once } from "node:events";
import net from "node:net";
import { resolve } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
const { WebSocket } = createRequire(new URL("../../bridge/package.json", import.meta.url))("ws");
const executable = process.argv[2];
if (!executable) throw new Error("Pass the compiled native Bridge executable path.");
function next(socket, type, matches = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off("message", handler); reject(new Error(`No ${type} response`)); }, 12_000);
    const handler = data => {
      const message = JSON.parse(String(data));
      if (message.type !== type || !matches(message)) return;
      clearTimeout(timer); socket.off("message", handler); resolve(message);
    };
    socket.on("message", handler);
  });
}
await withLocalSmokeFixture(async ({ origin, orgId, browser, operatorEmail, operatorPassword, operatorCookie, queryFixture }) => {
  const tcp = net.createServer();
  const deviceSockets = [];
  const received = [];
  let child;
  let operator;
  try {
    tcp.on("connection", socket => {
      deviceSockets.push(socket);
      socket.on("data", data => { received.push(String(data)); socket.write("OK\r"); });
    });
    tcp.listen(0, "127.0.0.1");
    await once(tcp, "listening");
    const port = tcp.address().port;
    const target = `127.0.0.1:${port}`;
    const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
    await browser("open", `${origin}/login`);
    await browser("fill", "#email", operatorEmail);
    await browser("fill", "#password", operatorPassword);
    await click("Sign in");
    await browser("wait", "--url", `**/${orgId}/**`);
    await browser("open", `${origin}/${orgId}/settings?section=api`);
    await browser("wait", 'input[placeholder="Main room computer"]');
    await browser("fill", 'input[placeholder="Main room computer"]', "Native connection audit fixture");
    await click("Create key");
    await browser("wait", "text=Copy this key into the Bridge now.");
    const key = (await browser("eval", "[...document.querySelectorAll('code')].map(el => el.textContent).find(text => /^sp_[a-f0-9]{64}$/.test(text))")).result;
    assert.match(key, /^sp_[a-f0-9]{64}$/);
    await click("Dismiss key");
    await browser("find", "label", "Destination name", "fill", "Fixture TCP");
    await browser("find", "label", "Host or IP address", "fill", "127.0.0.1");
    await browser("find", "label", "Port", "fill", String(port));
    await browser("select", 'label:has-text("Protocol") select', "tcp-command");
    await click("Approve destination");
    await browser("wait", `text=${target} · TCP`);
    operator = new WebSocket(`${origin.replace("http:", "ws:")}/api/bridge/${orgId}/ws?role=client`, { headers: { Cookie: operatorCookie, Origin: origin } });
    await next(operator, "bridge-status");
    const online = next(operator, "bridge-status", message => message.online === true && typeof message.version === "string");
    let diagnostics = "";
    child = spawn(resolve(executable), ["--desktop", "--no-open"], {
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, SHOWPILOT_BRIDGE_URL: `${origin.replace("http:", "ws:")}/api/bridge/${orgId}/ws`, SHOWPILOT_BRIDGE_KEY: key, SHOWPILOT_PARENT_PID: String(process.pid) },
      stdio: ["pipe", "ignore", "pipe"],
    });
    child.stderr.on("data", data => { diagnostics = (diagnostics + String(data).replaceAll(key, "[redacted]")).slice(-2000); });
    await online.catch(error => { throw new Error(`${error.message}: ${diagnostics}`); });
    const command = async id => {
      const reply = next(operator, "command-response", message => message.id === id);
      operator.send(JSON.stringify({ type: "command", id, protocol: "tcp-command", target, command: "fixture\r", actorUserId: "forged" }));
      return reply;
    };
    const attempts = () => queryFixture("SELECT actorUserId,source,executionId,host,port,protocol FROM bridge_target_audit WHERE orgId='display-smoke' AND action='connection-requested' ORDER BY rowid");
    assert.equal((await command("first")).success, true);
    assert.equal(deviceSockets.length, 1);
    const expected = { actorUserId: "smoke-operator", source: "operator", executionId: null, host: "127.0.0.1", port, protocol: "tcp-command" };
    assert.deepEqual(await attempts(), [expected]);
    assert.equal((await command("reuse")).success, true);
    assert.equal(deviceSockets.length, 1);
    assert.deepEqual(await attempts(), [expected]);
    const closed = once(deviceSockets[0], "close");
    deviceSockets[0].destroy(); await closed;
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal((await command("reconnect")).success, true);
    assert.equal(deviceSockets.length, 2);
    assert.deepEqual(await attempts(), [expected, expected]);
    await click("Remove approval for Fixture TCP");
    await browser("click", '[role="dialog"] button:text-is("Remove approval")');
    await browser("wait", "text=No Bridge destinations approved yet.");
    assert.equal((await command("revoked")).success, false);
    assert.equal(deviceSockets.length, 2);
    assert.deepEqual(received, ["fixture\r", "fixture\r", "fixture\r"]);
    assert.deepEqual(await attempts(), [expected, expected]);
    console.log(JSON.stringify({ builtWorker: "passed", compiledBridge: "passed", attributedTcpOpen: "passed", existingConnectionReuse: "passed", droppedSocketReopen: "passed", postRevocationCommand: "blocked" }, null, 2));
  } finally {
    operator?.terminate();
    if (child?.pid && child.exitCode === null && child.signalCode === null) { const stopped = once(child, "exit"); child.kill("SIGTERM"); await stopped; }
    for (const socket of deviceSockets) socket.destroy();
    await new Promise(resolve => tcp.close(resolve));
  }
});
