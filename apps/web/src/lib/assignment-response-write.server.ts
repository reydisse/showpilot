import { z } from "zod";
import { markDatabaseWrite } from "./request-database.server";
import { getAssignmentCallTime } from "./assignment-call-time";
import { assignmentResponseVersion } from "./assignment-response-version";
import { getCrewScheduleResponseWindow } from "./crew-schedule-response";
import { readPhaseSettings } from "./service-phase";
import { notifyOperationalEvent } from "./operational-notifications.server";
import type {
  PersonalResponseCommand,
  PersonalResponseResult,
} from "./personal-assignment-response-contract";
export type ResponseWriteCommand = Omit<
  PersonalResponseCommand,
  "orgId" | "userId" | "expectedRevision"
> & { expectedRevision: string | null };
export type ResponseWriteAuthority = {
  orgId: string;
  principalId: string;
  actorId: string | null;
  guard: string;
  guardArgs: (string | number | null)[];
  denied: string;
} & (
  | { kind: "member"; email: string }
  | { kind: "portal"; crewMemberId: string }
);
const sqlInstant = z.union([z.string(), z.number()]).nullable();
const stateSchema = z.object({
  revision: z.string(),
  showId: z.string().nullable(),
  crewMemberId: z.string(),
  serviceDate: z.string(),
  role: z.string(),
  callTime: z.string(),
  status: z.string(),
  crewName: z.string(),
  crewEmail: z.string(),
  assignedByUserId: z.string().nullable(),
  scheduledStartTime: sqlInstant,
  scheduledCallTime: sqlInstant,
  plannedDurationMs: z.number(),
  timeZone: z.string(),
  window: z.string(),
  lead: z.string(),
});
const notificationSchema = z.object({
  recipientId: z.string().nullable(),
  name: z.string(),
  role: z.string(),
  date: z.string(),
});
const receiptSchema = z.object({
  fingerprint: z.string(),
  outcome: z.enum([
    "applied",
    "conflict",
    "closed",
    "unavailable",
    "cancelled",
  ]),
  appliedRevision: z.string().nullable(),
  notification: z.string().nullable(),
});
function iso(value: string | number | null) {
  if (value === null) return null;
  const normalized =
    typeof value === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:/.test(value)
      ? value.replace(" ", "T") + "Z"
      : value;
  return new Date(normalized).toISOString();
}
/** Only the auth adapters construct authority. Identifiers below are selected
 * from two fixed stores; all request values and guard arguments remain bound. */
export async function writeAssignmentResponse(
  command: ResponseWriteCommand,
  authority: ResponseWriteAuthority,
  review: boolean,
  db: Pick<D1Database, "prepare" | "batch">,
): Promise<
  Pick<PersonalResponseResult, "requestId" | "assignmentId" | "outcome">
> {
  const { orgId, principalId, guard, guardArgs } = authority;
  const { requestId, assignmentId } = command;
  const table =
    authority.kind === "member"
      ? "personal_assignment_response"
      : "crew_assignment_response";
  const principalColumn = authority.kind === "member" ? "actorId" : "accessId";
  const ownerSql = authority.kind === "member" ? "lower(c.email)=?" : "c.id=?";
  const ownerId =
    authority.kind === "member" ? authority.email : authority.crewMemberId;
  // The exact SQL snapshot is compared again inside the transaction. This includes
  // linked show times, duration and settings, not just the assignment row revision.
  const snapshotSql = `SELECT json_object(
  'revision',v.revision,'showId',a.showId,'crewMemberId',a.crewMemberId,
  'serviceDate',a.serviceDate,'role',a.role,'callTime',a.callTime,'status',a.status,
  'crewName',c.name,'crewEmail',lower(c.email),'assignedByUserId',a.assignedByUserId,
  'scheduledStartTime',r.scheduledStartTime,'scheduledCallTime',r.scheduledCallTime,
  'plannedDurationMs',COALESCE((SELECT SUM(duration) FROM rundown_item WHERE orgId=a.orgId AND showId=a.showId),0),
  'timeZone',COALESCE((SELECT value FROM app_setting WHERE orgId=a.orgId AND key='org-timezone'),'UTC'),
  'window',COALESCE((SELECT value FROM app_setting WHERE orgId=a.orgId AND key='default-service-window-minutes'),''),
  'lead',COALESCE((SELECT value FROM app_setting WHERE orgId=a.orgId AND key='default-call-lead-minutes'),'')
) AS state FROM service_assignment a
JOIN crew_member c ON c.orgId=a.orgId AND c.id=a.crewMemberId
JOIN schedule_assignment_revision v ON v.orgId=a.orgId AND v.assignmentId=a.id
LEFT JOIN rundown r ON r.orgId=a.orgId AND r.id=a.showId
WHERE a.orgId=? AND a.id=? AND ${ownerSql}`;
  const fingerprint = JSON.stringify([
    assignmentId,
    command.expectedRevision,
    command.reviewedVersion,
    command.response,
    command.reason,
  ]);
  const receiptSql = `SELECT fingerprint,outcome,appliedRevision,notification FROM ${table} WHERE orgId=? AND ${principalColumn}=? AND requestId=? AND ${guard}`;
  const receiptArgs = [orgId, principalId, requestId, ...guardArgs];
  let receiptRow: unknown = await db
    .prepare(receiptSql)
    .bind(...receiptArgs)
    .first();
  if (!receiptRow) {
    const raw = await db
      .prepare(snapshotSql)
      .bind(orgId, assignmentId, ownerId)
      .first<{ state: string }>();
    const state = raw ? stateSchema.parse(JSON.parse(raw.state)) : null;
    let outcome: z.infer<typeof receiptSchema>["outcome"] = review
      ? "cancelled"
      : "unavailable";
    let closesAt: string | null = null;
    if (!review && state) {
      const settings = {
        "org-timezone": state.timeZone,
        "default-service-window-minutes": state.window,
        "default-call-lead-minutes": state.lead,
      };
      const times = {
        scheduledStartTime: iso(state.scheduledStartTime),
        scheduledCallTime: iso(state.scheduledCallTime),
      };
      const { serviceWindowMinutes, callLeadMinutes } =
        readPhaseSettings(settings);
      const version = assignmentResponseVersion({
        ...state,
        ...times,
        effectiveCallTime: getAssignmentCallTime({
          ...state,
          ...times,
          callLeadMinutes,
        }),
      });
      const window = getCrewScheduleResponseWindow(
        {
          ...state,
          ...times,
          serviceWindowMinutes,
          plannedDurationMs: state.showId ? state.plannedDurationMs : undefined,
        },
        Date.now(),
      );
      closesAt = window.status === "open" ? window.closesAt : null;
      outcome =
        state.status !== "assigned" ||
        version !== command.reviewedVersion ||
        (command.expectedRevision !== null &&
          command.expectedRevision !== state.revision)
          ? "conflict"
          : window.status === "closed"
            ? "closed"
            : "applied";
    }
    const nonce = crypto.randomUUID();
    const owns = `EXISTS(SELECT 1 FROM ${table} WHERE orgId=? AND ${principalColumn}=? AND requestId=? AND nonce=? AND outcome='applied')`;
    const ownsArgs = [orgId, principalId, requestId, nonce];
    const notification = state
      ? JSON.stringify({
          recipientId: state.assignedByUserId,
          name: state.crewName,
          role: state.role,
          date: state.serviceDate,
        })
      : null;
    const result = await db.batch([
      db
        .prepare(
          `INSERT INTO ${table} (orgId,${principalColumn},requestId,assignmentId,fingerprint,nonce,outcome,notification,createdAt)
        SELECT ?,?,?,?,?,?,CASE WHEN ?<>'applied' THEN ?
          WHEN (${snapshotSql}) IS NOT ? THEN 'conflict'
          WHEN julianday('now')>=julianday(?) THEN 'closed' ELSE 'applied' END,?,?
        WHERE ${guard} ON CONFLICT(orgId,${principalColumn},requestId) DO NOTHING`,
        )
        .bind(
          orgId,
          principalId,
          requestId,
          assignmentId,
          fingerprint,
          nonce,
          outcome,
          outcome,
          orgId,
          assignmentId,
          ownerId,
          raw?.state ?? null,
          closesAt,
          notification,
          Date.now(),
          ...guardArgs,
        ),
      db
        .prepare(
          `UPDATE service_assignment SET status=?,responseNote=?,respondedAt=CURRENT_TIMESTAMP,updatedAt=CURRENT_TIMESTAMP
        WHERE orgId=? AND id=? AND ${owns}`,
        )
        .bind(
          command.response,
          command.reason,
          orgId,
          assignmentId,
          ...ownsArgs,
        ),
      db
        .prepare(
          `UPDATE ${table} SET appliedRevision=(SELECT revision FROM schedule_assignment_revision WHERE orgId=? AND assignmentId=?)
        WHERE orgId=? AND ${principalColumn}=? AND requestId=? AND nonce=? AND outcome='applied'`,
        )
        .bind(orgId, assignmentId, ...ownsArgs),
      db.prepare(receiptSql).bind(...receiptArgs),
    ]);
    receiptRow = result[3].results[0];
    markDatabaseWrite();
  }
  if (!receiptRow) throw new Error(authority.denied);
  const receipt = receiptSchema.parse(receiptRow);
  if (receipt.fingerprint !== fingerprint)
    throw new Error("This request belongs to a different assignment response.");
  // Receipt reads must remain available even if the position was removed or
  // reassigned. They disclose only this actor's original operation outcome.
  const current = await db.batch([
    db
      .prepare(
        `SELECT v.revision FROM service_assignment a JOIN schedule_assignment_revision v ON v.orgId=a.orgId AND v.assignmentId=a.id WHERE a.orgId=? AND a.id=? AND ${guard}`,
      )
      .bind(orgId, assignmentId, ...guardArgs),
    db.prepare(`SELECT 1 AS allowed WHERE ${guard}`).bind(...guardArgs),
  ]);
  if (!current[1].results.length) throw new Error(authority.denied);
  let outcome: PersonalResponseResult["outcome"] = receipt.outcome;
  if (receipt.outcome === "applied") {
    const row = current[0].results[0];
    outcome = !row
      ? "removed"
      : z.object({ revision: z.string() }).parse(row).revision ===
          receipt.appliedRevision
        ? "applied"
        : "superseded";
    if (receipt.notification && outcome === "applied") {
      const notice = notificationSchema.parse(JSON.parse(receipt.notification));
      await notifyOperationalEvent({
        orgId,
        actorId: authority.actorId,
        recipientIds: notice.recipientId ? [notice.recipientId] : [],
        category: "schedule",
        type: `assignment-${command.response}`,
        severity: command.response === "declined" ? "warning" : "info",
        title: `${notice.name || "Crew member"} ${command.response === "confirmed" ? "accepted" : "declined"} an assignment`,
        message: `${notice.role} · ${notice.date}${command.reason ? ` · ${command.reason}` : ""}`,
        actionUrl: `schedule?date=${encodeURIComponent(notice.date)}&assignment=${encodeURIComponent(assignmentId)}`,
        source: assignmentId,
        pushTag: `assignment-response-${assignmentId}`,
        dedupeKey: `${authority.kind === "member" ? "personal-response" : "crew-response"}:${principalId}:${requestId}`,
        once: true,
      });
    }
  }
  return { requestId, assignmentId, outcome };
}
