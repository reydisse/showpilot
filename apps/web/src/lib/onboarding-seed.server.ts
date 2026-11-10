import { buildTemplateRundownItems, type OnboardingTemplate } from "./templates";
import { ONBOARDING_SEED_KEY, onboardingSeedMarkerSchema, type OnboardingSeedInput, type OnboardingSeedSnapshot } from "./onboarding-seed-contract";
import { readStoredRundownItems, rundownItemStorageKey, type RundownDatabase } from "./rundown-item-storage.server";
import { defaultCueColumnSeedStatements } from "./cue-column-seed";

const showIdFor = (orgId: string) => `${orgId}:onboarding:show`;
function existingSetupRows(orgId: string) {
  return { sql: `EXISTS (SELECT 1 FROM rundown WHERE orgId = ? AND id = ?)
    OR EXISTS (SELECT 1 FROM checklist_template WHERE orgId = ? AND substr(id, 1, length(?)) = ?)`,
    values: [orgId, showIdFor(orgId), orgId, `${orgId}:onboarding:checklist:`, `${orgId}:onboarding:checklist:`] };
}
export async function readOnboardingSeed(db: RundownDatabase, orgId: string): Promise<OnboardingSeedSnapshot> {
  const existing = existingSetupRows(orgId);
  // Read the receipt and legacy-data test in one snapshot, so a concurrent commit
  // cannot be mistaken for an old partial seed between two queries.
  const row = await db.prepare(`SELECT (SELECT value FROM app_setting WHERE orgId = ? AND key = ?) AS value,
    (${existing.sql}) AS hasExisting`).bind(orgId, ONBOARDING_SEED_KEY, ...existing.values).first<{ value: string | null; hasExisting: number }>();
  if (!row) throw new Error("Could not read setup result.");
  if (row.value === null) return row.hasExisting
    ? { status: "review", message: "An earlier setup left existing rundown or checklist data. Review it in your workspace; setup will not replace it." }
    : { status: "empty" };
  let parsed: unknown;
  try { parsed = JSON.parse(row.value); } catch { parsed = null; }
  const marker = onboardingSeedMarkerSchema.safeParse(parsed);
  if (!marker.success) return { status: "review", message: "The saved setup result could not be read. Review your rundown in the workspace; setup will not replace existing data." };
  const showId = showIdFor(orgId);
  const show = await db.prepare("SELECT serviceDate FROM rundown WHERE orgId = ? AND id = ?").bind(orgId, showId).first<{ serviceDate: string }>();
  if (marker.data.template !== "blank" && (!show || show.serviceDate !== marker.data.serviceDate)) {
    return { status: "review", message: "The original setup rundown was removed or changed. Review your workspace; setup will not recreate it." };
  }
  return { status: "saved", ...marker.data, showId: show ? showId : null,
    items: show ? await readStoredRundownItems(db, { orgId, showId, serviceDate: show.serviceDate }) : [] };
}

/** One transaction chooses a winner and creates every row. Replays never update existing show data. */
export async function commitOnboardingSeed(db: RundownDatabase, input: OnboardingSeedInput, template: OnboardingTemplate): Promise<OnboardingSeedSnapshot> {
  const { orgId, serviceDate } = input;
  const showId = showIdFor(orgId);
  const now = new Date().toISOString();
  const value = JSON.stringify({ template: template.id, serviceDate, attemptId: crypto.randomUUID() });
  const guard = { sql: "EXISTS (SELECT 1 FROM app_setting WHERE orgId = ? AND key = ? AND value = ?)", values: [orgId, ONBOARDING_SEED_KEY, value] };
  const insert = (sql: string, values: (string | number)[]) => db.prepare(`${sql} WHERE ${guard.sql}`).bind(...values, ...guard.values);
  // A legacy partial seed must be reviewed, never silently filled with another template.
  // An explicit blank choice records that setup should continue without adding anything.
  const existing = existingSetupRows(orgId);
  const legacyGuard = template.id === "blank" ? "" : `AND NOT (${existing.sql})`;
  const statements = [db.prepare(`INSERT INTO app_setting (id, orgId, key, value) SELECT ?, ?, ?, ? WHERE 1 ${legacyGuard}
    ON CONFLICT(orgId, key) DO NOTHING`).bind(crypto.randomUUID(), orgId, ONBOARDING_SEED_KEY, value,
      ...(template.id === "blank" ? [] : existing.values))];
  const items = buildTemplateRundownItems(template).map((item, index) => ({ ...item, id: `${orgId}:onboarding:item:${index}` }));
  if (items.length) {
    statements.push(insert("INSERT INTO rundown (id, orgId, serviceDate, name, status, createdAt, updatedAt) SELECT ?, ?, ?, ?, 'stopped', ?, ?", [showId, orgId, serviceDate, template.name, now, now]));
    for (const item of items) statements.push(insert(`INSERT INTO rundown_item
      (id, orgId, showId, serviceDate, itemId, title, type, duration, notes, assignee, cue, status, sortOrder, hardStop, createdAt, updatedAt)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, '', '', '', 'upcoming', ?, 0, ?, ?`,
      [crypto.randomUUID(), orgId, showId, serviceDate, item.id, item.title, item.type, item.duration, item.sortOrder, now, now]));
    statements.push(insert("INSERT INTO app_setting (id, orgId, key, value) SELECT ?, ?, ?, 'rows-v1'", [crypto.randomUUID(), orgId, rundownItemStorageKey(showId)]));
  }
  for (const [index, row] of template.checklist.entries()) statements.push(insert(
    "INSERT INTO checklist_template (id, orgId, label, category, sortOrder) SELECT ?, ?, ?, ?, ?",
    [`${orgId}:onboarding:checklist:${index}`, orgId, row.label, row.category, index]));
  if (template.cueRows.length) {
    statements.push(...defaultCueColumnSeedStatements(db, orgId, now, guard));
    for (const row of template.cueRows) {
      const item = items.find(item => item.title === row.rundownItem);
      if (!item) throw new Error("Template cue has no rundown item.");
      for (const [label, text] of [["Production", row.cameraAssignments], ["Show Caller", row.notes]]) {
        if (!text.trim()) continue;
        statements.push(db.prepare(`INSERT INTO cue_note (id, orgId, showId, serviceDate, itemId, columnId, text, updatedAt, updatedBy)
          SELECT ?, ?, ?, ?, ?, id, ?, ?, 'Onboarding template' FROM cue_column
          WHERE orgId = ? AND label = ? AND ${guard.sql} ORDER BY sortOrder, id LIMIT 1`)
          .bind(crypto.randomUUID(), orgId, showId, serviceDate, item.id, text.trim(), now, orgId, label, ...guard.values));
      }
    }
  }
  await db.batch(statements);
  return readOnboardingSeed(db, orgId);
}
