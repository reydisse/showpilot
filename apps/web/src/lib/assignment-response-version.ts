export interface AssignmentResponseDetails {
  showId: string | null;
  serviceDate: string;
  role: string;
  callTime: string;
  scheduledStartTime: string | null;
}

/**
 * Identifies the exact duties shown to an assignee. The value is intentionally
 * opaque to clients; they echo it when responding so the server can reject a
 * response after any material scheduling detail changes.
 */
export function assignmentResponseVersion(details: AssignmentResponseDetails) {
  return JSON.stringify([
    details.showId ?? "",
    details.serviceDate,
    details.role,
    details.callTime,
    details.scheduledStartTime ?? "",
  ]);
}
