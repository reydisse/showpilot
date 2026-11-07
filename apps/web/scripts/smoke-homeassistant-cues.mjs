// Built UI -> authenticated Worker -> real relays -> compiled Bridge -> local HA simulator.
// Uses disposable data only. Build web and Bridge before running this rehearsal.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { Bridge } from "../../bridge/dist/bridge.js";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll } from "./real-browser-fixture.mjs";

const token = randomUUID();
const requests = [];
let discovery = "valid";
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  requests.push({ method: request.method, path: request.url, body, authenticated: request.headers.authorization === `Bearer ${token}` });
  response.setHeader("Content-Type", "application/json");
  if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401); response.end("{}"); return; }
  if (request.url === "/api/states") {
    response.end(discovery === "broken" ? "{broken" : JSON.stringify(discovery === "removed" ? [] : [
      { entity_id: "scene.service", state: "scening", attributes: { friendly_name: "Service scene", private_fixture: "do-not-return" } },
      { entity_id: "lock.door", state: "locked" },
    ]));
  } else if (request.url === "/api/services/scene/turn_on" && request.method === "POST") response.end("[]");
  else { response.writeHead(404); response.end("{}"); }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;
const target = `http://127.0.0.1:${port}`;
let bridge;
try {
  await withLocalSmokeFixture(async ({ origin, orgId, browser, operatorEmail, operatorPassword, operatorCookie, stopServer, queryFixture }) => {
    const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
    const evaluate = async expression => (await browser("eval", expression)).result;
    const form = 'form:has(input[placeholder="00:05:00:00"])';
    const selectLabel = async (label, value) => {
      const id = await evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(`${form} label`)})).find(label => label.textContent.trim() === ${JSON.stringify(label)})?.htmlFor`);
      assert.ok(id, `Missing ${label} label`);
      await browser("select", `[id=${JSON.stringify(id)}]`, value);
    };
    const events = async () => {
      const response = await fetch(`${origin}/api/timecode/${orgId}/events?showId=smoke-show`, { headers: { Cookie: operatorCookie } });
      assert.equal(response.status, 200); return response.json();
    };
    await browser("open", `${origin}/login`);
    await browser("fill", "#email", operatorEmail); await browser("fill", "#password", operatorPassword); await click("Sign in");
    await browser("wait", "--url", `**/${orgId}/**`);
    await browser("open", `${origin}/${orgId}/settings?section=api`);
    await browser("fill", 'input[placeholder="Main room computer"]', "HA rehearsal Bridge");
    await click("Create key");
    await browser("wait", "text=Copy this key into the Bridge now.");
    const key = await evaluate("[...document.querySelectorAll('code')].map(el => el.textContent).find(text => /^sp_[a-f0-9]{64}$/.test(text))");
    assert.match(key, /^sp_[a-f0-9]{64}$/); await click("Dismiss key");
    await browser("find", "label", "Destination name", "fill", "HA simulator");
    await browser("find", "label", "Host or IP address", "fill", "127.0.0.1");
    await browser("find", "label", "Port", "fill", String(port));
    await browser("select", 'label:has-text("Protocol") select', "http-command");
    await click("Approve destination");
    await browser("wait", 'button[aria-label="Remove approval for HA simulator"]');
    bridge = new Bridge({ url: `${origin.replace("http:", "ws:")}/api/bridge/${orgId}/ws`, key, reconnect: false });
    bridge.start();
    await browser("open", `${origin}/${orgId}/dashboard/devices`);
    await browser("click", 'button:text-is("Add Device") >> nth=0');
    await browser("select", "#device-adapter", "homeassistant");
    await browser("fill", "#device-name", "Rehearsal Home Assistant");
    await browser("fill", "#device-field-baseUrl", target);
    await browser("fill", "#device-field-accessToken", token);
    await browser("click", 'form button:text-is("Add Device")');
    await browser("wait", 'button:text-is("Service scene")');
    console.log("Fixture device connected through compiled Bridge");

    await browser("open", `${origin}/${orgId}/timecode`);
    await browser("wait", "text=Start Internal Generator");
    await evaluate(`(() => {
      window.__haReplies = [];
      const original = window.fetch;
      window.fetch = async (...args) => { const response = await original(...args); window.__haReplies.push(await response.clone().text()); return response; };
    })()`);
    await browser("select", `${form} select >> nth=0`, "device-action");
    await browser("wait", "--fn", "Array.from(document.querySelectorAll('option')).some(option => option.textContent === 'Rehearsal Home Assistant')");
    const deviceId = await evaluate("Array.from(document.querySelectorAll('option')).find(option => option.textContent === 'Rehearsal Home Assistant').value");
    const beforeSelection = requests.length;
    discovery = "broken";
    await selectLabel("Device", deviceId);
    await browser("wait", "text=Home Assistant returned an unreadable action list.");
    assert.equal(requests.length, beforeSelection + 1);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(form)}).querySelector('button[type=submit]').disabled`), true);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(form)}).textContent.includes('no supported actions')`), false);
    for (const width of [320, 768, 1440]) {
      await browser("set", "viewport", String(width), "900");
      await browser("scrollintoview", `${form} button:text-is("Refresh actions")`);
      const geometry = await evaluate(`(() => {
        const form = document.querySelector(${JSON.stringify(form)});
        const button = [...form.querySelectorAll('button')].find(button => button.textContent === 'Refresh actions');
        const rect = button.getBoundingClientRect();
        return { overflow: form.scrollWidth > form.clientWidth + 1, height: rect.height, width: rect.width, reachable: button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)) };
      })()`);
      assert.equal(geometry.overflow, false); assert.ok(geometry.height >= 44 && geometry.width >= 44 && geometry.reachable);
      if (width === 320) await browser("screenshot", "/tmp/showpilot-ha-error-320.png");
    }
    discovery = "valid"; await click("Refresh actions");
    await browser("wait", "--fn", "Array.from(document.querySelectorAll('option')).some(option => option.value === 'ha:scene:turn_on:scene.service')");
    await selectLabel("Device action", "ha:scene:turn_on:scene.service");
    await browser("fill", `${form} input[placeholder="00:05:00:00"]`, "00:01:00:00");
    await browser("find", "label", "Label", "fill", "HA service cue");
    await click("Add Event");
    const cue = await poll(async () => (await events()).find(event => event.label === "HA service cue"), "saved HA cue");
    assert.deepEqual(cue.payload, { deviceId, actionId: "ha:scene:turn_on:scene.service", params: {} });
    const beforeFire = requests.length;
    await click("Fire HA service cue");
    await poll(async () => (await events()).find(event => event.id === cue.id)?.executionStatus === "acknowledged", "HA service acknowledgement");
    assert.deepEqual(requests.slice(beforeFire).map(({ method, path, body }) => ({ method, path, body })), [
      { method: "GET", path: "/api/states", body: "" },
      { method: "POST", path: "/api/services/scene/turn_on", body: '{"entity_id":"scene.service"}' },
    ]);
    // A removed entity must fail visibly even though the saved cue was valid earlier.
    await browser("select", `${form} select >> nth=0`, "device-action");
    await selectLabel("Device", deviceId);
    await browser("wait", "--fn", "Array.from(document.querySelectorAll('option')).some(option => option.value === 'ha:scene:turn_on:scene.service')");
    await selectLabel("Device action", "ha:scene:turn_on:scene.service");
    await browser("fill", `${form} input[placeholder="00:05:00:00"]`, "00:02:00:00");
    await browser("find", "label", "Label", "fill", "HA removed scene");
    await click("Add Event");
    await poll(async () => (await events()).some(event => event.label === "HA removed scene"), "second saved cue");
    discovery = "removed";
    const beforeRemoved = requests.length;
    await click("Fire HA removed scene");
    await poll(async () => (await events()).find(event => event.label === "HA removed scene")?.executionStatus === "failed", "removed scene failure");
    await browser("wait", 'button[aria-label="Retry HA removed scene"]');
    assert.deepEqual(requests.slice(beforeRemoved).map(request => request.path), ["/api/states"]);
    discovery = "valid"; await click("Retry HA removed scene");
    await poll(async () => (await events()).find(event => event.label === "HA removed scene")?.executionStatus === "acknowledged", "explicit Retry acknowledgement");
    const replies = await evaluate("window.__haReplies");
    assert.ok(replies.length > 0);
    for (const hidden of [token, target, "do-not-return", "lock.door"]) assert.equal(JSON.stringify(replies).includes(hidden), false, `Unexpected discovery data: ${hidden === token ? 'credential' : hidden}`);
    assert.ok(requests.every(request => request.authenticated));
    assert.equal(requests.filter(request => request.method === "POST").length, 2);
    const errors = await browser("errors"); assert.deepEqual(errors.errors, []);
    bridge.stop(); await stopServer();
    const [saved] = await queryFixture("SELECT settings FROM device WHERE orgId='display-smoke' AND name='Rehearsal Home Assistant'");
    assert.ok(saved.settings.includes("spenc:v1:")); assert.equal(saved.settings.includes(token), false);
    console.log(JSON.stringify({ passed: true, browserToCompiledBridge: true, encryptedCredential: true, malformedDiscoveryRetry: true, removedEntityRejected: true, explicitRetry: true, authenticatedServiceCalls: 2, responsiveWidths: [320, 768, 1440], screenshot: "/tmp/showpilot-ha-error-320.png" }));
  });
} finally {
  bridge?.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
