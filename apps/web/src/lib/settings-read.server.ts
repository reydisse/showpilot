import { ORG_SETTING_KEYS } from "./org-setting-keys";
const MEMBER_VISIBLE_SETTING_KEYS = [
  "org-timezone",
  "clock-format",
  "timezone-display",
  "default-timer-mode",
  "default-countdown-minutes",
  "default-call-lead-minutes",
  "overtime-behavior",
  "lyrics-output",
  "default-confidence-layout",
] as const;

interface SettingsResult<T> {
  results?: T[];
}

interface BoundSettingsStatement {
  all<T>(): Promise<SettingsResult<T>>;
}

interface SettingsStatement {
  bind(...values: unknown[]): BoundSettingsStatement;
}

export interface SettingsReadDatabase {
  prepare(sql: string): SettingsStatement;
}

interface SettingRow {
  key: string;
  value: string;
}

/** Reads only non-secret operational defaults for one organization. */
export async function readMemberVisibleOrgSettings(
  database: SettingsReadDatabase,
  orgId: string,
): Promise<Record<string, string>> {
  const rows = await readRoutedSettingRows(database, orgId, MEMBER_VISIBLE_SETTING_KEYS);
  return Object.fromEntries(rows.map(setting => [setting.key, setting.value]));
}

/** Preserve the requested key set while reading each key from its owner table. */
export async function readRoutedSettingRows(
  database: SettingsReadDatabase, orgId: string, keys: readonly string[],
): Promise<SettingRow[]> {
  const groups = [
    { table: "app_setting", keys: keys.filter(key => !ORG_SETTING_KEYS.has(key)) },
    { table: "org_setting", keys: keys.filter(key => ORG_SETTING_KEYS.has(key)) },
  ];
  const results = await Promise.all(groups.map(async group => {
    if (!group.keys.length) return [];
    const result = await database.prepare(
      `SELECT key, value FROM ${group.table} WHERE orgId = ? AND key IN (${group.keys.map(() => "?").join(", ")})`,
    ).bind(orgId, ...group.keys).all<SettingRow>();
    return result.results ?? [];
  }));
  return results.flat();
}
