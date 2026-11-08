// Compiled native HTTP endpoints, real auth/D1 and the native receipt parser.
import assert from "node:assert/strict";
import { inventoryCommandSchema, inventoryResultSchema } from "../../mobile/src/lib/inventory-recovery.ts";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";

await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, queryFixture }) => {
  const headers = { Cookie: operatorCookie, Origin: origin, "Content-Type": "application/json" };
  const command = inventoryCommandSchema.parse({ orgId, userId: "smoke-operator", requestId: crypto.randomUUID(), operation: { kind: "create", name: "Native recovery show", description: "Retained native draft", location: "Studio", defaultStartTime: "10:30", sourceTemplateId: null } });
  const post = async (data, review = false, requestHeaders = headers) => {
    const response = await fetch(`${origin}/api/mobile/v1/schedule/inventory/${review ? "review" : "command"}?orgId=${orgId}`, { method: "POST", headers: requestHeaders, body: JSON.stringify(data) });
    const body = await response.json();
    return { status: response.status, body };
  };
  const accepted = async (data, review = false) => {
    const response = await post(data, review);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return inventoryResultSchema.parse(response.body);
  };
  const first = await accepted(command);
  assert.equal(first.outcome, "applied");
  assert.deepEqual(await accepted(command), first);
  assert.deepEqual(await accepted(command, true), first);
  assert.equal((await queryFixture(`SELECT COUNT(*) AS count FROM show_inventory_item WHERE orgId='display-smoke' AND id='${command.requestId}'`))[0].count, 1);
  const archive = { orgId, userId: command.userId, requestId: crypto.randomUUID(), operation: { kind: "archive", id: first.id, archived: true, expectedUpdatedAt: first.item.updatedAt } };
  const archived = await accepted(archive);
  assert.equal(archived.outcome, "applied"); assert.ok(archived.item.archivedAt);
  assert.deepEqual(await accepted(archive), archived);
  const restore = { ...archive, requestId: crypto.randomUUID(), operation: { ...archive.operation, archived: false, expectedUpdatedAt: archived.item.updatedAt } };
  const restored = await accepted(restore);
  assert.equal(restored.outcome, "applied"); assert.equal(restored.item.archivedAt, null);
  const late = await accepted(archive);
  assert.equal(late.outcome, "superseded"); assert.equal(late.item.archivedAt, null);
  assert.equal((await accepted({ ...archive, requestId: crypto.randomUUID() })).outcome, "conflict");
  const cancelled = { ...command, requestId: crypto.randomUUID(), operation: { ...command.operation, name: "Never delivered" } };
  assert.equal((await accepted(cancelled, true)).outcome, "cancelled");
  assert.equal((await accepted(cancelled)).outcome, "cancelled");
  assert.equal((await queryFixture(`SELECT COUNT(*) AS count FROM show_inventory_item WHERE orgId='display-smoke' AND id='${cancelled.requestId}'`))[0].count, 0);
  assert.equal((await accepted({ ...cancelled, requestId: crypto.randomUUID() })).outcome, "applied");
  assert.equal((await post({ ...command, orgId: "display-other" })).status, 400);
  assert.equal((await post({ ...command, userId: "another-user" })).status, 403);
  assert.ok((await post(command, true, { Origin: origin, "Content-Type": "application/json" })).status >= 400);
  const response = await fetch(`${origin}/api/mobile/v1/schedule?orgId=${orgId}`, { headers });
  assert.equal(response.status, 200);
  const schedule = await response.json();
  assert.equal(schedule.inventory.find(item => item.id === first.id).archivedAt, null);
  console.log(JSON.stringify({ nativeReceiptParsing: true, exactCreateReplay: true, reviewCreated: true, archiveReplay: true, lateArchivePreservesRestore: true, staleVersionConflict: true, reviewFencesLateCreate: true, freshRequestAfterReview: true, accountAndOrgIsolation: true, anonymousDenied: true, scheduleRead: true }));
});
