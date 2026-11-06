import type { RundownItem } from "@/types/rundown";

export type RundownStatement = D1PreparedStatement;
export type RundownDatabase = Pick<D1Database, "prepare" | "batch">;
export type RundownItemScope = { orgId: string; serviceDate: string; showId?: string };
export const rundownItemStorageKey = (identity: string) => `rundown-items-storage:${identity}`;

function scopePredicate(scope: RundownItemScope) {
  return scope.showId
    ? { sql: "orgId = ? AND showId = ?", values: [scope.orgId, scope.showId] }
    : { sql: "orgId = ? AND showId IS NULL AND serviceDate = ?", values: [scope.orgId, scope.serviceDate] };
}

function itemValues(item: RundownItem, index: number) {
  return [item.title, item.type, item.duration, item.notes, item.assignee, item.cue, item.status, index,
    item.hardStop, item.lowerThirdId ?? null, item.scheduledStart ?? null, item.expectedEnd ?? null,
    item.actualStart ?? null, item.actualEnd ?? null];
}
export function samePersistedRundownItem(a: RundownItem, b: RundownItem): boolean {
  const values = itemValues(b, b.sortOrder);
  return itemValues(a, a.sortOrder).every((value, index) => value === values[index]);
}

function timestamp(value: string | number | null): string | null {
  if (value === null) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : value.toString();
}

/** Read the actual rows before a seed/import; live relay edits already have a baseline. */
export async function readStoredRundownItems(db: RundownDatabase, scope: RundownItemScope): Promise<RundownItem[]> {
  const where = scopePredicate(scope);
  const { results } = await db.prepare(`SELECT itemId AS id, title, type, duration, notes, assignee, cue, status,
    sortOrder, hardStop, lowerThirdId, scheduledStart, expectedEnd, actualStart, actualEnd
    FROM rundown_item WHERE ${where.sql} ORDER BY sortOrder`).bind(...where.values).all<
      Omit<RundownItem, "hardStop" | "lowerThirdId" | "scheduledStart" | "expectedEnd" | "actualStart" | "actualEnd"> & {
        hardStop: number; lowerThirdId: string | null;
        scheduledStart: string | number | null; expectedEnd: string | number | null;
        actualStart: string | number | null; actualEnd: string | number | null;
      }
    >();
  return results.map(row => ({ ...row, hardStop: Boolean(row.hardStop), lowerThirdId: row.lowerThirdId ?? undefined,
    scheduledStart: timestamp(row.scheduledStart), expectedEnd: timestamp(row.expectedEnd),
    actualStart: timestamp(row.actualStart), actualEnd: timestamp(row.actualEnd) }));
}

/** One statement per changed row. Callers commit these with their metadata in one D1 batch. */
export function rundownItemDiffStatements(
  db: RundownDatabase, scope: RundownItemScope, before: readonly RundownItem[], after: readonly RundownItem[],
): RundownStatement[] {
  const where = scopePredicate(scope);
  const old = new Map(before.map(item => [item.id, item]));
  const retained = new Set(after.map(item => item.id));
  const statements: RundownStatement[] = [];
  for (const item of before) {
    if (!retained.has(item.id)) statements.push(db.prepare(`DELETE FROM rundown_item WHERE ${where.sql} AND itemId = ?`).bind(...where.values, item.id));
  }
  after.forEach((item, index) => {
    const previous = old.get(item.id);
    if (previous && samePersistedRundownItem(previous, { ...item, sortOrder: index })) return;
    const values = itemValues(item, index);
    statements.push(previous
      ? db.prepare(`UPDATE rundown_item SET title = ?, type = ?, duration = ?, notes = ?, assignee = ?, cue = ?, status = ?, sortOrder = ?,
          hardStop = ?, lowerThirdId = ?, scheduledStart = ?, expectedEnd = ?, actualStart = ?, actualEnd = ?,
          updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE ${where.sql} AND itemId = ?`).bind(...values, ...where.values, item.id)
      : insertItem(db, scope, item, index));
  });
  return statements;
}

function insertItem(db: RundownDatabase, scope: RundownItemScope, item: RundownItem, index: number, legacy = false) {
  const values = [crypto.randomUUID(), scope.orgId, scope.showId ?? null, scope.serviceDate, item.id, ...itemValues(item, index)];
  // Migration must not overwrite or append to a concurrently saved/cleared show.
  const guard = legacy ? " WHERE NOT EXISTS (SELECT 1 FROM app_setting WHERE orgId = ? AND key = ?) ON CONFLICT(orgId, showId, itemId) DO NOTHING" : "";
  return db.prepare(`INSERT INTO rundown_item (id, orgId, showId, serviceDate, itemId, title, type, duration, notes, assignee, cue, status, sortOrder,
    hardStop, lowerThirdId, scheduledStart, expectedEnd, actualStart, actualEnd, createdAt, updatedAt)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP${guard}`)
    .bind(...values, ...(legacy ? [scope.orgId, rundownItemStorageKey(scope.showId ?? scope.serviceDate)] : []));
}

/** The small marker distinguishes an intentionally empty table from unmigrated legacy JSON. */
export function rundownItemStorageStatements(db: RundownDatabase, scope: RundownItemScope): RundownStatement[] {
  const identity = scope.showId ?? scope.serviceDate;
  return [
    db.prepare("INSERT INTO app_setting (id, orgId, key, value) VALUES (?, ?, ?, 'rows-v1') ON CONFLICT(orgId, key) DO UPDATE SET value = excluded.value")
      .bind(crypto.randomUUID(), scope.orgId, rundownItemStorageKey(identity)),
    db.prepare("DELETE FROM app_setting WHERE orgId = ? AND key = ?").bind(scope.orgId, `rundown-items:${identity}`),
    ...(scope.showId ? [db.prepare(`DELETE FROM app_setting WHERE orgId = ? AND key = ? AND ? =
      (SELECT id FROM rundown WHERE orgId = ? AND serviceDate = ? ORDER BY scheduledStartTime ASC, createdAt ASC LIMIT 1)`)
      .bind(scope.orgId, `rundown-items:${scope.serviceDate}`, scope.showId, scope.orgId, scope.serviceDate)] : []),
  ];
}

export async function migrateRundownItemSnapshot(db: RundownDatabase, scope: RundownItemScope, items: RundownItem[]): Promise<void> {
  await db.batch([...items.map((item, index) => insertItem(db, scope, item, index, true)), ...rundownItemStorageStatements(db, scope)]);
}
