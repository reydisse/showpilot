const MEMBER_VISIBLE_SETTING_KEYS = [
  "org-timezone",
  "clock-format",
  "timezone-display",
  "default-timer-mode",
  "default-countdown-minutes",
  "overtime-behavior",
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
  const placeholders = MEMBER_VISIBLE_SETTING_KEYS.map(() => "?").join(", ");
  const settings = await database
    .prepare(
      `SELECT key, value
         FROM app_setting
        WHERE orgId = ? AND key IN (${placeholders})`,
    )
    .bind(orgId, ...MEMBER_VISIBLE_SETTING_KEYS)
    .all<SettingRow>();
  return Object.fromEntries(
    (settings.results ?? []).map((setting) => [setting.key, setting.value]),
  );
}
