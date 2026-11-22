import type { CueSheetWrite, CueSheetWriteResult } from "./cue-sheet-writes";

/** Claim and conditional mutation share one D1 transaction. A receipt survives
 * deletion, so late retries acknowledge the original outcome without rewriting.
 * Preconditions compare the value the operator actually edited, not wall time.
 */
export async function applyCueSheetWrite(db: Pick<D1Database, "prepare" | "batch">, input: CueSheetWrite, userName: string): Promise<CueSheetWriteResult> {
  const { orgId, requestId, operation: op } = input;
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(op))))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const key = `cue-sheet-write:${requestId}`;
  const token = crypto.randomUUID();
  const applied = JSON.stringify({ digest, token, outcome: "applied" });
  const conflict = JSON.stringify({ digest, token, outcome: "conflict" });
  const guard = "EXISTS (SELECT 1 FROM app_setting WHERE orgId = ? AND key = ? AND value = ?)";
  const claim = [orgId, key, applied];
  const now = new Date().toISOString();
  let condition: string;
  let conditions: (string | number)[];
  const mutations: D1PreparedStatement[] = [];
  if (op.kind === "note") {
    condition = `EXISTS (SELECT 1 FROM cue_column WHERE orgId = ? AND id = ?)
      AND EXISTS (SELECT 1 FROM rundown WHERE orgId = ? AND id = ? AND serviceDate = ?)
      AND COALESCE((SELECT text FROM cue_note WHERE orgId = ? AND showId = ? AND itemId = ? AND columnId = ?), '') = ?`;
    conditions = [orgId, op.columnId, orgId, op.showId, op.serviceDate, orgId, op.showId, op.itemId, op.columnId, op.expectedText];
    mutations.push(db.prepare(`INSERT INTO cue_note (id, orgId, showId, serviceDate, itemId, columnId, text, updatedAt, updatedBy)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard}
      ON CONFLICT (orgId, showId, itemId, columnId) DO UPDATE SET text = excluded.text, updatedAt = excluded.updatedAt, updatedBy = excluded.updatedBy`)
      .bind(crypto.randomUUID(), orgId, op.showId, op.serviceDate, op.itemId, op.columnId, op.text, now, userName, ...claim));
  } else if (op.kind === "add-column") {
    condition = "(SELECT COUNT(*) FROM cue_column WHERE orgId = ?) < 40 AND NOT EXISTS (SELECT 1 FROM cue_column WHERE id = ?)";
    conditions = [orgId, requestId];
    mutations.push(db.prepare(`INSERT INTO cue_column (id, orgId, label, color, sortOrder, width, createdAt, updatedAt)
      SELECT ?, ?, ?, ?, (SELECT COALESCE(MAX(sortOrder), -1) + 1 FROM cue_column WHERE orgId = ?), 220, ?, ? WHERE ${guard}`)
      .bind(requestId, orgId, op.label, op.color, orgId, now, now, ...claim));
  } else if (op.kind === "rename-column" || op.kind === "color-column" || op.kind === "resize-column") {
    const field = op.kind === "rename-column" ? "label" : op.kind === "color-column" ? "color" : "width";
    const value = op.kind === "rename-column" ? op.label : op.kind === "color-column" ? op.color : op.width;
    condition = `EXISTS (SELECT 1 FROM cue_column WHERE orgId = ? AND id = ? AND ${field} = ?)`;
    conditions = [orgId, op.id, op.before];
    mutations.push(db.prepare(`UPDATE cue_column SET ${field} = ?, updatedAt = ? WHERE orgId = ? AND id = ? AND ${guard}`).bind(value, now, orgId, op.id, ...claim));
  } else if (op.kind === "reorder-columns") {
    condition = "(SELECT json_group_array(id) FROM (SELECT id FROM cue_column WHERE orgId = ? ORDER BY sortOrder, createdAt, id)) = ?";
    conditions = [orgId, JSON.stringify(op.before)];
    for (const [index, id] of op.ids.entries()) mutations.push(db.prepare(`UPDATE cue_column SET sortOrder = ?, updatedAt = ? WHERE orgId = ? AND id = ? AND ${guard}`).bind(index, now, orgId, id, ...claim));
  } else if (op.kind === "delete-empty-column") {
    // The emptiness check, server-owned undo snapshot and deletion are atomic.
    // A cue arriving in any show wins the race rather than being silently deleted.
    condition = "EXISTS (SELECT 1 FROM cue_column WHERE orgId = ? AND id = ? AND label = ?) AND NOT EXISTS (SELECT 1 FROM cue_note WHERE orgId = ? AND columnId = ? AND LENGTH(TRIM(text)) > 0)";
    conditions = [orgId, op.id, op.label, orgId, op.id];
    mutations.push(db.prepare(`INSERT INTO app_setting (id, orgId, key, value)
      SELECT ?, ?, ?, json_object('id', id, 'label', label, 'color', color, 'sortOrder', sortOrder, 'width', width, 'createdAt', createdAt, 'deletedAt', ?)
      FROM cue_column WHERE orgId = ? AND id = ? AND ${guard}
      ON CONFLICT(orgId, key) DO NOTHING`)
      .bind(crypto.randomUUID(), orgId, `cue-sheet-undo:${requestId}`, Date.now(), orgId, op.id, ...claim));
    mutations.push(db.prepare(`DELETE FROM cue_note WHERE orgId = ? AND columnId = ? AND ${guard}`).bind(orgId, op.id, ...claim));
    mutations.push(db.prepare(`DELETE FROM cue_column WHERE orgId = ? AND id = ? AND ${guard}`).bind(orgId, op.id, ...claim));
  } else if (op.kind === "restore-column") {
    const undoKey = `cue-sheet-undo:${op.deletionRequestId}`;
    const restoredKey = `cue-sheet-restored:${op.deletionRequestId}`;
    condition = `EXISTS (SELECT 1 FROM app_setting u WHERE u.orgId = ? AND u.key = ? AND json_extract(u.value, '$.deletedAt') >= ?
      AND NOT EXISTS (SELECT 1 FROM cue_column WHERE id = json_extract(u.value, '$.id')))
      AND NOT EXISTS (SELECT 1 FROM app_setting WHERE orgId = ? AND key = ?)
      AND (SELECT COUNT(*) FROM cue_column WHERE orgId = ?) < 40`;
    conditions = [orgId, undoKey, Date.now() - 300_000, orgId, restoredKey, orgId];
    // Read the snapshot from our own receipt, never from client-supplied column data.
    mutations.push(db.prepare(`INSERT INTO cue_column (id, orgId, label, color, sortOrder, width, createdAt, updatedAt)
      SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.label'), json_extract(value, '$.color'), json_extract(value, '$.sortOrder'), json_extract(value, '$.width'), json_extract(value, '$.createdAt'), ?
      FROM app_setting WHERE orgId = ? AND key = ? AND ${guard}`)
      .bind(orgId, now, orgId, undoKey, ...claim));
    // A new Undo request cannot resurrect the column again after a later deletion.
    mutations.push(db.prepare(`INSERT INTO app_setting (id, orgId, key, value) SELECT ?, ?, ?, ? WHERE ${guard} ON CONFLICT(orgId, key) DO NOTHING`)
      .bind(crypto.randomUUID(), orgId, restoredKey, requestId, ...claim));
  } else if (op.kind === "delete-column") {
    condition = "EXISTS (SELECT 1 FROM cue_column WHERE orgId = ? AND id = ? AND label = ?)";
    conditions = [orgId, op.id, op.label];
    mutations.push(db.prepare(`DELETE FROM cue_note WHERE orgId = ? AND columnId = ? AND ${guard}`).bind(orgId, op.id, ...claim));
    mutations.push(db.prepare(`DELETE FROM cue_column WHERE orgId = ? AND id = ? AND ${guard}`).bind(orgId, op.id, ...claim));
  } else {
    const unexpected: never = op;
    throw new Error(`Unknown cue-sheet operation: ${String(unexpected)}`);
  }
  const receipt = db.prepare(`INSERT INTO app_setting (id, orgId, key, value)
    VALUES (?, ?, ?, CASE WHEN ${condition} THEN ? ELSE ? END) ON CONFLICT(orgId, key) DO NOTHING`)
    .bind(crypto.randomUUID(), orgId, key, ...conditions, applied, conflict);
  await db.batch([receipt, ...mutations]);
  const saved = await db.prepare("SELECT json_extract(value, '$.digest') AS digest, json_extract(value, '$.outcome') AS outcome FROM app_setting WHERE orgId = ? AND key = ?")
    .bind(orgId, key).first<{ digest: string; outcome: "applied" | "conflict" }>();
  if (!saved || saved.digest !== digest) throw new Error("This request was already used for a different cue-sheet change.");
  const currentText = op.kind === "note" ? (await db.prepare("SELECT text FROM cue_note WHERE orgId = ? AND showId = ? AND itemId = ? AND columnId = ?")
    .bind(orgId, op.showId, op.itemId, op.columnId).first<{ text: string }>())?.text ?? "" : null;
  if (op.kind === "delete-empty-column" && saved.outcome === "applied") {
    const snapshot = await db.prepare("SELECT json_extract(value, '$.deletedAt') AS deletedAt FROM app_setting WHERE orgId = ? AND key = ?")
      .bind(orgId, `cue-sheet-undo:${requestId}`).first<{ deletedAt: number }>();
    if (!snapshot || !Number.isFinite(snapshot.deletedAt)) throw new Error("The department's undo receipt is missing.");
    return { requestId, outcome: saved.outcome, currentText, undoExpiresAt: snapshot.deletedAt + 300_000 };
  }
  return { requestId, outcome: saved.outcome, currentText };
}
