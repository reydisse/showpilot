import { z } from "zod";
import { getD1 } from "./d1";
import { getAuth } from "./auth";
import { memberPermissionGuard } from "./member-permission-guard.server";
import { requireShowPilotBaseUrl } from "./auth-origins";
import { sendCrewScheduleInvite } from "./crew-schedule";
import { markDatabaseWrite } from "./request-database.server";
import type {
  ScheduleReminderCommand,
  ScheduleReminderResult,
} from "./schedule-reminder-contract";
import { env } from "cloudflare:workers";
const targetsSchema = z.array(
  z.object({
    id: z.string(),
    crewMemberId: z.string(),
    serviceDate: z.string(),
    role: z.string(),
    callTime: z.string(),
    showId: z.string().nullable(),
    name: z.string(),
  }),
);
export async function runScheduleReminders(
  headers: Headers,
  command: ScheduleReminderCommand,
): Promise<ScheduleReminderResult> {
  const session = await getAuth().api.getSession({
    headers,
    query: { disableCookieCache: true },
  });
  if (!session || session.user.id !== command.userId)
    throw new Error(
      "Your account changed. Reopen Schedule before sending reminders.",
    );
  const db = getD1(),
    { orgId, requestId, userId, target } = command;
  const access = await memberPermissionGuard(
    db,
    orgId,
    { userId, sessionId: session.session.id },
    ["schedule:manage"],
  );
  const selection = JSON.stringify(target);
  const read = async () => {
    const row = await db
      .prepare(
        `SELECT selection,targets FROM schedule_reminder_request WHERE orgId=? AND actorId=? AND requestId=? AND ${access.guard}`,
      )
      .bind(orgId, userId, requestId, ...access.guardArgs)
      .first<{ selection: string; targets: string }>();
    if (row && row.selection !== selection)
      throw new Error(
        "This reminder request belongs to a different selection.",
      );
    return row;
  };
  let receipt = await read();
  if (!receipt) {
    // Freeze the selected assignments, so retrying a bulk send never includes a
    // new assignee or a position created after the operator pressed Send.
    const rows = await db
      .prepare(
        `SELECT a.id,a.crewMemberId,a.serviceDate,a.role,a.callTime,a.showId,c.name
      FROM service_assignment a JOIN crew_member c ON c.orgId=a.orgId AND c.id=a.crewMemberId
      WHERE a.orgId=? AND a.${target.kind === "show" ? "showId" : "id"}=? AND a.status='assigned' ORDER BY a.id`,
      )
      .bind(orgId, target.id)
      .all();
    const targets = targetsSchema.parse(rows.results);
    await db
      .prepare(
        `INSERT INTO schedule_reminder_request(orgId,actorId,requestId,selection,targets,createdAt)
      SELECT ?,?,?,?,?,? WHERE ${access.guard} ON CONFLICT(orgId,actorId,requestId) DO NOTHING`,
      )
      .bind(
        orgId,
        userId,
        requestId,
        selection,
        JSON.stringify(targets),
        Date.now(),
        ...access.guardArgs,
      )
      .run();
    receipt = await read();
  }
  if (!receipt)
    throw new Error(
      "Your scheduling permission changed. Reopen Schedule before sending reminders.",
    );
  markDatabaseWrite();
  const targets = targetsSchema.parse(JSON.parse(receipt.targets));
  const items = await Promise.all(
    targets.map(async (target) => {
      const common = {
        id: target.id,
        label: `${target.role} · ${target.name}`,
        updatedAt: Date.now(),
      };
      try {
        const result = await sendCrewScheduleInvite({
          orgId,
          assignmentId: target.id,
          crewMemberId: target.crewMemberId,
          serviceDate: target.serviceDate,
          role: target.role,
          reminder: true,
          origin: requireShowPilotBaseUrl(env.BETTER_AUTH_URL),
          requestId: `${userId}:${requestId}`,
          authority: { sql: access.guard, args: access.guardArgs },
          reviewedAssignment: {
            showId: target.showId,
            callTime: target.callTime,
          },
        });
        if ("emailState" in result)
          return {
            ...common,
            email: result.emailState,
            inAppDelivered: result.inAppDelivered,
            reason: result.reason,
            updatedAt: result.updatedAt,
          };
        return {
          ...common,
          email:
            result.reason === "missing-email"
              ? ("unavailable" as const)
              : ("changed" as const),
          inAppDelivered: false,
          reason: result.reason,
        };
      } catch {
        return {
          ...common,
          email: "uncertain" as const,
          inAppDelivered: false,
          reason: "delivery-not-confirmed",
        };
      }
    }),
  );
  return { orgId, userId, requestId, items };
}
