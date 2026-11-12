export interface AssignmentResponseDetails {
  showId: string | null;
  serviceDate: string;
  role: string;
  callTime: string;
  effectiveCallTime: string | number | null;
  scheduledStartTime: string | number | null;
}

/**
 * Identifies the exact duties shown to an assignee. The value is intentionally
 * opaque to clients; they echo it when responding so the server can reject a
 * response after any material scheduling detail changes.
 */
function versionTime(value: string | number | null) {
  if (value === null || value === "") return "";
  const normalized =
    typeof value === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:/.test(value)
      ? value.replace(" ", "T") + "Z"
      : value;
  const date = new Date(normalized);
  // Invalid source text still changes the token; it must not equal an empty or
  // valid timestamp. D1 numeric and SQL text instants use the same token as ISO.
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
}
export function assignmentResponseVersion(details: AssignmentResponseDetails) {
  return JSON.stringify([
    details.showId ?? "",
    details.serviceDate,
    details.role,
    details.callTime,
    versionTime(details.effectiveCallTime),
    versionTime(details.scheduledStartTime),
  ]);
}
