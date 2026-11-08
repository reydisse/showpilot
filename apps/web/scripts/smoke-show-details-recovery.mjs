// Guarded metadata through the compiled web/native adapters and live relay.
// No UI interaction is claimed by this server-contract rehearsal.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
const require = createRequire(new URL("../package.json", import.meta.url));
const router = createRequire(require.resolve("@tanstack/react-router"));
const core = createRequire(router.resolve("@tanstack/router-core"));
const { toJSONAsync, fromCrossJSON } = core("seroval");
const { defaultSerovalPlugins } = router("@tanstack/router-core");
const ids = {}, names = ["saveServiceDetails", "getRundownState"];
const assets = resolve(import.meta.dirname, "../dist/server/assets");
for (const file of (await readdir(assets)).filter(file => file.endsWith(".js"))) {
  const source = await readFile(resolve(assets, file), "utf8");
  for (const name of names) ids[name] ??= source.match(new RegExp(`const ${name}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`))?.[1];
}
assert.ok(names.every(name => ids[name]), "Built metadata RPCs exist");
await withLocalSmokeFixture(async ({ origin, orgId, date, operatorCookie, queryFixture }) => {
  const headers = { Cookie: operatorCookie, Origin: origin, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" };
  async function rpc(name, data) {
    const payload = JSON.stringify(await toJSONAsync({ data: { orgId, ...data } }));
    const url = `${origin}/_serverFn/${ids[name]}`;
    const read = name === "getRundownState";
    const response = await fetch(read ? `${url}?payload=${encodeURIComponent(payload)}` : url, {
      method: read ? "GET" : "POST", headers: { ...headers, "x-tsr-serverFn": "true" },
      ...(read ? {} : { body: payload }),
    });
    const reply = fromCrossJSON(await response.json(), { refs: new Map(), plugins: defaultSerovalPlugins });
    if (reply instanceof Error) throw reply;
    if (reply.error) throw reply.error;
    assert.equal(response.status, 200);
    return reply.result;
  }
  const row = async () => (await queryFixture("SELECT name,location,updatedAt FROM rundown WHERE orgId='display-smoke' AND id='smoke-show'"))[0];
  const original = await row();
  const input = { requestId: crypto.randomUUID(), showId: "smoke-show", serviceDate: date, name: "Web edit", startTime: "10:00", callTime: "09:00", location: "Web room", timeZone: "UTC", expectedUpdatedAt: original.updatedAt };
  await rpc("saveServiceDetails", input);
  // The first reply was lost: replaying the identical request must confirm it.
  const replay = await rpc("saveServiceDetails", input);
  assert.equal(replay.outcome, "applied");
  assert.equal((await queryFixture(`SELECT COUNT(*) AS count FROM show_details_request WHERE orgId='display-smoke' AND requestId='${input.requestId}'`))[0].count, 1);
  console.log(JSON.stringify({ recoveredLostSaveReply: true, oneReceipt: true }));
});
