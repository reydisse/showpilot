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
