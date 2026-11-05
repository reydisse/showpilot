// Rehearse approval management and real browser-to-Bridge enforcement with disposable local data.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
const { WebSocket } = createRequire(new URL("../../bridge/package.json", import.meta.url))("ws");
await withLocalSmokeFixture(async ({ origin, orgId, browser, operatorEmail, operatorPassword, operatorCookie, queryFixture }) => {
  const sockets = [];
  const next = (socket, type) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.off("message", handler); reject(new Error(`Missing ${type}`)); }, 10000);
    const handler = data => {
      const message = JSON.parse(String(data));
      if (message.type !== type) return;
      clearTimeout(timeout); socket.off("message", handler); resolve(message);
    };
    socket.on("message", handler);
  });
  async function open(role, headers) {
    const socket = new WebSocket(`${origin.replace("http:", "ws:")}/api/bridge/${orgId}/ws?role=${role}`, { headers });
    sockets.push(socket);
    await next(socket, role === "bridge" ? "bridge-role" : "bridge-status");
    return socket;
  }
  try {
  const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
  await browser("open", `${origin}/login`);
  await browser("fill", "#email", operatorEmail);
  await browser("fill", "#password", operatorPassword);
  await click("Sign in");
  await browser("wait", "--url", `**/${orgId}/**`);
  await browser("open", `${origin}/${orgId}/settings?section=api`);
  await browser("wait", 'input[placeholder="Main room computer"]');
  await browser("fill", 'input[placeholder="Main room computer"]', "Allowlist fixture Bridge");
  await click("Create key");
  await browser("wait", "text=Copy this key into the Bridge now.");
  const key = (await browser("eval", "[...document.querySelectorAll('code')].map(el => el.textContent).find(text => /^sp_[a-f0-9]{64}$/.test(text))")).result;
  assert.match(key, /^sp_[a-f0-9]{64}$/);
  await click("Dismiss key");
  const legacy = new WebSocket(`${origin.replace("http:", "ws:")}/api/bridge/${orgId}/ws?role=bridge&targetPolicyVersion=1`, { headers: { "x-showpilot-api-key": key } });
  sockets.push(legacy);
  const legacyStatus = await new Promise((resolve, reject) => {
    legacy.once("unexpected-response", (_request, response) => { response.resume(); resolve(response.statusCode); legacy.terminate(); });
    legacy.once("open", () => reject(new Error("Legacy Bridge unexpectedly connected")));
    legacy.on("error", reject);
  });
  assert.equal(legacyStatus, 426, "Legacy Bridge was not told to update");
  const bridge = await open("bridge", { "x-showpilot-api-key": key, "x-showpilot-bridge-policy": "1" });
  const operator = await open("client", { Cookie: operatorCookie, Origin: origin });
  let forwarded = 0;
  bridge.on("message", data => {
    const message = JSON.parse(String(data));
    if (message.type === "bridge-policy") bridge.send(JSON.stringify({ type: "bridge-policy-applied", policyId: message.policyId }));
    if (message.type === "command") {
      forwarded++;
      bridge.send(JSON.stringify({ type: "command-response", id: message.id, success: true, response: "fixture acknowledged" }));
    } else if (message.type === "connect-device") {
      forwarded++;
      bridge.send(JSON.stringify({ type: "device-status", target: message.target, connected: true }));
    }
  });
  async function command() {
    const response = next(operator, "command-response");
    operator.send(JSON.stringify({ type: "command", id: "fixture-command", protocol: "obs", target: "venue.local:4455", command: "fixture" }));
    return response;
  }
  assert.equal((await command()).success, false);
  assert.equal(forwarded, 0, "Unapproved command reached the Bridge");
  await browser("open", `${origin}/${orgId}/settings?section=integrations`);
  await browser("wait", "text=Approved Bridge destinations");
  await browser("find", "label", "Destination name", "fill", "Fixture OBS");
  await browser("find", "label", "Host or IP address", "fill", "VENUE.LOCAL.");
  await browser("find", "label", "Port", "fill", "4455");
  await click("Approve destination");
  await browser("wait", "text=venue.local:4455 · OBS");
  const targets = async () => queryFixture("SELECT label,host,port,protocol,approvedByUserId FROM bridge_target_allowlist WHERE orgId='display-smoke'");
  assert.deepEqual(await targets(), [{ label: "Fixture OBS", host: "venue.local", port: 4455, protocol: "obs", approvedByUserId: "smoke-operator" }]);
  const connected = next(operator, "device-status");
  operator.send(JSON.stringify({ type: "connect-device", protocol: "obs", target: "venue.local:4455", settings: {} }));
  assert.equal((await connected).connected, true);
  assert.equal((await command()).success, true);
  assert.equal(forwarded, 2);

  await browser("open", `${origin}/${orgId}/settings?section=api`);
  await browser("wait", "text=venue.local:4455 · OBS");
  for (const width of [320, 768, 2560]) {
    await browser("set", "viewport", String(width), "900");
    const layout = (await browser("eval", `(() => {
      const section = [...document.querySelectorAll('section')].find(el => el.querySelector('h3')?.textContent === 'Approved Bridge destinations');
      const bounds = section.getBoundingClientRect();
      return { width: innerWidth, left: bounds.left, right: bounds.right, scroll: section.scrollWidth, client: section.clientWidth,
        controls: [...section.querySelectorAll('input,select,button')].map(el => ({ height: el.getBoundingClientRect().height, width: el.getBoundingClientRect().width })) };
    })()`)).result;
    assert.ok(layout.scroll <= layout.client + 1, `Approval panel overflows at ${width}px`);
    assert.ok(layout.left >= -1 && layout.right <= width + 1, `Approval panel outside viewport at ${width}px`);
    assert.ok(layout.controls.every(control => control.height >= 44 && control.width > 0), `Unreachable controls at ${width}px`);
  }
  await click("Remove approval for Fixture OBS");
  await browser("wait", '[role="dialog"]');
  await click("Cancel");
  assert.equal((await targets()).length, 1);
  await click("Remove approval for Fixture OBS");
  await browser("click", '[role="dialog"] button:text-is("Remove approval")');
  await browser("wait", "text=No Bridge destinations approved yet.");
  assert.deepEqual(await targets(), []);
  assert.equal((await command()).success, false);
  assert.equal(forwarded, 2, "A command reached the Bridge after approval was removed");
  const audit = await queryFixture("SELECT action,actorUserId,host,port,protocol FROM bridge_target_audit WHERE orgId='display-smoke' ORDER BY createdAt");
  assert.deepEqual(audit, ["rejected", "approved", "connection-requested", "removed", "rejected"].map(action => ({ action, actorUserId: "smoke-operator", host: "venue.local", port: 4455, protocol: "obs" })));
  console.log(JSON.stringify({ login: "passed", legacyBridgeUpgrade: "rejected", canonicalApproval: "passed", crossSettingsVisibility: "passed", responsiveWidths: [320, 768, 2560], cancel: "passed", confirmedRemoval: "passed", actorAudit: "passed", unapprovedCommandBlocked: "passed", approvedDispatch: "passed", postRemovalCommandBlocked: "passed" }, null, 2));
  } finally { for (const socket of sockets) socket.terminate(); }
});
