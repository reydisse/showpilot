// Real browser -> built Worker -> protocol-compatible fixture Bridge. No physical device or production data.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createBridgeSettingsRecipient } from "../../../packages/shared/src/bridge-settings.mjs";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
const { WebSocket } = createRequire(new URL("../../bridge/package.json", import.meta.url))("ws");
await withLocalSmokeFixture(async ({ origin, orgId, browser, operatorEmail, operatorPassword, queryFixture, stopServer, startServer }) => {
  const recipient = await createBridgeSettingsRecipient();
  const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
  const evaluate = async expression => (await browser("eval", expression)).result;
  let bridge; let heartbeat; let closed = null; let acceptConnection = false; let attempts = 0;
  try {
    await browser("open", `${origin}/login`);
    await browser("fill", "#email", operatorEmail); await browser("fill", "#password", operatorPassword);
    await click("Sign in"); await browser("wait", "--url", `**/${orgId}/**`);
    await browser("open", `${origin}/${orgId}/settings?section=api`);
    await browser("wait", 'input[placeholder="Main room computer"]');
    await browser("fill", 'input[placeholder="Main room computer"]', "Connection error fixture");
    await click("Create key"); await browser("wait", "text=Copy this key into the Bridge now.");
    const key = await evaluate("[...document.querySelectorAll('code')].map(el => el.textContent).find(text => /^sp_[a-f0-9]{64}$/.test(text))");
    assert.match(key, /^sp_[a-f0-9]{64}$/); await click("Dismiss key");
    await browser("find", "label", "Destination name", "fill", "Fixture ATEM");
    await browser("find", "label", "Host or IP address", "fill", "192.0.2.10");
    await browser("find", "label", "Port", "fill", "9910");
    await browser("select", 'label:has-text("Protocol") select', "atem");
    await click("Approve destination"); await browser("wait", "text=192.0.2.10:9910");
    const openBridge = async () => {
    bridge = new WebSocket(`${origin.replace("http:", "ws:")}/api/bridge/${orgId}/ws?role=bridge`, { headers: { "x-showpilot-api-key": key, "x-showpilot-bridge-policy": "3", "x-showpilot-settings-key": recipient.publicKey } });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Fixture Bridge did not become active")), 10000);
      bridge.on("error", reject);
      bridge.on("message", data => {
        const msg = JSON.parse(String(data));
        if (msg.type === "bridge-role") {
          if (msg.selectionId) bridge.send(JSON.stringify({ type: "bridge-role-applied", role: msg.role, selectionId: msg.selectionId }));
          clearTimeout(timer); resolve();
        }
        if (msg.type === "bridge-policy") bridge.send(JSON.stringify({ type: "bridge-policy-applied", policyId: msg.policyId }));
        if (msg.type === "connect-device") {
          attempts++;
          bridge.send(JSON.stringify({ type: "device-status", target: msg.target, connected: acceptConnection, error: acceptConnection ? undefined : "Fixture switcher refused connection. Check its network address." }));
        }
      });
    });
    bridge.on("close", (code, reason) => { closed = { code, reason: String(reason) }; });
    };
    await openBridge();
    heartbeat = setInterval(() => { if (bridge.readyState === WebSocket.OPEN) bridge.send(JSON.stringify({ type: "bridge-status", devices: 0, targets: [], version: "fixture" })); }, 2000);
    await browser("open", `${origin}/${orgId}/dashboard/devices`);
    await browser("click", 'button:text-is("Add Device") >> nth=0');
    await browser("select", "#device-adapter", "atem");
    await browser("fill", "#device-name", "Connection error ATEM");
    await browser("fill", "#device-field-host", "192.0.2.10");
    await browser("click", "form button[type=submit]");
    await browser("wait", "text=Configuration & device details");
    const [device] = await queryFixture(`SELECT id, settings, enabled FROM device WHERE orgId='${orgId}' AND name='Connection error ATEM'`);
    assert.ok(device);
    assert.equal(JSON.parse(device.settings).port, undefined, "Blank optional port must not be saved as zero");

    try { await browser("wait", 'text=Fixture switcher refused connection. Check its network address.'); }
    catch (error) {
      console.error(JSON.stringify({ attempts, closed, device, page: await evaluate("document.body.innerText") }));
      await browser("screenshot", "/tmp/showpilot-device-connection-error-diagnostic.png");
      throw error;
    }
    assert.equal(await evaluate("[...document.querySelectorAll('[role=alert]')].some(el => el.textContent.includes('Fixture switcher refused connection'))"), true);
    await browser("wait", 'button:text-is("Retry connection")');
    assert.equal(await evaluate("[...document.querySelectorAll('[role=alert] time')].some(el => Number.isFinite(Date.parse(el.dateTime)))"), true, "Failure must include a timestamp");
    await browser("screenshot", "/tmp/showpilot-device-connection-error.png");
    const before = attempts; acceptConnection = true;
    await click("Retry connection"); await browser("wait", 'button:text-is("Disconnect")');
    assert.ok(attempts > before);
    assert.equal(await evaluate("[...document.querySelectorAll('[role=alert]')].some(el => el.textContent.includes('Fixture switcher refused connection'))"), false);
    const attemptsBeforeOutage = attempts;
    await stopServer();
    await browser("wait", 'text=Reconnecting.');
    assert.equal(await evaluate("[...document.querySelectorAll('[role=alert] time')].some(el => Number.isFinite(Date.parse(el.dateTime)))"), true);
    assert.equal(await evaluate("[...document.querySelectorAll('button')].some(el => el.textContent.trim() === 'Disconnect')"), false);
    await browser("set", "viewport", "320", "740");
    await browser("screenshot", "/tmp/showpilot-device-recovery-320.png");
    await startServer(); await openBridge();
    await browser("wait", 'button:text-is("Disconnect")');
    assert.ok(attempts > attemptsBeforeOutage, "Device must reconnect after the venue Bridge is restored");
    assert.equal(await evaluate("[...document.querySelectorAll('[role=alert]')].some(el => /Bridge connection|Command outcomes/.test(el.textContent))"), false);
    console.log(JSON.stringify({ socketOutageVisible: true, timestampVisible: true, restoresWithoutPageReload: true, passed: true, nativeFailureReasonVisible: true, retryConnects: true, errorClearedAfterSuccess: true, physicalDeviceConnected: false, blankPortUsesAdapterDefault: true }));
  } finally { clearInterval(heartbeat); bridge?.terminate(); }
});
