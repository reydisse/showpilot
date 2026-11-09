import { createChecklistTemplateId, findChecklistTemplateId } from "./checklist-core";
import type { DepartmentKey } from "./departments";
import type { ChecklistWrite, ChecklistWriteResult } from "./checklist-writes";

type DraftItem = { id: string; label: string; category: DepartmentKey };

/** The claim and every entry/template change commit together. Receipts survive
 * entry deletion, so retrying an acknowledged add never recreates removed checks.
 */
export async function applyChecklistWrite(
  db: Pick<D1Database, "prepare" | "batch">,
  input: ChecklistWrite,
  actorName: string,
  resolveDraft: () => Promise<DraftItem[]>,
): Promise<ChecklistWriteResult> {
  const { orgId, showId, serviceDate, requestId, operation: op } = input;
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ showId, serviceDate, operation: op }))))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const key = `checklist-write:${requestId}`;
  const readReceipt = async (): Promise<ChecklistWriteResult | null> => {
    const saved = await db.prepare("SELECT json_extract(value, '$.digest') AS digest, json_extract(value, '$.outcome') AS outcome FROM app_setting WHERE orgId = ? AND key = ?")
      .bind(orgId, key).first<{ digest: string; outcome: string }>();
    if (!saved) return null;
    if (saved.digest !== digest) throw new Error("This request was already used for a different checklist change.");
    if (saved.outcome !== "applied" && saved.outcome !== "conflict") throw new Error("Invalid checklist acknowledgement.");
    return { requestId, outcome: saved.outcome };
  };
  const existing = await readReceipt();
  if (existing) return existing;
  const token = crypto.randomUUID();
  const applied = JSON.stringify({ digest, token, outcome: "applied" });
  const conflict = JSON.stringify({ digest, token, outcome: "conflict" });
  const guard = "EXISTS (SELECT 1 FROM app_setting WHERE orgId = ? AND key = ? AND value = ?)";
  const claim = [orgId, key, applied];
  let condition = "EXISTS (SELECT 1 FROM rundown WHERE orgId = ? AND id = ? AND serviceDate = ?)";
  const conditions: (string | number)[] = [orgId, showId, serviceDate];
  const mutations: D1PreparedStatement[] = [];
  if (op.kind === "add" || op.kind === "draft") {
    const items = op.kind === "add" ? [op] : (await resolveDraft()).filter(item => op.suggestionIds.includes(item.id));
    const templates = (await db.prepare("SELECT id, label FROM checklist_template WHERE orgId = ? ORDER BY sortOrder, createdAt, id").bind(orgId).all<{ id: string; label: string }>()).results;
    for (const item of items) {
      const templateId = findChecklistTemplateId(templates, item.label) ?? await createChecklistTemplateId(orgId, item.label);
      condition += " AND NOT EXISTS (SELECT 1 FROM checklist_template WHERE id = ? AND orgId <> ?)";
      conditions.push(templateId, orgId);
      mutations.push(db.prepare(`INSERT OR IGNORE INTO checklist_template (id, orgId, label, category, sortOrder)
        SELECT ?, ?, ?, ?, 0 WHERE ${guard}`).bind(templateId, orgId, item.label, item.category, ...claim));
      mutations.push(db.prepare(`INSERT OR IGNORE INTO checklist_entry (id, orgId, templateId, showId, serviceDate, category, checked, revision)
        SELECT ?, ?, ?, ?, ?, ?, 0, 0 WHERE ${guard}`).bind(crypto.randomUUID(), orgId, templateId, showId, serviceDate, item.category, ...claim));
    }
  } else {
    condition += " AND EXISTS (SELECT 1 FROM checklist_entry WHERE orgId = ? AND showId = ? AND id = ? AND revision = ? AND category = ?)";
    conditions.push(orgId, showId, op.id, op.expectedRevision, op.expectedCategory);
    const where = `orgId = ? AND showId = ? AND id = ? AND ${guard}`;
    const target = [orgId, showId, op.id, ...claim];
    switch (op.kind) {
      case "toggle":
        mutations.push(db.prepare(`UPDATE checklist_entry SET checked = ?, checkedBy = ?, checkedAt = ?, revision = revision + 1 WHERE ${where}`)
          .bind(op.checked ? 1 : 0, op.checked ? actorName : null, op.checked ? new Date().toISOString() : null, ...target));
        break;
      case "category":
        mutations.push(db.prepare(`UPDATE checklist_entry SET category = ?, revision = revision + 1 WHERE ${where}`).bind(op.category, ...target));
        break;
      case "delete":
        mutations.push(db.prepare(`DELETE FROM checklist_entry WHERE ${where}`).bind(...target));
        break;
      default: { const unexpected: never = op; throw new Error(`Unknown checklist change: ${String(unexpected)}`); }
    }
  }
  const receipt = db.prepare(`INSERT INTO app_setting (id, orgId, key, value)
    VALUES (?, ?, ?, CASE WHEN ${condition} THEN ? ELSE ? END) ON CONFLICT(orgId, key) DO NOTHING`)
    .bind(crypto.randomUUID(), orgId, key, ...conditions, applied, conflict);
  await db.batch([receipt, ...mutations]);
  const saved = await readReceipt();
  if (!saved) throw new Error("Missing checklist acknowledgement.");
  return saved;
}
