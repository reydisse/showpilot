export const DEFAULT_CUE_COLUMNS = [
  { label: "Show Caller", color: "red" },
  { label: "Production", color: "amber" },
  { label: "Pro Ops", color: "green" },
  { label: "LX", color: "blue" },
  { label: "Sound", color: "purple" },
] as const;

const MARKER_KEY = "cue-sheet-default-columns";
const VERSION = "1";

export async function seedDefaultCueColumnsOnce(
  db: Pick<D1Database, "prepare" | "batch">,
  orgId: string,
  now: string,
) {
  await db.batch(defaultCueColumnSeedStatements(db, orgId, now));
}

export function defaultCueColumnSeedStatements(
  db: Pick<D1Database, "prepare">, orgId: string, now: string,
  guard: { sql: string; values: (string | number)[] } = { sql: "1", values: [] },
) {
  return [
    ...DEFAULT_CUE_COLUMNS.map((column, index) => db.prepare(
      `INSERT INTO cue_column (id, orgId, label, color, sortOrder, width, createdAt, updatedAt)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       WHERE (${guard.sql}) AND NOT EXISTS (
         SELECT 1 FROM app_setting WHERE orgId = ? AND key = ?
       )
       ON CONFLICT(id) DO NOTHING`,
    ).bind(
      `${orgId}-cue-default-${index}`,
      orgId,
      column.label,
      column.color,
      index,
      160,
      now,
      now,
      ...guard.values,
      orgId,
      MARKER_KEY,
    )),
    db.prepare(
      `INSERT INTO app_setting (id, orgId, key, value)
       SELECT ?, ?, ?, ? WHERE ${guard.sql}
       ON CONFLICT(orgId, key) DO NOTHING`,
    ).bind(`${orgId}-cue-columns-marker`, orgId, MARKER_KEY, VERSION, ...guard.values),
  ];
}

export async function markDefaultCueColumnsInitialized(
  db: Pick<D1Database, "prepare">,
  orgId: string,
) {
  await db.prepare(
    `INSERT INTO app_setting (id, orgId, key, value)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(orgId, key) DO NOTHING`,
  ).bind(`${orgId}-cue-columns-marker`, orgId, MARKER_KEY, VERSION).run();
}
