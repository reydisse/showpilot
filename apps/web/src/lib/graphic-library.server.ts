import type { GraphicLibraryOperation } from "./graphics";

interface LibraryRequest { orgId: string; requestId: string; operation: GraphicLibraryOperation }

/** A receipt and its mutation commit together. Replays acknowledge, never mutate again. */
export async function applyGraphicLibraryOperation(db: Pick<D1Database, "prepare" | "batch">, input: LibraryRequest) {
  const { orgId, requestId, operation } = input;
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(operation))))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
  const id = operation.kind === "create" ? requestId : operation.id;
  const key = `graphic-library:${requestId}`;
  const token = crypto.randomUUID();
  const receipt = JSON.stringify({ digest, id, token });
  const insert = db.prepare(`INSERT INTO app_setting (id, orgId, key, value)
    SELECT ?, ?, ?, ? WHERE ? NOT IN ('update', 'update-scene')
      OR (? = 'update' AND EXISTS (SELECT 1 FROM graphic_template WHERE orgId = ? AND id = ?))
      OR (? = 'update-scene' AND EXISTS (SELECT 1 FROM app_setting WHERE orgId = ? AND key = ?))
    ON CONFLICT(orgId, key) DO NOTHING`).bind(crypto.randomUUID(), orgId, key, receipt,
      operation.kind, operation.kind, orgId, id, operation.kind, orgId, `graphic-scene:${id}`);
  const guard = "EXISTS (SELECT 1 FROM app_setting WHERE orgId = ? AND key = ? AND value = ?)";
  const now = new Date().toISOString();
  let mutation: D1PreparedStatement;
  if (operation.kind === "create") {
    const content = operation.content;
    mutation = db.prepare(`INSERT INTO graphic_template (id, orgId, name, title, subtitle, style, createdAt, updatedAt)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard}`)
      .bind(id, orgId, content.name, content.title, content.subtitle, content.style, now, now, orgId, key, receipt);
  } else if (operation.kind === "update") {
    const content = operation.content;
    mutation = db.prepare(`UPDATE graphic_template SET name = ?, title = ?, subtitle = ?, style = ?, updatedAt = ?
      WHERE orgId = ? AND id = ? AND ${guard}`)
      .bind(content.name, content.title, content.subtitle, content.style, now, orgId, id, orgId, key, receipt);
  } else if (operation.kind === "delete") {
    mutation = db.prepare(`DELETE FROM graphic_template WHERE orgId = ? AND id = ? AND ${guard}`).bind(orgId, id, orgId, key, receipt);
  } else if (operation.kind === "create-scene" || operation.kind === "update-scene") {
    const scene = JSON.stringify({ id, name: operation.name, items: operation.items, createdAt: now, updatedAt: now });
    mutation = operation.kind === "create-scene"
      ? db.prepare(`INSERT INTO app_setting (id, orgId, key, value)
          SELECT ?, ?, ?, ? WHERE ${guard}`).bind(crypto.randomUUID(), orgId, `graphic-scene:${id}`, scene, orgId, key, receipt)
      : db.prepare(`UPDATE app_setting SET value = json_set(?, '$.createdAt',
          COALESCE(CASE WHEN json_valid(value) THEN json_extract(value, '$.createdAt') END, ?))
          WHERE orgId = ? AND key = ? AND ${guard}`).bind(scene, now, orgId, `graphic-scene:${id}`, orgId, key, receipt);
  } else if (operation.kind === "delete-scene") {
    mutation = db.prepare(`DELETE FROM app_setting WHERE orgId = ? AND key = ? AND ${guard}`)
      .bind(orgId, `graphic-scene:${id}`, orgId, key, receipt);
  } else {
    const unknownOperation: never = operation;
    throw new Error(`Unsupported graphics operation: ${String(unknownOperation)}`);
  }
  await db.batch([insert, mutation]);
  const saved = await db.prepare("SELECT json_extract(value, '$.digest') AS digest, json_extract(value, '$.id') AS id FROM app_setting WHERE orgId = ? AND key = ?")
    .bind(orgId, key).first<{ digest: string; id: string }>();
  if (!saved) throw new Error("This library item no longer exists. Refresh the library.");
  if (saved.digest !== digest) throw new Error("This request was already used for a different graphics change.");
  return { requestId, id: saved.id };
}
