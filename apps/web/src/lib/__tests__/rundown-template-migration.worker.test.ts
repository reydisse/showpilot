import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

it("0099 reconciles legacy template and receipt families byte-for-byte in scratch D1", async () => {
  const db = (env as unknown as { MIGRATION_DB: D1Database }).MIGRATION_DB;
  const migrations = env.TEST_MIGRATIONS;
  await applyD1Migrations(db, migrations.filter(m => !m.name.startsWith("0099")));
  await db.prepare("INSERT INTO organization(id,name,slug,createdAt) VALUES ('migration-org','Migration','migration-org',CURRENT_TIMESTAMP)").run();
  const rows = [
    ["rundown-saved:a", '{ "id":"a", "name":"A", "updatedAt":"2026-01-01", "items":[] }'],
    ["rundown-saved:b", '{"id":"b","name":"B","items":[]}'],
    ["rundown-saved:bad", "{malformed"],
    ["rundown-template-save:a", "a".repeat(64)],
    ["rundown-template-save:removed", "removed"],
    ["rundown-timer:show", '{ "running": false }'],
    ["org-timezone", "America/Toronto"],
  ];
  await db.batch(rows.map(([key,value], i) => db.prepare("INSERT INTO app_setting(id,orgId,key,value) VALUES (?,'migration-org',?,?)").bind(String(i),key,value)));
  await applyD1Migrations(db, migrations);
  const templates = (await db.prepare("SELECT templateId,payload FROM rundown_template WHERE orgId='migration-org' ORDER BY templateId").all()).results;
  expect(templates).toEqual(rows.slice(0,3).map(([key,payload]) => ({templateId:key.slice("rundown-saved:".length),payload})));
  const receipts = (await db.prepare("SELECT templateId,value FROM rundown_template_receipt WHERE orgId='migration-org' ORDER BY templateId").all()).results;
  expect(receipts).toEqual(rows.slice(3,5).map(([key,value]) => ({templateId:key.slice("rundown-template-save:".length),value})));
  expect((await db.prepare("SELECT key,value FROM app_setting WHERE orgId='migration-org' ORDER BY key").all()).results).toEqual(rows.slice(5).reverse().map(([key,value]) => ({key,value})));
});
