import { getD1 } from "@/lib/d1";

interface RunResult {
  meta?: { changes?: number };
}

interface ChecklistToggleDatabase {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      run(): Promise<RunResult>;
      first<T>(): Promise<T | null>;
    };
  };
}

export class ChecklistRevisionConflictError extends Error {
  constructor() {
    super("This checklist item changed on another device. Refresh and try again.");
    this.name = "ChecklistRevisionConflictError";
  }
}

export async function setChecklistEntryCategory({
  orgId,
  entryId,
  category,
  database = getD1(),
}: {
  orgId: string;
  entryId: string;
  category: string;
  database?: ChecklistToggleDatabase;
}) {
  const result = await database.prepare(
    "UPDATE checklist_entry SET category = ? WHERE id = ? AND orgId = ?",
  ).bind(category, entryId, orgId).run();
  if ((result.meta?.changes ?? 0) === 0) throw new Error("Checklist item not found.");
  return { ok: true as const };
}

export async function transitionChecklistEntry({
  orgId,
  entryId,
  checked,
  expectedRevision,
  actorName,
  database = getD1(),
  now = new Date(),
}: {
  orgId: string;
  entryId: string;
  checked: boolean;
  expectedRevision: number;
  actorName: string;
  database?: ChecklistToggleDatabase;
  now?: Date;
}) {
  const desired = checked ? 1 : 0;
  const result = await database.prepare(
    `UPDATE checklist_entry
     SET checked = ?,
         checkedBy = CASE WHEN checked = ? THEN checkedBy ELSE ? END,
         checkedAt = CASE WHEN checked = ? THEN checkedAt ELSE ? END,
         revision = CASE WHEN checked = ? THEN revision ELSE revision + 1 END
     WHERE id = ? AND orgId = ? AND (revision = ? OR checked = ?)`,
  ).bind(
    desired,
    desired,
    checked ? actorName : null,
    desired,
    checked ? now.toISOString() : null,
    desired,
    entryId,
    orgId,
    expectedRevision,
    desired,
  ).run();

  if ((result.meta?.changes ?? 0) === 0) {
    const existing = await database.prepare(
      "SELECT id FROM checklist_entry WHERE id = ? AND orgId = ? LIMIT 1",
    ).bind(entryId, orgId).first<{ id: string }>();
    if (!existing) throw new Error("Checklist item not found.");
    throw new ChecklistRevisionConflictError();
  }

  const row = await database.prepare(
    "SELECT checked, checkedBy, checkedAt, revision FROM checklist_entry WHERE id = ? AND orgId = ? LIMIT 1",
  ).bind(entryId, orgId).first<{
    checked: number | boolean;
    checkedBy: string | null;
    checkedAt: string | null;
    revision: number;
  }>();
  if (!row) throw new Error("Checklist item not found.");
  return { ...row, checked: Boolean(row.checked) };
}
