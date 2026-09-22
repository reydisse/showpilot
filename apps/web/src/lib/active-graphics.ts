const ACTIVE_KEY = "active-graphics";
const LEGACY_KEY = "active-graphic";

export async function setGraphicPresenceForOrg(
  db: Pick<D1Database, "prepare" | "batch">,
  orgId: string,
  graphicId: string,
  active: boolean,
): Promise<string[]> {
  const mutation = active
    ? db.prepare(
        `INSERT INTO app_setting (id, orgId, key, value)
         VALUES (?, ?, ?, json_array(?))
         ON CONFLICT(orgId, key) DO UPDATE SET value =
           CASE
             WHEN json_valid(app_setting.value)
              AND EXISTS (SELECT 1 FROM json_each(app_setting.value) WHERE value = ?)
               THEN app_setting.value
             ELSE json_insert(CASE WHEN json_valid(app_setting.value) THEN app_setting.value ELSE '[]' END, '$[#]', ?)
           END`,
      ).bind(crypto.randomUUID(), orgId, ACTIVE_KEY, graphicId, graphicId, graphicId)
    : db.prepare(
        `UPDATE app_setting
         SET value = COALESCE(
           (SELECT json_group_array(value) FROM json_each(
             CASE WHEN json_valid(app_setting.value) THEN app_setting.value ELSE '[]' END
           ) WHERE value <> ?),
           '[]'
         )
         WHERE orgId = ? AND key = ?`,
      ).bind(graphicId, orgId, ACTIVE_KEY);

  await db.batch([
    db.prepare("DELETE FROM app_setting WHERE orgId = ? AND key = ?").bind(orgId, LEGACY_KEY),
    mutation,
  ]);
  const row = await db.prepare(
    "SELECT value FROM app_setting WHERE orgId = ? AND key = ? LIMIT 1",
  ).bind(orgId, ACTIVE_KEY).first<{ value: string }>();
  try {
    const parsed: unknown = JSON.parse(row?.value ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}
