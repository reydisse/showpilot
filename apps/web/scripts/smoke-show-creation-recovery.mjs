// Compiled web/native adapters, real authentication, D1 and live RundownRelay.
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
const ids = {}, names = ["createNextService", "deleteService", "getRundownState"];
const assets = resolve(import.meta.dirname, "../dist/server/assets");
for (const file of (await readdir(assets)).filter(file => file.endsWith(".js"))) {
  const source = await readFile(resolve(assets, file), "utf8");
  for (const name of names) ids[name] ??= source.match(new RegExp(`const ${name}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`))?.[1];
}
assert.ok(names.every(name => ids[name]), "Built creation/deletion RPCs exist");
await withLocalSmokeFixture(async ({ origin, orgId, date, operatorCookie, queryFixture }) => {
  const headers = { Cookie: operatorCookie, Origin: origin, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" };
  async function rpc(name, data) {
    const payload = JSON.stringify(await toJSONAsync({ data: { orgId, ...data } }));
    const url = `${origin}/_serverFn/${ids[name]}`;
    const read = name === "getRundownState";
    const response = await fetch(read ? `${url}?payload=${encodeURIComponent(payload)}` : url, {
      method: read ? "GET" : "POST", headers: { ...headers, "x-tsr-serverFn": "true" },
      ...(read ? {} : {body:payload}),
    });
    const reply = fromCrossJSON(await response.json(), { refs: new Map(), plugins: defaultSerovalPlugins });
    if (reply instanceof Error) throw reply;
    if (reply.error) throw reply.error;
    assert.equal(response.status, 200);
    return reply.result;
  }
  async function command(showId, serviceDate, action, payload) {
    const response = await fetch(`${origin}/api/rundown/${orgId}/command?showId=${showId}&serviceDate=${serviceDate}`, {
      method: "POST", headers, body: JSON.stringify({ action, payload }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).ok, true);
  }
  await command("smoke-show", date, "add-item", { id: "creation-source-item", title: "Original source item", type: "segment", duration: 300000, notes: "Original note", assignee: "", cue: "", hardStop: false });
  const input = { requestId: crypto.randomUUID(), serviceDate: "2099-02-01", name: "Creation retry fixture", startTime: "10:00", timeZone: "UTC", copyFrom: date, copyFromShowId: "smoke-show" };
  // The first result is deliberately unused: recovery must not need its body.
  await rpc("createNextService", input);
  const recovered = await rpc("createNextService", input);
  assert.equal(recovered.showId, input.requestId);
  const rows = await queryFixture(`SELECT title,status,actualStart,actualEnd FROM rundown_item WHERE orgId='display-smoke' AND showId='${input.requestId}'`);
  assert.deepEqual(rows, [{ title: "Original source item", status: "upcoming", actualStart: null, actualEnd: null }]);
  // Follow the operator's load/seed handshake before editing the new relay room.
  const loaded = await rpc("getRundownState", {showId:input.requestId,serviceDate:input.serviceDate});
  assert.equal(loaded.items.length,1);
  await command(input.requestId,input.serviceDate,"seed",{items:loaded.items,serviceName:loaded.meta.name,scheduledStartTime:loaded.meta.scheduledStartTime});
  await command(input.requestId, input.serviceDate, "update-meta", { serviceName: "Later operator title", location: "Later room" });
  await command(input.requestId, input.serviceDate, "update-item", { id: input.requestId + "-0", updates: { title: "Later target item" } });
  await rpc("createNextService", input);
  assert.equal((await queryFixture(`SELECT name FROM rundown WHERE orgId='display-smoke' AND id='${input.requestId}'`))[0].name, "Later operator title");
  assert.equal((await queryFixture(`SELECT title FROM rundown_item WHERE orgId='display-smoke' AND showId='${input.requestId}'`))[0].title, "Later target item");
  // The native HTTP adapter must recover the same receipt as the web RPC.
  const mobile = await fetch(`${origin}/api/mobile/v1/rundowns`, { method: "POST", headers,
    body: JSON.stringify({ ...input, orgId }) });
  assert.equal(mobile.status, 201, await mobile.clone().text());
  assert.equal((await mobile.json()).showId, input.requestId);
  await rpc("deleteService", { showId: input.requestId });
  await assert.rejects(rpc("createNextService", input), /removed/);
  assert.deepEqual(await queryFixture(`SELECT id FROM rundown WHERE orgId='display-smoke' AND id='${input.requestId}'`), []);
  assert.equal((await queryFixture(`SELECT requestId FROM show_creation_request WHERE orgId='display-smoke' AND requestId='${input.requestId}'`)).length, 1);
  console.log(JSON.stringify({ recoveredOriginalShow: true, cleanClone: true, newerTitleAndItemsPreserved: true, nativeReceiptShared: true, deletedShowNotRecreated: true }));
});
