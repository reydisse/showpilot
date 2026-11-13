/** Trusted SQL for the literal updatedAt column. It accepts both supported D1
 * date encodings, advances at least one millisecond, and does not repair invalid
 * stored values by silently replacing them with the current time. */
export const NEXT_UPDATED_AT_SQL = `strftime('%Y-%m-%dT%H:%M:%fZ', MAX(julianday('now'),
  (CASE WHEN typeof(updatedAt) IN ('integer','real')
    THEN julianday(updatedAt / 1000.0, 'unixepoch') ELSE julianday(updatedAt) END) + 1.0 / 86400000))`;

/** SQLite CURRENT_TIMESTAMP text is UTC even in a non-UTC process. */
export function sqliteTimestampMillis(value: string | number): number {
  const normalized =
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
      ? value.replace(" ", "T") + "Z"
      : value;
  return new Date(normalized).getTime();
}

export function sameStoredTimestamp(
  stored: string | number,
  expected: string,
): boolean {
  const left = sqliteTimestampMillis(stored),
    right = sqliteTimestampMillis(expected);
  return Number.isFinite(left) && Number.isFinite(right) && left === right;
}
