import { getD1 } from "@/lib/d1";
import type { ChecklistTemplateWrite } from "@/lib/checklist-core";

export interface ChecklistItemWrite {
  orgId: string;
  showId: string;
  serviceDate: string;
  template: ChecklistTemplateWrite;
}

/**
 * Persist one logical checklist item. Cloudflare D1 batch is a real SQL
 * transaction, unlike Prisma's D1 $transaction implementation. A failed entry
 * insert therefore cannot strand a newly-created template.
 */
export async function persistChecklistItem({
  orgId,
  showId,
  serviceDate,
  template,
}: ChecklistItemWrite) {
  const database = getD1();
  const entryId = crypto.randomUUID();
  const entryStatement = database
    .prepare(
      `INSERT OR IGNORE INTO "checklist_entry"
        ("id", "orgId", "templateId", "showId", "serviceDate", "checked")
       VALUES (?, ?, ?, ?, ?, 0)`,
    )
    .bind(entryId, orgId, template.id, showId, serviceDate);

  if (template.kind === "existing") {
    const result = await entryStatement.run();
    return { added: result.meta.changes > 0, entryId, templateId: template.id };
  }

  const results = await database.batch([
    database
      .prepare(
        `INSERT OR IGNORE INTO "checklist_template"
          ("id", "orgId", "label", "category", "sortOrder")
         VALUES (?, ?, ?, ?, 0)`,
      )
      .bind(template.id, orgId, template.label, template.category),
    entryStatement,
  ]);

  return {
    added: results[1].meta.changes > 0,
    entryId,
    templateId: template.id,
  };
}
