export function formatServiceTime(value: string | null, timeZone: string): string {
  if (!value) return "Time not set";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Time not set";
  try {
    return date.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
      timeZone,
    });
  } catch {
    return "Time unavailable";
  }
}

export function isServiceDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

export function getServiceDateForTimeZone(
  timeZone: string,
  now: Date = new Date(),
): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const values = new Map(parts.map((part) => [part.type, part.value]));
    const year = values.get("year");
    const month = values.get("month");
    const day = values.get("day");
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch {
    // A bad organization timezone must not block show creation.
  }
  return now.toISOString().slice(0, 10);
}
