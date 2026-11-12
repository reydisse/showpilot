// Exercise the compiled Worker with isolated auth and D1. No production traffic.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
await withLocalSmokeFixture(
  async ({ origin, orgId, operatorCookie, queryFixture }) => {
    const requestId = crypto.randomUUID();
    const call = (path, body) =>
      fetch(
        `${origin}/api/mobile/v1/rundowns/smoke-show/templates${path}?orgId=${orgId}`,
        {
          method: "POST",
          headers: {
            Cookie: operatorCookie,
            Origin: origin,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
    const save = (name = "Reviewed native template", id = requestId) =>
      call("", { requestId: id, name });
    const rows = () =>
      queryFixture(
        `SELECT key,value FROM app_setting WHERE orgId='${orgId}' AND key IN ('rundown-saved:${requestId}','rundown-template-save:${requestId}') ORDER BY key`,
      );
    const created = await save();
    assert.equal(created.status, 201, await created.clone().text());
    const before = await rows();
    assert.equal(before.length, 2);
    const replay = await save();
    assert.equal(replay.status, 200, await replay.clone().text());
    assert.equal((await replay.json()).created, false);
    assert.deepEqual(await rows(), before);
    const changed = await save("Changed under the same request ID");
    assert.equal(changed.status, 409, await changed.clone().text());
    assert.deepEqual(await rows(), before);
    const removed = await call(`/${requestId}/remove`, {});
    assert.equal(removed.status, 200, await removed.clone().text());
    const afterDelete = await rows();
    assert.equal(afterDelete.length, 1);
    assert.equal(afterDelete[0].key, `rundown-template-save:${requestId}`);
    const late = await save();
    assert.equal(late.status, 409, await late.clone().text());
    assert.deepEqual(await rows(), afterDelete);
    const earlyDeleteId = crypto.randomUUID();
  const earlyDelete = await call(`/${earlyDeleteId}/remove`, {});
  assert.equal(earlyDelete.status, 200, await earlyDelete.clone().text());
  const delayedCreate = await save("Save arrived after delete", earlyDeleteId);
  assert.equal(delayedCreate.status, 409, await delayedCreate.clone().text());
  const sharedId = crypto.randomUUID();
    const replies = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        save(`Concurrent ${index}`, sharedId),
      ),
    );
    assert.equal(replies.filter((reply) => reply.status === 201).length, 1);
    assert.equal(replies.filter((reply) => reply.status === 409).length, 11);
    console.log(
      JSON.stringify({
        result: "pass",
        immutableReplay: true,
        changedContentsRejected: true,
        deletedTemplateNotResurrected: true,
        deleteBeforeSaveFenced: true,
        concurrentWinnerCount: 1,
        realAuth: true,
        compiledWorker: true,
      }),
    );
  },
);
