// Saved device credential rehearsal: browser editor -> D1 -> compiled Bridge -> authenticated device.
// Usage after web/sidecar builds: node apps/web/scripts/smoke-device-credentials.mjs <sidecar-path>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { once } from "node:events";
import net from "node:net";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
const { WebSocket, WebSocketServer } = createRequire(new URL("../../bridge/package.json", import.meta.url))("ws");
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
  const deviceSecret = randomUUID();
  const authorizations = [];
  const serviceCalls = [];
  const httpDevice = http.createServer((request, response) => {
    authorizations.push(request.headers.authorization);
    response.statusCode = request.headers.authorization === `Bearer ${deviceSecret}` ? 200 : 401;
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/states") response.end(JSON.stringify([{ entity_id: "light.room", state: "off", attributes: { friendly_name: "Fixture room" } }]));
    else {
      serviceCalls.push(request.url);
      response.end("[]");
    }
  });
  let proxy;
  const upstreamSockets = [];
  const wireMessages = [];
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
    proxy = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(proxy, "listening");
    proxy.on("connection", (socket, request) => {
      const upstream = new WebSocket(`${origin.replace("http:", "ws:")}/api/bridge/${orgId}/ws?role=bridge`, {
        headers: { "x-showpilot-api-key": key, "x-showpilot-bridge-policy": request.headers["x-showpilot-bridge-policy"], "x-showpilot-settings-key": request.headers["x-showpilot-settings-key"] },
      });
      upstreamSockets.push(upstream);
      const queued = [];
      socket.on("message", data => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(String(data));
        else queued.push(String(data));
      });
      upstream.on("open", () => { for (const data of queued.splice(0)) upstream.send(data); });
      upstream.on("message", data => { wireMessages.push(JSON.parse(String(data))); socket.send(String(data)); });
      upstream.on("error", () => socket.close(1011, "Fixture proxy failed"));
      upstream.on("close", () => socket.close());
      socket.on("close", () => upstream.terminate());
    });
    const online = next(operator, "bridge-status", message => message.online === true && typeof message.version === "string");
    let diagnostics = "";
    child = spawn(resolve(executable), ["--desktop", "--no-open"], {
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, SHOWPILOT_BRIDGE_URL: `ws://127.0.0.1:${proxy.address().port}`, SHOWPILOT_BRIDGE_KEY: key, SHOWPILOT_PARENT_PID: String(process.pid) },
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
    httpDevice.listen(0, "127.0.0.1");
    await once(httpDevice, "listening");
    const httpPort = httpDevice.address().port;
    const httpTarget = `http://127.0.0.1:${httpPort}`;
    await browser("find", "label", "Destination name", "fill", "Fixture HTTP");
    await browser("find", "label", "Host or IP address", "fill", "127.0.0.1");
    await browser("find", "label", "Port", "fill", String(httpPort));
    await browser("select", 'label:has-text("Protocol") select', "http-command");
    await click("Approve destination");
    await browser("wait", `text=127.0.0.1:${httpPort} · HTTP`);
    await browser("open", `${origin}/${orgId}/dashboard/devices`);
    await browser("click", 'button:text-is("Add Device") >> nth=0');
    await browser("select", "#device-adapter", "homeassistant");
    await browser("fill", "#device-name", "Saved credential fixture");
    await browser("fill", "#device-field-baseUrl", httpTarget);
    await browser("fill", "#device-field-accessToken", deviceSecret);
    await browser("eval", `(() => {
      window.__credentialReplies = [];
      const original = window.fetch;
      window.fetch = async (...args) => {
        const response = await original(...args);
        window.__credentialReplies.push(await response.clone().text());
        return response;
      };
    })()`);
    await browser("click", 'form button:text-is("Add Device")');
    await browser("wait", 'button:text-is("Fixture room On")');
    await click("Fixture room On");
    await browser("wait", "--fn", `document.querySelector('button') && [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Disconnect')`);
    const [device] = await queryFixture(`SELECT id,settings FROM device WHERE orgId='${orgId}' AND name='Saved credential fixture'`);
    assert.ok(device.settings.includes("spenc:v1:"));
    assert.equal(device.settings.includes(deviceSecret), false);
    assert.ok(serviceCalls.includes("/api/services/light/turn_on"), "Browser action did not reach the device");
    assert.ok(authorizations.length > 0 && authorizations.every(value => value === `Bearer ${deviceSecret}`));
    assert.equal(JSON.stringify(wireMessages).includes(deviceSecret), false);
    assert.ok(wireMessages.some(message => message.type === "connect-device" && message.target === httpTarget && message.protectedSettings));
    const replies = (await browser("eval", "window.__credentialReplies")).result;
    assert.ok(replies.length > 0 && replies.every(reply => !reply.includes(deviceSecret) && !reply.includes("spenc:v1:")));
    assert.equal((await browser("eval", `document.documentElement.outerHTML.includes(${JSON.stringify(deviceSecret)})`)).result, false);
    await browser("click", 'summary:text-is("Configuration & device details")');
    await click("Edit configuration");
    assert.equal((await browser("eval", `document.querySelector('#device-field-accessToken').value`)).result, "");
    for (const width of [320, 768, 2560]) {
      await browser("set", "viewport", String(width), "900");
      const geometry = (await browser("eval", `(() => { const form = document.querySelector('form'); return { overflow: form.scrollWidth > form.clientWidth + 1, height: document.querySelector('#device-field-accessToken').getBoundingClientRect().height }; })()`)).result;
      assert.equal(geometry.overflow, false);
      assert.ok(geometry.height >= 44);
    }
    await browser("fill", "#device-name", "Saved credential fixture renamed");
    await click("Update");
    await browser("wait", "--fn", "!document.querySelector('#device-name')");
    const [kept] = await queryFixture(`SELECT settings FROM device WHERE orgId='${orgId}' AND id='${device.id}'`);
    assert.equal(JSON.parse(kept.settings).accessToken, JSON.parse(device.settings).accessToken);
    await click("Edit configuration");
    await click("Clear credential");
    await browser("click", '[role="dialog"] button:text-is("Cancel")');
    assert.equal((await browser("eval", "document.body.textContent.includes('Will be cleared when you save.')")).result, false);
    await click("Clear credential");
    await browser("click", '[role="dialog"] button:text-is("Clear credential")');
    await click("Update");
    await browser("wait", "--fn", "!document.querySelector('#device-name')");
    const [cleared] = await queryFixture(`SELECT settings FROM device WHERE orgId='${orgId}' AND id='${device.id}'`);
    assert.equal(JSON.parse(cleared.settings).accessToken, "");
    console.log(JSON.stringify({ encryptedD1: "passed", maskedReadAndSaveResponses: "passed", browserActionThroughCompiledBridge: "passed", deviceAuthorization: "passed", encryptedNativeWire: "passed", blankEditPreserves: "passed", confirmedClear: "passed", responsiveWidths: [320,768,2560] }, null, 2));

  } finally {
    operator?.terminate();
    if (child?.pid && child.exitCode === null && child.signalCode === null) { const stopped = once(child, "exit"); child.kill("SIGTERM"); await stopped; }
    for (const socket of upstreamSockets) socket.terminate();
    if (proxy) { for (const socket of proxy.clients) socket.terminate(); await new Promise(resolve => proxy.close(resolve)); }
    httpDevice.closeAllConnections();
    await new Promise(resolve => httpDevice.close(resolve));
    for (const socket of deviceSockets) socket.destroy();
    await new Promise(resolve => tcp.close(resolve));
  }
});
