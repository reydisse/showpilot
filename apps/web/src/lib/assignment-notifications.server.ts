import { getD1 } from "@/lib/d1";

type AssignmentNotificationInput = {
  orgId: string;
  assignmentId: string;
  crewEmail: string;
  serviceName: string;
  serviceDate: string;
  role: string;
  start: string;
  reminder?: boolean;
};

export async function clearAssignmentInvitation(orgId: string, assignmentId: string) {
  await getD1()
    .prepare(
      "DELETE FROM notification WHERE orgId = ? AND source = ? AND type = 'assignment'",
    )
    .bind(orgId, assignmentId)
    .run();
}

/**
 * Delivers a schedule invitation to the matching signed-in organization user.
 * Crew records intentionally remain usable without app accounts, so email is
 * the tenant-safe join key shared by the schedule and authenticated identity.
 */
export async function notifyAssignmentRecipient(
  input: AssignmentNotificationInput,
) {
  const email = input.crewEmail.trim().toLowerCase();
  if (!email) return { notified: false };

  const db = getD1();
  const recipient = await db
    .prepare(
      `SELECT m.userId
       FROM member m
       JOIN user u ON u.id = m.userId
       WHERE m.organizationId = ? AND LOWER(u.email) = ?
       LIMIT 1`,
    )
    .bind(input.orgId, email)
    .first<{ userId: string }>();
  if (!recipient) return { notified: false };

  // Reassignment must not leave an actionable invitation in the previous
  // assignee's inbox. Response notifications use different types and remain.
  await clearAssignmentInvitation(input.orgId, input.assignmentId);

  const { notifyOperationalEvent } = await import(
    "@/lib/operational-notifications.server"
  );
  const result = await notifyOperationalEvent({
    orgId: input.orgId,
    recipientIds: [recipient.userId],
    type: "assignment",
    severity: "info",
    title: input.reminder ? "Assignment reminder" : "New assignment",
    message: `${input.role} · ${input.serviceName} · ${input.serviceDate} · Call ${input.start}`,
    actionUrl: `schedule?date=${encodeURIComponent(input.serviceDate)}&assignment=${encodeURIComponent(input.assignmentId)}`,
    source: input.assignmentId,
    pushTag: `assignment-${input.assignmentId}`,
    dedupeKey: `assignment-${input.assignmentId}`,
  });
  return { notified: result.notified > 0 };
}
