// Named target UI -> real relays -> shared rundown transport / compiled DMX
// adapter -> loopback Art-Net packets. No venue hardware or remote data.
import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { createRequire } from "node:module";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { DmxConnection } from "../../bridge/dist/protocols/dmx.js";
import { createBridgeSettingsRecipient } from "../../../packages/shared/src/bridge-settings.mjs";
import { poll } from "./real-browser-fixture.mjs";

const { WebSocket } = createRequire(new URL("../../bridge/package.json", import.meta.url))("ws");
const udp = createSocket("udp4");
udp.bind(6454, "127.0.0.1");
await once(udp, "listening");
let lastChannels;
udp.on("message", packet => {
  assert.equal(packet.subarray(0, 8).toString("ascii"), "Art-Net\0");
  lastChannels = packet.subarray(18);
});
const dmx = new DmxConnection("dmx-artnet", () => {});
let bridge;
try {
  await dmx.connect("127.0.0.1", 6454, { universe: 0 });
  await dmx.executeAction("set_channel", { channel: 1, value: 180 });
  await poll(() => lastChannels?.[0] === 180, "lit fixture channel");
  await withLocalSmokeFixture(async ({ origin, orgId, browser, operatorEmail, operatorPassword, operatorCookie, date }) => {
    const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
    const rundownUrl = `${origin}/api/rundown/${orgId}`;
    const showQuery = `showId=smoke-show&serviceDate=${date}`;
    const rundownCommand = async (action, payload) => {
      const response = await fetch(`${rundownUrl}/command?${showQuery}`, { method: "POST", headers: { Cookie: operatorCookie, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ id: crypto.randomUUID(), action, payload }) });
      assert.equal(response.status, 200, await response.text());
    };
    const readRundown = async () => {
      const response = await fetch(`${rundownUrl}/state?${showQuery}`, { headers: { Cookie: operatorCookie } });
      assert.equal(response.status, 200); return response.json();
    };
    for (const [id, title, type] of [["welcome", "Welcome", "segment"], ["heading", "Main section", "header"], ["message", "Message", "segment"]]) {
      await rundownCommand("add-item", { id, title, type, duration: 60000, notes: "", assignee: "", cue: "", hardStop: false });
    }
    await rundownCommand("timer-start", { itemId: "welcome" });
    await rundownCommand("timer-pause");
    await rundownCommand("timer-adjust", { deltaMs: -42000 });
    assert.ok((await readRundown()).timer.elapsed >= 42000);

    await browser("open", `${origin}/login`);
    await browser("fill", "#email", operatorEmail);
    await browser("fill", "#password", operatorPassword);
    await click("Sign in");
    await browser("wait", "--url", `**/${orgId}/**`);
    await browser("open", `${origin}/${orgId}/dashboard/devices`);
    await browser("click", 'button:text-is("Add Device") >> nth=0');
    await browser("select", "#device-adapter", "dmx-artnet");
    await browser("fill", "#device-name", "Loopback lights");
    await browser("fill", "#device-field-host", "127.0.0.1");
    await browser("click", "form button[type=submit]");
    await browser("wait", "text=Configuration & device details");
    await browser("open", `${origin}/${orgId}/settings?section=api`);
    await browser("fill", 'input[placeholder="Main room computer"]', "DMX simulator");
    await click("Create key");
    await browser("wait", "text=Copy this key into the Bridge now.");
    const key = (await browser("eval", "[...document.querySelectorAll('code')].map(el => el.textContent).find(text => /^sp_[a-f0-9]{64}$/.test(text))")).result;
    assert.match(key, /^sp_[a-f0-9]{64}$/);
    await click("Dismiss key");
    await browser("find", "label", "Destination name", "fill", "Loopback DMX");
    await browser("find", "label", "Host or IP address", "fill", "127.0.0.1");
    await browser("fill", 'input[placeholder="4455"]', "6454");
    await browser("select", 'section:has(h3:text-is("Approved Bridge destinations")) select', "dmx-artnet");
    await click("Approve destination");
    await browser("wait", 'button[aria-label="Remove approval for Loopback DMX"]');

    const recipient = await createBridgeSettingsRecipient();
    const target = "127.0.0.1:6454";
    const commands = [];
    bridge = new WebSocket(`${origin.replace("http:", "ws:")}/api/bridge/${orgId}/ws?role=bridge`, { headers: { "x-showpilot-api-key": key, "x-showpilot-bridge-policy": "3", "x-showpilot-settings-key": recipient.publicKey } });
    bridge.on("message", async data => {
      const message = JSON.parse(String(data));
      if (message.type === "bridge-role") {
        bridge.send(JSON.stringify({ type: "bridge-role-applied", role: message.role, selectionId: message.selectionId }));
        bridge.send(JSON.stringify({ type: "device-status", target, connected: true }));
      }
      if (message.type === "bridge-policy") bridge.send(JSON.stringify({ type: "bridge-policy-applied", policyId: message.policyId }));
      if (message.type === "command") {
        try {
          assert.equal(message.target, target);
          assert.equal(message.protocol, "dmx-artnet");
          const command = JSON.parse(message.command);
          commands.push(command);
          await dmx.executeAction(command.actionId, command.params);
          bridge.send(JSON.stringify({ type: "command-response", id: message.id, success: true }));
        } catch (error) { bridge.send(JSON.stringify({ type: "command-response", id: message.id, success: false, error: error.message })); }
      }
    });
    await once(bridge, "open");
    const form = 'form:has(input[placeholder="00:05:00:00"])';
    const readEvents = async () => {
      const response = await fetch(`${origin}/api/timecode/${orgId}/events?showId=smoke-show`, { headers: { Cookie: operatorCookie } });
      assert.equal(response.status, 200); return response.json();
    };
    await browser("open", `${origin}/${orgId}/timecode`);
    await browser("wait", "text=Start Internal Generator");
    for (const [action, field, option, label] of [
      ["rundown-goto-item", "Rundown item", "2. Message", "Jump to Message"],
      ["lighting-blackout", "Lighting device", "1. Loopback lights", "Blackout Loopback lights"],
    ]) {
      await browser("fill", `${form} input[placeholder="00:05:00:00"]`, "00:01:00:00");
      await browser("select", `${form} select >> nth=0`, action);
      await browser("wait", "--fn", `Array.from(document.querySelectorAll(${JSON.stringify(`${form} option`)})).some(option => option.textContent === ${JSON.stringify(option)})`);
      assert.equal((await browser("eval", `Array.from(document.querySelectorAll(${JSON.stringify(`${form} option`)})).some(option => option.textContent.includes('Main section'))`)).result, false);
      const value = (await browser("eval", `Array.from(document.querySelectorAll(${JSON.stringify(`${form} option`)})).find(option => option.textContent === ${JSON.stringify(option)}).value`)).result;
      await browser("select", `${form} select >> nth=1`, value);
      await browser("set", "viewport", "320", "780");
      await browser("scrollintoview", `${form} select >> nth=1`);
      assert.equal((await browser("eval", `document.querySelector(${JSON.stringify(form)}).scrollWidth <= document.querySelector(${JSON.stringify(form)}).clientWidth + 1`)).result, true);
      await browser("screenshot", `/tmp/showpilot-${action}-320.png`);
      await browser("set", "viewport", "1440", "900");
      await click("Add Event");
      await browser("wait", "--fn", `document.querySelector(${JSON.stringify(`${form} input[placeholder="00:05:00:00"]`)}).value === ''`);
      await click(`Fire ${label}`);
      await poll(async () => (await readEvents()).find(event => event.action === action)?.fired, `acknowledged ${action}`);
    }
    const state = await readRundown();
    assert.equal(state.timer.currentItemId, "message");
    assert.equal(state.timer.playback, "play");
    assert.equal(state.timer.elapsed, 0);
    assert.deepEqual(state.items.map(item => item.status), ["complete", "upcoming", "live"]);
    assert.deepEqual(commands, [{ actionId: "blackout", params: {} }]);
    await poll(() => lastChannels?.length === 512 && lastChannels.every(value => value === 0), "all DMX channels black");
    await dmx.executeAction("restore", {});
    await poll(() => lastChannels?.[0] === 180, "DMX restore preserves original levels");
    console.log(JSON.stringify({ passed: true, rundownItem: state.timer.currentItemId, elapsed: state.timer.elapsed, blackoutChannels: 512, restoredChannel: lastChannels[0], commands }));
  });
} finally {
  bridge?.terminate();
  dmx.disconnect();
  udp.close();
}
