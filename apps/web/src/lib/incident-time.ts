/** SQLite CURRENT_TIMESTAMP is UTC but omits the offset. Preserve explicit
 * offsets on newer records, and never interpret legacy records as local time. */
export function parseIncidentTimestamp(value: string): Date {
  return new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value);
}
