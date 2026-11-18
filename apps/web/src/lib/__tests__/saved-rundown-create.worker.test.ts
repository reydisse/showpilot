import { removeSavedRundown } from "../saved-rundown-delete.server";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import { createSavedRundown } from "../saved-rundown-create.server";
async function fixture() {
  const actor = await seedRelayMember(`template-${crypto.randomUUID()}`);
  return { ...actor, actor: { ...actor, pin: null }, content: { id: crypto.randomUUID(), name: "Sunday", serviceName: "Service", scheduledStartTime: "09:00", items: [] } };
}
const rows = async (orgId: string) => (await env.DB.prepare("SELECT key,value FROM (SELECT orgId,'rundown-saved:'||templateId AS key,payload AS value FROM rundown_template UNION ALL SELECT orgId,'rundown-template-save:'||templateId AS key,value FROM rundown_template_receipt) WHERE orgId=? ORDER BY key").bind(orgId).all<{ key: string; value: string }>()).results;
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
  await env.DB.prepare("DELETE FROM rundown_template WHERE orgId=? AND templateId=?").bind(orgId, content.id).run();
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
  await env.DB.exec("CREATE TRIGGER fail_template_receipt BEFORE INSERT ON rundown_template_receipt BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END");
  try { await expect(createSavedRundown(env.DB, orgId, content)).rejects.toThrow("fixture receipt failure"); }
  finally { await env.DB.exec("DROP TRIGGER fail_template_receipt"); }
  expect(await rows(orgId)).toEqual([]);
  await expect(createSavedRundown(env.DB, orgId, content)).resolves.toMatchObject({ ok: true });
});
it("cannot take over a legacy template whose ID happens to collide", async () => {
  const { orgId, content } = await fixture();
  await env.DB.prepare("INSERT INTO rundown_template(id,orgId,templateId,payload,name,updatedAt) VALUES (?,?,?,?,'','')")
    .bind(crypto.randomUUID(), orgId, content.id, JSON.stringify({ ...content, name: "Legacy", createdAt: "2020-01-01" })).run();
  const before = await rows(orgId);
  await expect(createSavedRundown(env.DB, orgId, content)).resolves.toEqual({ ok: false, reason: "conflict" });
  expect(await rows(orgId)).toEqual(before);
});

it("atomically fences deletion of a legacy template and rolls back if deleting fails", async () => {
  const { orgId, content, actor } = await fixture();
  await env.DB.prepare("INSERT INTO rundown_template(id,orgId,templateId,payload,name,updatedAt) VALUES (?,?,?,?,'','')").bind(crypto.randomUUID(), orgId, content.id, JSON.stringify(content)).run();
  const before = await rows(orgId);
  await env.DB.exec("CREATE TRIGGER fail_template_delete BEFORE DELETE ON rundown_template BEGIN SELECT RAISE(ABORT, 'fixture delete failure'); END");
  try { await expect(removeSavedRundown(env.DB, orgId, content.id, actor)).rejects.toThrow("fixture delete failure"); }
  finally { await env.DB.exec("DROP TRIGGER fail_template_delete"); }
  expect(await rows(orgId)).toEqual(before);
  await removeSavedRundown(env.DB, orgId, content.id, actor);
  await expect(createSavedRundown(env.DB, orgId, content)).resolves.toEqual({ ok: false, reason: "removed" });
});
it("a delete delivered before the save fences every later retry, in that organization only", async () => {
  const f = await fixture(), other = await fixture();
  await removeSavedRundown(env.DB, f.orgId, f.content.id, f.actor);
  await expect(createSavedRundown(env.DB, f.orgId, f.content)).resolves.toEqual({ ok: false, reason: "removed" });
  await expect(createSavedRundown(env.DB, other.orgId, f.content)).resolves.toEqual({ ok: true, id: f.content.id });
  expect(await rows(f.orgId)).toEqual([{ key: `rundown-template-save:${f.content.id}`, value: "removed" }]);
  await removeSavedRundown(env.DB, f.orgId, f.content.id, f.actor);
  expect(await rows(f.orgId)).toHaveLength(1);
  expect(await rows(other.orgId)).toHaveLength(2);
});
it("save and delete races finish deleted and never rewrite an accepted receipt", async () => {
  const f = await fixture();
  await Promise.all([createSavedRundown(env.DB, f.orgId, f.content), removeSavedRundown(env.DB, f.orgId, f.content.id, f.actor)]);
  const before = await rows(f.orgId);
  expect(before).toHaveLength(1);
  expect(before[0].key).toBe(`rundown-template-save:${f.content.id}`);
  await expect(createSavedRundown(env.DB, f.orgId, f.content)).resolves.toEqual({ ok: false, reason: "removed" });
  await removeSavedRundown(env.DB, f.orgId, f.content.id, f.actor);
  expect(await rows(f.orgId)).toEqual(before);
});

it("round-trips create, list, point read and delete through the dedicated store", async () => {
  const f = await fixture();
  await expect(createSavedRundown(env.DB, f.orgId, f.content)).resolves.toEqual({ ok: true, id: f.content.id });
  const listed = (await env.DB.prepare("SELECT templateId,name,updatedAt,payload FROM rundown_template WHERE orgId=?").bind(f.orgId).all<{ templateId: string; name: string; updatedAt: string; payload: string }>()).results;
  expect(listed).toHaveLength(1);
  const stored = await env.DB.prepare("SELECT payload FROM rundown_template WHERE orgId=? AND templateId=?").bind(f.orgId, f.content.id).first<{ payload: string }>();
  expect(stored?.payload).toBe(listed[0].payload);
  expect(JSON.parse(stored!.payload)).toMatchObject(f.content);
  expect(listed[0].name).toBe(f.content.name);
  expect(listed[0].updatedAt).toBe(JSON.parse(stored!.payload).updatedAt);
  expect((await env.DB.prepare("SELECT key FROM app_setting WHERE orgId=? AND (key LIKE 'rundown-saved:%' OR key LIKE 'rundown-template-save:%')").bind(f.orgId).all()).results).toEqual([]);
  await removeSavedRundown(env.DB, f.orgId, f.content.id, f.actor);
  expect(await env.DB.prepare("SELECT payload FROM rundown_template WHERE orgId=? AND templateId=?").bind(f.orgId, f.content.id).first()).toBeNull();
  await expect(createSavedRundown(env.DB, f.orgId, f.content)).resolves.toEqual({ ok: false, reason: "removed" });
});
