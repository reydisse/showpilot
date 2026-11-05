// Real browser/API/socket/D1 credential rehearsal. Uses only disposable local data.
// Run after the web build: node apps/web/scripts/smoke-bridge-credentials.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";

// Exercise the same WebSocket implementation as the standalone Bridge.
const { WebSocket } = createRequire(new URL("../../bridge/package.json", import.meta.url))("ws");
await withLocalSmokeFixture(async ({ origin, orgId, browser, queryFixture, operatorEmail, operatorPassword }) => {
  const click = (name) => browser("find", "role", "button", "click", "--name", name, "--exact");
  const keyFromPage = async () => (await browser("eval", "[...document.querySelectorAll('code')].map(el => el.textContent).find(text => /^sp_[a-f0-9]{64}$/.test(text))")).result;
  const status = async (key, path) => fetch(`${origin}${path}`, { redirect: "manual", headers: { "x-showpilot-api-key": key, "x-showpilot-bridge-policy": "1" } });
  const sockets = [];
  const probeKey = (key) => new Promise((resolve, reject) => {
    const socket = new WebSocket(`${origin.replace("http:", "ws:")}/api/bridge/${orgId}/ws?role=bridge`, { headers: { "x-showpilot-api-key": key, "x-showpilot-bridge-policy": "1" } });
    sockets.push(socket);
    const timeout = setTimeout(() => { reject(new Error("Bridge upgrade timed out")); socket.terminate(); }, 10_000);
    socket.once("open", () => { clearTimeout(timeout); resolve({ status: 101, socket }); });
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timeout); response.resume(); resolve({ status: response.statusCode, socket }); socket.terminate();
    });
    socket.on("error", (error) => { clearTimeout(timeout); reject(error); });
  });
  await browser("open", `${origin}/login`);
  await browser("fill", "#email", operatorEmail);
  await browser("fill", "#password", operatorPassword);
  await click("Sign in");
  await browser("wait", "--url", `**/${orgId}/**`);
  await browser("open", `${origin}/${orgId}/settings?section=api`);
  await browser("wait", 'input[placeholder="Main room computer"]');
  await browser("fill", 'input[placeholder="Main room computer"]', "Fixture main computer");
  await click("Create key");
  await browser("wait", "text=Copy this key into the Bridge now.");
  const initialKey = await keyFromPage();
  assert.match(initialKey, /^sp_[a-f0-9]{64}$/);
  const stored = await queryFixture("SELECT keyHash FROM bridge_credential WHERE orgId = 'display-smoke'");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].keyHash, createHash("sha256").update(initialKey).digest("hex"));
  assert.equal(JSON.stringify(stored).includes(initialKey), false);

  try {
    const opened = await probeKey(initialKey);
    assert.equal(opened.status, 101);
    const socket = opened.socket;
    socket.send(JSON.stringify({ type: "bridge-status", version: "credential-fixture", devices: 0, uptime: 1 }));
    const writes = await queryFixture("SELECT a.action, a.credentialId, c.keyHash FROM bridge_credential_audit a JOIN bridge_credential c ON a.credentialId = c.id AND a.orgId = c.orgId WHERE a.orgId = 'display-smoke'");
    assert.ok(writes.some(row => row.action === "bridge-status" && row.keyHash === stored[0].keyHash), "Live relay write must identify its credential");
    assert.equal(JSON.stringify(writes).includes(initialKey), false);
    await click("Dismiss key");
    await click("Rotate key");
    await browser("wait", "text=Previous keys remain valid for up to 10 minutes");
    const rotatedKey = await keyFromPage();
    assert.match(rotatedKey, /^sp_[a-f0-9]{64}$/);
    assert.notEqual(rotatedKey, initialKey);
    assert.equal(socket.readyState, WebSocket.OPEN, "Rotation must preserve the connected Bridge");
    socket.send(JSON.stringify({ type: "bridge-status", version: "credential-fixture", devices: 0, uptime: 2 }));
    const overlapWrites = await queryFixture("SELECT COUNT(*) AS count FROM bridge_credential_audit WHERE orgId = 'display-smoke' AND action = 'bridge-status'");
    assert.equal(overlapWrites[0].count, 2, "The old connection must still write during overlap");
    const duplicate = await probeKey(rotatedKey);
    const duplicateClosed = await new Promise(resolve => duplicate.socket.once("close", resolve));
    assert.equal(duplicateClosed, 4410, "Rotated keys must not create a second connection for one installation");
    const originalClosed = new Promise(resolve => socket.once("close", resolve));
    socket.close(1000, "Reconnect with rotated key");
    await originalClosed;
    const replacement = await probeKey(rotatedKey);
    assert.equal(replacement.status, 101, "The new key must reconnect successfully");
    assert.equal((await fetch(`${origin}/api/bridge/${orgId}/status?key=${rotatedKey}`)).status, 401);
    for (const path of [`/api/timecode/${orgId}/state`, `/api/rundown/${orgId}/state`, `/api/lowerthirds/${orgId}/current`]) {
      assert.equal((await status(rotatedKey, path)).status, 401, "Bridge key must not grant member access");
    }
    for (const path of [`/api/timecode/${orgId}/command`, `/api/rundown/${orgId}/command`, `/api/lowerthirds/${orgId}/trigger`]) {
      const response = await fetch(`${origin}${path}`, { method: "POST", redirect: "manual", headers: { "x-showpilot-api-key": rotatedKey, "Content-Type": "application/json" }, body: JSON.stringify({ action: "stage-message", payload: { message: "Unauthorized fixture write" } }) });
      assert.equal(response.status, 401, "Bridge key must not authorize member writes");
    }
    await click("Dismiss key");
    await browser("fill", 'input[placeholder="Main room computer"]', "Fixture second computer");
    await click("Create key");
    await browser("wait", "text=Copy this key into the Bridge now.");
    const secondInstallationKey = await keyFromPage();
    assert.match(secondInstallationKey, /^sp_[a-f0-9]{64}$/);
    assert.equal(replacement.socket.readyState, WebSocket.OPEN, "Replacement Bridge closed before revocation");
    const closed = new Promise((resolve) => {
      // Miniflare can keep TCP open after both peers exchange Close frames.
      // Access must stop immediately; allow ws's standard 30s close deadline
      // for the final event without forcibly terminating the tested socket.
      const timeout = setTimeout(() => resolve(null), 35_000);
      replacement.socket.once("close", (code) => { clearTimeout(timeout); resolve(code); });
    });
    await browser("click", 'li:has-text("Fixture main computer") button:has-text("Revoke")');
    await browser("wait", "text=Installation revoked and disconnected.");
    assert.notEqual(replacement.socket.readyState, WebSocket.OPEN, "Revocation must immediately stop the live transport");
    const refusedWrite = await new Promise(resolve => replacement.socket.send(JSON.stringify({ type: "bridge-status", version: "revoked-write" }), error => resolve(error)));
    assert.ok(refusedWrite, "A revoked live socket must refuse further writes");
    assert.equal((await probeKey(initialKey)).status, 401);
    assert.equal((await probeKey(rotatedKey)).status, 401);
    assert.equal((await probeKey(secondInstallationKey)).status, 101, "Revoking one installation must not revoke another");
    await browser("reload");
    await browser("wait", "text=Fixture main computer");
    assert.equal(await keyFromPage(), undefined, "Keys must not be retrievable after reload");
    const installations = await queryFixture("SELECT label, lastUsedAt, revokedAt FROM bridge_installation WHERE orgId = 'display-smoke'");
    assert.equal(installations.length, 2);
    const revoked = installations.find(row => row.label === "Fixture main computer");
    assert.ok(revoked.lastUsedAt > 0 && revoked.revokedAt > 0);
    assert.equal(installations.find(row => row.label === "Fixture second computer").revokedAt, null);
    assert.equal(await closed, 4403, "Revoked connection must finish closing with its rejection code");
    console.log(JSON.stringify({ createAndHashStorage: "passed", liveWriteAttribution: "passed", rotationOverlap: "passed", transportOnly: "passed", queryKey: "rejected", liveRevocation: "passed", independentInstallations: "passed", oneTimeKeyDisplay: "passed" }, null, 2));
  } finally { for (const socket of sockets) socket.terminate(); }
});
