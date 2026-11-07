// Exercise the built Settings RPCs with real auth and disposable D1 data.
// Run after pnpm --filter @showpilot/web build.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";

const web = createRequire(new URL("../package.json", import.meta.url));
const router = createRequire(web.resolve("@tanstack/react-router"));
const core = createRequire(router.resolve("@tanstack/router-core"));
const { toJSONAsync, fromCrossJSON } = core("seroval");
const { defaultSerovalPlugins } = router("@tanstack/router-core");
const names = ["getManageableOrgSettings", "updateOrgSetting", "updateOrgCredential"];
const ids = {};
const assets = resolve(import.meta.dirname, "../dist/server/assets");
for (const file of (await readdir(assets)).filter(file => file.endsWith(".js"))) {
  const source = await readFile(resolve(assets, file), "utf8");
  for (const retired of ["bulkUpdateOrgSettings", "deleteOrgSettings"]) assert.equal(source.includes(`${retired}_createServerFn_handler`), false, `Retired RPC remains in ${file}`);
  for (const name of names) ids[name] ??= source.match(new RegExp(`const ${name}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`))?.[1];
}
assert.ok(names.every(name => ids[name]), "Resolve Settings RPC IDs from this build");

await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, stopServer, queryFixture }) => {
  async function rpc(name, data, cookie = operatorCookie) {
    if (name === "updateOrgSetting") data = { requestId: crypto.randomUUID(), expectedValue: null, ...data };
    const payload = JSON.stringify(await toJSONAsync({ data }));
    const headers = { Origin: origin, "Sec-Fetch-Site": "same-origin", "x-tsr-serverFn": "true", Accept: "application/json", "Content-Type": "application/json" };
    if (cookie) headers.Cookie = cookie;
    const read = name === "getManageableOrgSettings";
    const response = await fetch(`${origin}/_serverFn/${ids[name]}${read ? `?${new URLSearchParams({ payload })}` : ""}`, {
      method: read ? "GET" : "POST", headers, ...(read ? {} : { body: payload }),
    });
    const body = fromCrossJSON(await response.json(), { refs: new Map(), plugins: defaultSerovalPlugins });
    return { status: response.status, body };
  }
  function succeeded(reply) {
    assert.equal(reply.status, 200);
    assert.equal(reply.body instanceof Error, false);
    assert.equal(reply.body.error, undefined);
    return reply.body.result;
  }
  function rejected(reply, message) {
    const error = reply.body instanceof Error ? reply.body : reply.body.error;
    assert.ok(error instanceof Error, "The RPC must return a real rejection");
    assert.match(error.message, message);
  }

  assert.deepEqual(succeeded(await rpc("getManageableOrgSettings", { orgId })), {}, "Internal stage, graphics and active-show state must not leak into Settings");
  for (const key of ["rundown-message:smoke-show", "active-graphics", "active-show-id", "incident-write:fixture-operation", "unknown-token", "schedule-provider", "constructor"]) {
    rejected(await rpc("updateOrgSetting", { orgId, key, value: "overwritten" }), /Choose a supported organization setting/);
    rejected(await rpc("updateOrgCredential", { orgId, key, change: { action: "clear" } }), /Choose a supported organization setting/);
  }
  assert.deepEqual(succeeded(await rpc("getManageableOrgSettings", { orgId })), {}, "Rejected writes must not create editable settings");
  assert.equal(succeeded(await rpc("updateOrgSetting", { orgId, key: "org-timezone", value: "America/Toronto" })).outcome, "applied");
  assert.equal(succeeded(await rpc("updateOrgSetting", { orgId, key: "clock-format", value: "24hr" })).outcome, "applied");
  assert.deepEqual(succeeded(await rpc("updateOrgCredential", { orgId, key: "slack-token", change: { action: "replace", value: "fixture-private-token" } })), { key: "slack-token", value: "••••••••" });
  assert.deepEqual(succeeded(await rpc("getManageableOrgSettings", { orgId })), {
    "org-timezone": "America/Toronto", "slack-token": "••••••••", "clock-format": "24hr",
  });
  rejected(await rpc("getManageableOrgSettings", { orgId }, ""), /Unauthorized/);
  rejected(await rpc("updateOrgSetting", { orgId: "display-other", key: "org-timezone", value: "UTC" }), /Forbidden/);
  await stopServer();
  const rows = await queryFixture(`SELECT key,value FROM app_setting WHERE orgId='${orgId}'`);
  const stored = Object.fromEntries(rows.map(row => [row.key, row.value]));
  assert.equal(stored["rundown-message:smoke-show"], "Fixture private stage message");
  assert.equal(stored["active-graphics"], '["smoke-graphic"]');
  assert.equal(stored["active-show-id"], "smoke-show");
  assert.equal(stored["incident-write:fixture-operation"], undefined);
  assert.equal(stored["unknown-token"], undefined);
  assert.equal(stored["schedule-provider"], undefined);
  assert.match(stored["slack-token"], /^spenc:v1:/);
  assert.equal(stored["slack-token"].includes("fixture-private-token"), false);
  assert.deepEqual(await queryFixture("SELECT key FROM app_setting WHERE orgId='display-other'"), []);
  console.log(JSON.stringify({ passed: true, deniedWrites: 14, internalRowsPreserved: true, retiredUnconditionalWritersRemoved: true, supportedSettingsSaved: true, credentialEncryptedAndMasked: true, authAndOrgScope: true }));
}, { paidPlan: true });
