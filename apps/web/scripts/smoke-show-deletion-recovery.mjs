// Deletion retries through compiled web/native adapters and real local D1/relays.
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
const ids = {},
  names = ["deleteService", "getRundownState"];
const assets = resolve(import.meta.dirname, "../dist/server/assets");
for (const file of (await readdir(assets)).filter((file) =>
  file.endsWith(".js"),
)) {
  const source = await readFile(resolve(assets, file), "utf8");
  for (const name of names)
    ids[name] ??= source.match(
      new RegExp(
        `const ${name}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`,
      ),
    )?.[1];
}
assert.ok(
  names.every((name) => ids[name]),
  "Built deletion RPCs exist",
);
await withLocalSmokeFixture(
  async ({ origin, orgId, date, operatorCookie, queryFixture }) => {
    const headers = {
      Cookie: operatorCookie,
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
    };
    async function rpc(name, data) {
      const payload = JSON.stringify(
        await toJSONAsync({ data: { orgId, ...data } }),
      );
      const url = `${origin}/_serverFn/${ids[name]}`;
      const read = name === "getRundownState";
      const response = await fetch(
        read ? `${url}?payload=${encodeURIComponent(payload)}` : url,
        {
          method: read ? "GET" : "POST",
          headers: { ...headers, "x-tsr-serverFn": "true" },
          ...(read ? {} : { body: payload }),
        },
      );
      const reply = fromCrossJSON(await response.json(), {
        refs: new Map(),
        plugins: defaultSerovalPlugins,
      });
      if (reply instanceof Error) throw reply;
      if (reply.error) throw reply.error;
      assert.equal(response.status, 200);
      return reply.result;
    }
    const rows = () =>
      queryFixture(
        "SELECT id FROM rundown WHERE orgId='display-smoke' AND id='smoke-show'",
      );
    assert.equal((await rows()).length, 1);
    const original = (
      await queryFixture(
        "SELECT strftime('%Y-%m-%dT%H:%M:%fZ',updatedAt) AS updatedAt FROM rundown WHERE orgId='display-smoke' AND id='smoke-show'",
      )
    )[0];
    const input = {
      showId: "smoke-show",
      userId: "smoke-operator",
      expectedUpdatedAt: new Date(original.updatedAt).toISOString(),
    };
    assert.deepEqual(await rpc("deleteService", input), { ok: true });
    // The successful response is lost to the client. An identical retry confirms
    // completion without recreating the show or failing as "not found".
    assert.deepEqual(await rpc("deleteService", input), { ok: true });
    assert.equal((await rows()).length, 0);
    assert.deepEqual(
      await queryFixture(
        "SELECT stage FROM show_deletion WHERE orgId='display-smoke' AND showId='smoke-show'",
      ),
      [{ stage: "deleted" }],
    );
    const native = await fetch(
      `${origin}/api/mobile/v1/schedule/services/smoke-show/remove?orgId=${orgId}`,
      { method: "POST", headers },
    );
    assert.equal(native.status, 200, await native.clone().text());
    assert.deepEqual(await native.json(), { ok: true });
    console.log(
      JSON.stringify({
        recoveredLostDeleteReply: true,
        oneDeletedReceipt: true,
        nativeRetry: true,
      }),
    );
  },
);
