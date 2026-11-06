import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import { createSavedRundown } from "../saved-rundown-create.server";
async function fixture() {
  const { orgId } = await seedRelayMember(`template-${crypto.randomUUID()}`);
  return { orgId, content: { id: crypto.randomUUID(), name: "Sunday", serviceName: "Service", scheduledStartTime: "09:00", items: [] } };
}
const rows = async (orgId: string) => (await env.DB.prepare("SELECT key,value FROM app_setting WHERE orgId=? AND key LIKE 'rundown-%' ORDER BY key").bind(orgId).all<{ key: string; value: string }>()).results;
it("creates exactly one immutable template and receipt across concurrent and lost-response retries", async () => {
  const { orgId, content } = await fixture();
  const replies = await Promise.all(Array.from({ length: 12 }, () => createSavedRundown(env.DB, orgId, content)));
  expect(replies.every(result => result.ok && result.id === content.id)).toBe(true);
  const before = await rows(orgId); expect(before).toHaveLength(2);
  expect(JSON.parse(before.find(row => row.key.startsWith("rundown-saved:"))!.value)).toMatchObject(content);
  await createSavedRundown(env.DB, orgId, content);
  expect(await rows(orgId)).toEqual(before);
});
it("rejects a changed body for the same ID without overwriting the first save", async () => {
  const { orgId, content } = await fixture();
  await createSavedRundown(env.DB, orgId, content); const before = await rows(orgId);
  await expect(createSavedRundown(env.DB, orgId, { ...content, name: "Changed" })).resolves.toEqual({ ok: false, reason: "conflict" });
  expect(await rows(orgId)).toEqual(before);
});
it("does not resurrect a saved template deleted before a late retry", async () => {
  const { orgId, content } = await fixture();
  await createSavedRundown(env.DB, orgId, content);
  await env.DB.prepare("DELETE FROM app_setting WHERE orgId=? AND key=?").bind(orgId, `rundown-saved:${content.id}`).run();
  await expect(createSavedRundown(env.DB, orgId, content)).resolves.toEqual({ ok: false, reason: "removed" });
  expect(await rows(orgId)).toEqual([{ key: `rundown-template-save:${content.id}`, value: expect.any(String) }]);
});
it("isolates matching save IDs by organization and cascades receipts on organization deletion", async () => {
  const mine = await fixture(); const other = await fixture();
  await createSavedRundown(env.DB, mine.orgId, mine.content);
  await createSavedRundown(env.DB, other.orgId, { ...mine.content, name: "Other org" });
  expect(JSON.stringify(await rows(mine.orgId))).not.toContain("Other org");
  await env.DB.prepare("DELETE FROM organization WHERE id=?").bind(mine.orgId).run();
  expect(await rows(mine.orgId)).toEqual([]); expect(await rows(other.orgId)).toHaveLength(2);
});
it("rolls back the template if its receipt cannot be written", async () => {
  const { orgId, content } = await fixture();
  await env.DB.exec("CREATE TRIGGER fail_template_receipt BEFORE INSERT ON app_setting WHEN NEW.key LIKE 'rundown-template-save:%' BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END");
  try { await expect(createSavedRundown(env.DB, orgId, content)).rejects.toThrow("fixture receipt failure"); }
  finally { await env.DB.exec("DROP TRIGGER fail_template_receipt"); }
  expect(await rows(orgId)).toEqual([]);
  await expect(createSavedRundown(env.DB, orgId, content)).resolves.toMatchObject({ ok: true });
});
it("cannot take over a legacy template whose ID happens to collide", async () => {
  const { orgId, content } = await fixture();
  await env.DB.prepare("INSERT INTO app_setting(id,orgId,key,value) VALUES (?,?,?,?)")
    .bind(crypto.randomUUID(), orgId, `rundown-saved:${content.id}`, JSON.stringify({ ...content, name: "Legacy", createdAt: "2020-01-01" })).run();
  const before = await rows(orgId);
  await expect(createSavedRundown(env.DB, orgId, content)).resolves.toEqual({ ok: false, reason: "conflict" });
  expect(await rows(orgId)).toEqual(before);
});
