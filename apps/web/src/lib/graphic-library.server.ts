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
    SELECT ?, ?, ?, ? WHERE ? != 'update' OR EXISTS (SELECT 1 FROM graphic_template WHERE orgId = ? AND id = ?)
    ON CONFLICT(orgId, key) DO NOTHING`).bind(crypto.randomUUID(), orgId, key, receipt, operation.kind, orgId, id);
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
  } else {
    mutation = db.prepare(`DELETE FROM graphic_template WHERE orgId = ? AND id = ? AND ${guard}`).bind(orgId, id, orgId, key, receipt);
  }
  await db.batch([insert, mutation]);
  const saved = await db.prepare("SELECT json_extract(value, '$.digest') AS digest, json_extract(value, '$.id') AS id FROM app_setting WHERE orgId = ? AND key = ?")
    .bind(orgId, key).first<{ digest: string; id: string }>();
  if (!saved) throw new Error("This graphic no longer exists. Refresh the library.");
  if (saved.digest !== digest) throw new Error("This request was already used for a different graphics change.");
  return { requestId, id: saved.id };
}
