// Built browser + real Worker/D1 + two local Bridge sockets. No remote data.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
const { WebSocket } = createRequire(new URL("../../bridge/package.json", import.meta.url))("ws");
await withLocalSmokeFixture(async ({ origin, orgId, browser, operatorEmail, operatorPassword, operatorCookie, queryFixture }) => {
  const sockets = [];
  const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
  const status = async () => {
    const response = await fetch(`${origin}/api/bridge/${orgId}/status`, { headers: { Cookie: operatorCookie } });
    assert.equal(response.status, 200);
    return response.json();
  };
  async function install(label) {
    await browser("fill", 'input[placeholder="Main room computer"]', label);
    await click("Create key");
    await browser("wait", "text=Copy this key into the Bridge now.");
    const key = (await browser("eval", "[...document.querySelectorAll('code')].map(el => el.textContent).find(text => /^sp_[a-f0-9]{64}$/.test(text))")).result;
    assert.match(key, /^sp_[a-f0-9]{64}$/);
    await click("Dismiss key");
    const socket = new WebSocket(`${origin.replace("http:", "ws:")}/api/bridge/${orgId}/ws?role=bridge`, { headers: { "x-showpilot-api-key": key, "x-showpilot-bridge-policy": "1" } });
    sockets.push(socket);
    let currentRole;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("No installation role received")), 10_000);
      socket.on("error", reject);
      socket.on("message", data => {
        const message = JSON.parse(String(data));
        if (message.type !== "bridge-role") return;
        currentRole = message.role;
        if (message.selectionId) socket.send(JSON.stringify({ type: "bridge-role-applied", role: currentRole, selectionId: message.selectionId }));
        clearTimeout(timeout); resolve();
      });
    });
    return { socket, role: () => currentRole };
  }
  try {
    await browser("open", `${origin}/login`);
    await browser("fill", "#email", operatorEmail);
    await browser("fill", "#password", operatorPassword);
    await click("Sign in");
    await browser("wait", "--url", `**/${orgId}/**`);
    await browser("open", `${origin}/${orgId}/settings?section=api`);
    await browser("wait", 'input[placeholder="Main room computer"]');
    const main = await install("Fixture main computer");
    const backup = await install("Fixture backup computer");
    assert.equal(main.role(), "active"); assert.equal(backup.role(), "standby");
    await click("Refresh status");
    await browser("wait", "text=Standby · Connected");
    await click("Take control");
    await browser("wait", '[role="dialog"]');
    await click("Cancel");
    assert.equal((await status()).activeInstallation.label, "Fixture main computer");
    await click("Take control");
    await browser("click", '[role="dialog"] button:text-is("Take control")');
    await browser("wait", "text=Fixture backup computer now controls venue devices.");
    assert.equal((await status()).activeInstallation.label, "Fixture backup computer");
    assert.equal(main.role(), "standby"); assert.equal(backup.role(), "active");
    const audit = await queryFixture("SELECT actorUserId FROM bridge_credential_audit WHERE orgId='display-smoke' AND action='selection-requested'");
    assert.deepEqual(audit, [{ actorUserId: "smoke-operator" }]);
    backup.socket.close(1000, "Fixture active computer stopped");
    for (let attempt = 0; attempt < 50 && (await status()).bridgeOnline; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await status()).bridgeOnline, false);
    assert.equal(main.role(), "standby");
    await click("Refresh status");
    await browser("wait", "text=Offline. Choose a connected standby to take control.");
    await click("Take control");
    await browser("click", '[role="dialog"] button:text-is("Take control")');
    await browser("wait", "text=Fixture main computer now controls venue devices.");
    assert.equal((await status()).activeInstallation.label, "Fixture main computer");
    console.log(JSON.stringify({ login: "passed", namedRoles: "passed", cancelPreservesOwner: "passed", explicitHandoff: "passed", actorAudit: "passed", noAutomaticPromotion: "passed", offlineRecovery: "passed" }, null, 2));
  } finally { for (const socket of sockets) socket.terminate(); }
});
