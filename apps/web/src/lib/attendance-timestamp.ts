/** D1 attendance rows may predate the ISO-only write contract. */
export function attendanceTimestamp(value: string | number | Date | null): string | null {
  if (value === null || value === "") return null;
  let input = value;
  if (typeof input === "string") {
    // SQLite CURRENT_TIMESTAMP is UTC, even though its text omits the zone.
    if (/^-?\d+(?:\.\d+)?$/.test(input)) input = Number(input);
    else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(input)) input = input.replace(" ", "T") + "Z";
  }
  const date = input instanceof Date ? input : new Date(input);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
