import { env } from "cloudflare:workers";
import { z } from "zod";
import { getAuth } from "./auth";
import { getD1 } from "./d1";
import { memberPermissionGuard } from "./member-permission-guard.server";
import { markDatabaseWrite } from "./request-database.server";
import {
  assignmentCallTimeForStorage,
  getAssignmentCallTime,
} from "./assignment-call-time";
import { requireShowPilotBaseUrl } from "./auth-origins";
import { sendCrewScheduleInvite } from "./crew-schedule";
import {
  assignmentSnapshotSchema,
  type ScheduleAssignmentCommand,
  type ScheduleAssignmentResult,
} from "./schedule-assignment-contract";

type Database = Pick<D1Database, "prepare" | "batch">;
const snapshotSelect = `SELECT a.id,r.revision,a.showId,a.serviceDate,a.role,a.department,
  a.crewMemberId,a.status,a.callTime,a.notes,a.responseNote
  FROM service_assignment a JOIN schedule_assignment_revision r ON r.orgId=a.orgId AND r.assignmentId=a.id`;
const denied = () =>
  new Error(
    "Your account or scheduling permission changed. Reopen Schedule before saving.",
  );
async function authority(headers: Headers, orgId: string, db: Database) {
  const session = await getAuth().api.getSession({
    headers,
    query: { disableCookieCache: true },
  });
  if (!session) throw denied();
  return {
    userId: session.user.id,
    ...(await memberPermissionGuard(
      db,
      orgId,
      { userId: session.user.id, sessionId: session.session.id },
      ["schedule:manage"],
    )),
  };
}
export async function readScheduleAssignment(
  headers: Headers,
  orgId: string,
  id: string,
  db: Database = getD1(),
) {
  const access = await authority(headers, orgId, db);
  const result = await db.batch([
    db
      .prepare(
        `${snapshotSelect} WHERE a.orgId=? AND a.id=? AND ${access.guard}`,
      )
      .bind(orgId, id, ...access.guardArgs),
    db
      .prepare(`SELECT 1 AS allowed WHERE ${access.guard}`)
      .bind(...access.guardArgs),
  ]);
  if (!result[1].results.length) throw denied();
  const row = result[0].results[0];
  return {
    orgId,
    userId: access.userId,
    snapshot: row ? assignmentSnapshotSchema.parse(row) : null,
  };
}
const invitationSchema = z.object({
  crewMemberId: z.string(),
  serviceDate: z.string(),
  role: z.string(),
  showId: z.string().nullable(),
  callTime: z.string(),
});
const receiptSchema = z.object({
  fingerprint: z.string(),
  outcome: z.enum(["applied", "conflict"]),
  assignmentId: z.string(),
  revision: z.string().nullable(),
  invitation: z.string().nullable(),
});
const sqlTime = z.union([z.string(), z.number()]).nullable();
function iso(value: string | number | null) {
  if (value === null) return null;
  const normalized =
    typeof value === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:/.test(value)
      ? value.replace(" ", "T") + "Z"
      : value;
  return new Date(normalized).toISOString();
}

/** Fence an undelivered command before its draft is unlocked. If it already
 * committed, recover that receipt and the same invitation instead. */
export async function reviewScheduleAssignment(
  headers: Headers,
  command: ScheduleAssignmentCommand,
  db: Database = getD1(),
): Promise<ScheduleAssignmentResult> {
  const { orgId, userId, requestId, operation } = command;
  const access = await authority(headers, orgId, db);
  if (access.userId !== userId) throw denied();
  await db
    .prepare(
      `INSERT INTO schedule_assignment_request
    (orgId,actorId,requestId,fingerprint,nonce,outcome,assignmentId,createdAt)
    SELECT ?,?,?,?,?,'conflict',?,? WHERE ${access.guard}
    ON CONFLICT(orgId,actorId,requestId) DO NOTHING`,
    )
    .bind(
      orgId,
      userId,
      requestId,
      JSON.stringify(operation),
      crypto.randomUUID(),
      operation.kind === "create" ? requestId : operation.id,
      Date.now(),
      ...access.guardArgs,
    )
    .run();
  markDatabaseWrite();
  return writeScheduleAssignment(headers, command, db);
}

/** The receipt and assignment commit together. Replaying a receipt never writes the assignment again. */
export async function writeScheduleAssignment(
  headers: Headers,
  command: ScheduleAssignmentCommand,
  db: Database = getD1(),
): Promise<ScheduleAssignmentResult> {
  const { orgId, userId, requestId, operation } = command;
  const access = await authority(headers, orgId, db);
  if (access.userId !== userId) throw denied();
  const fingerprint = JSON.stringify(operation);
  const receiptSelect = `SELECT fingerprint,outcome,assignmentId,revision,invitation FROM schedule_assignment_request
    WHERE orgId=? AND actorId=? AND requestId=? AND ${access.guard}`;
  const receiptArgs = [orgId, userId, requestId, ...access.guardArgs];
  let receiptRow: unknown = await db
    .prepare(receiptSelect)
    .bind(...receiptArgs)
    .first();
  if (!receiptRow) {
    const nonce = crypto.randomUUID();
    const currentRow =
      operation.kind === "create"
        ? null
        : await db
            .prepare(`${snapshotSelect} WHERE a.orgId=? AND a.id=?`)
            .bind(orgId, operation.id)
            .first();
    const current = currentRow
      ? assignmentSnapshotSchema.parse(currentRow)
      : null;
    const replacingDecline =
      operation.kind === "edit" &&
      current?.status === "declined" &&
      current.crewMemberId !== operation.fields.crewMemberId;
    const assignmentId =
      operation.kind === "create" || replacingDecline
        ? crypto.randomUUID()
        : operation.id;
    const checks: string[] = [];
    const checkArgs: (string | number | null)[] = [];
    if (operation.kind !== "create") {
      checks.push(`EXISTS(SELECT 1 FROM service_assignment a JOIN schedule_assignment_revision r ON r.orgId=a.orgId AND r.assignmentId=a.id
        WHERE a.orgId=? AND a.id=? AND r.revision=?)`);
      checkArgs.push(orgId, operation.id, operation.expectedRevision);
    }
    let callTime = "";
    if (operation.kind !== "delete") {
      const fields = operation.fields;
      const showRow = await db
        .prepare(
          `SELECT updatedAt,scheduledStartTime,scheduledCallTime,
        COALESCE((SELECT value FROM app_setting WHERE orgId=? AND key='org-timezone'),'UTC') AS timeZone
        FROM rundown WHERE orgId=? AND id=? AND serviceDate=?`,
        )
        .bind(orgId, orgId, fields.showId, fields.serviceDate)
        .first();
      if (!showRow)
        throw new Error(
          "This show is no longer available. Refresh the schedule before saving.",
        );
      const show = z
        .object({
          updatedAt: sqlTime,
          scheduledStartTime: sqlTime,
          scheduledCallTime: sqlTime,
          timeZone: z.string(),
        })
        .parse(showRow);
      callTime = assignmentCallTimeForStorage({
        serviceDate: fields.serviceDate,
        callTime: fields.callTime,
        deviceTimeZone: fields.timeZone,
        venueTimeZone: show.timeZone || "UTC",
        referenceTime: current?.callTime
          ? getAssignmentCallTime({
              serviceDate: current.serviceDate,
              callTime: current.callTime,
              timeZone: show.timeZone,
            })
          : iso(show.scheduledCallTime ?? show.scheduledStartTime),
      });
      checks.push(`EXISTS(SELECT 1 FROM rundown WHERE orgId=? AND id=? AND serviceDate=?
        AND updatedAt IS ? AND scheduledStartTime IS ? AND scheduledCallTime IS ?)
        AND COALESCE((SELECT value FROM app_setting WHERE orgId=? AND key='org-timezone'),'UTC')=?`);
      checkArgs.push(
        orgId,
        fields.showId,
        fields.serviceDate,
        show.updatedAt,
        show.scheduledStartTime,
        show.scheduledCallTime,
        orgId,
        show.timeZone,
      );
      if (fields.crewMemberId) {
        checks.push("EXISTS(SELECT 1 FROM crew_member WHERE orgId=? AND id=?)");
        checkArgs.push(orgId, fields.crewMemberId);
      }
      if (operation.kind === "edit") {
        checks.push(
          "EXISTS(SELECT 1 FROM service_assignment WHERE orgId=? AND id=? AND showId IS ? AND serviceDate=?)",
        );
        checkArgs.push(orgId, operation.id, fields.showId, fields.serviceDate);
      }
    }
    const invitation =
      operation.kind !== "delete" &&
      operation.fields.crewMemberId &&
      (operation.kind === "create" ||
        current?.crewMemberId !== operation.fields.crewMemberId)
        ? JSON.stringify({
            crewMemberId: operation.fields.crewMemberId,
            serviceDate: operation.fields.serviceDate,
            role: operation.fields.role,
            showId: operation.fields.showId,
            callTime,
          })
        : null;
    const owns = `EXISTS(SELECT 1 FROM schedule_assignment_request WHERE orgId=? AND actorId=? AND requestId=? AND nonce=? AND outcome='applied')`;
    const ownsArgs = [orgId, userId, requestId, nonce];
    const statements = [
      db
        .prepare(
          `INSERT INTO schedule_assignment_request
      (orgId,actorId,requestId,fingerprint,nonce,outcome,assignmentId,invitation,createdAt)
      SELECT ?,?,?,?,?,CASE WHEN ${checks.join(" AND ")} THEN 'applied' ELSE 'conflict' END,?,?,?
      WHERE ${access.guard} ON CONFLICT(orgId,actorId,requestId) DO NOTHING`,
        )
        .bind(
          orgId,
          userId,
          requestId,
          fingerprint,
          nonce,
          ...checkArgs,
          assignmentId,
          invitation,
          Date.now(),
          ...access.guardArgs,
        ),
    ];
    if (
      operation.kind === "delete" ||
      (operation.kind === "edit" &&
        !replacingDecline &&
        current?.crewMemberId !== operation.fields.crewMemberId)
    ) {
      statements.push(
        db
          .prepare(
            `DELETE FROM notification WHERE orgId=? AND source=? AND ${owns}`,
          )
          .bind(orgId, operation.id, ...ownsArgs),
      );
    }
    if (operation.kind === "delete") {
      statements.push(
        db
          .prepare(
            `DELETE FROM service_assignment WHERE orgId=? AND id=? AND ${owns}`,
          )
          .bind(orgId, operation.id, ...ownsArgs),
      );
    } else if (operation.kind === "create" || replacingDecline) {
      if (replacingDecline && operation.kind === "edit") {
        // Preserve the declined history, but consume its reviewed revision so
        // two managers cannot both replace the same response concurrently.
        statements.push(
          db
            .prepare(
              `UPDATE schedule_assignment_revision SET revision=? WHERE orgId=? AND assignmentId=? AND ${owns}`,
            )
            .bind(nonce, orgId, operation.id, ...ownsArgs),
        );
      }
      const fields = operation.fields;
      statements.push(
        db
          .prepare(
            `INSERT INTO service_assignment
        (id,orgId,showId,serviceDate,crewMemberId,assignedByUserId,role,department,status,callTime,notes,responseNote,createdAt,updatedAt)
        SELECT ?,?,?,?,?,?,?,?,'assigned',?,?,'',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP WHERE ${owns}`,
          )
          .bind(
            assignmentId,
            orgId,
            fields.showId,
            fields.serviceDate,
            fields.crewMemberId,
            userId,
            fields.role,
            fields.department,
            callTime,
            fields.notes,
            ...ownsArgs,
          ),
      );
    } else {
      const fields = operation.fields;
      statements.push(
        db
          .prepare(
            `UPDATE service_assignment SET
        status=CASE WHEN crewMemberId IS ? THEN status ELSE 'assigned' END,
        responseNote=CASE WHEN crewMemberId IS ? THEN responseNote ELSE '' END,
        respondedAt=CASE WHEN crewMemberId IS ? THEN respondedAt ELSE NULL END,
        invitedAt=CASE WHEN crewMemberId IS ? THEN invitedAt ELSE NULL END,
        assignedByUserId=CASE WHEN crewMemberId IS ? THEN assignedByUserId ELSE ? END,
        crewMemberId=?,role=?,department=?,callTime=?,notes=?,updatedAt=CURRENT_TIMESTAMP
        WHERE orgId=? AND id=? AND ${owns}`,
          )
          .bind(
            fields.crewMemberId,
            fields.crewMemberId,
            fields.crewMemberId,
            fields.crewMemberId,
            fields.crewMemberId,
            userId,
            fields.crewMemberId,
            fields.role,
            fields.department,
            callTime,
            fields.notes,
            orgId,
            operation.id,
            ...ownsArgs,
          ),
      );
    }
    statements.push(
      db
        .prepare(
          `UPDATE schedule_assignment_request SET revision=(SELECT revision FROM schedule_assignment_revision WHERE orgId=? AND assignmentId=?)
      WHERE orgId=? AND actorId=? AND requestId=? AND nonce=? AND outcome='applied'`,
        )
        .bind(orgId, assignmentId, ...ownsArgs),
    );
    statements.push(db.prepare(receiptSelect).bind(...receiptArgs));
    const results = await db.batch(statements);
    receiptRow = results.at(-1)?.results[0] ?? null;
    markDatabaseWrite();
  }
  if (!receiptRow) throw denied();
  const receipt = receiptSchema.parse(receiptRow);
  if (receipt.fingerprint !== fingerprint)
    throw new Error(
      "This save request belongs to a different assignment change.",
    );
  const currentId =
    receipt.outcome === "conflict" && operation.kind !== "create"
      ? operation.id
      : receipt.assignmentId;
  const rows = await db.batch([
    db
      .prepare(
        `${snapshotSelect} WHERE a.orgId=? AND a.id=? AND ${access.guard}`,
      )
      .bind(orgId, currentId, ...access.guardArgs),
    db
      .prepare(
        `SELECT revision FROM schedule_assignment_revision WHERE orgId=? AND assignmentId=? AND ${access.guard}`,
      )
      .bind(orgId, currentId, ...access.guardArgs),
    db
      .prepare(`SELECT 1 AS allowed WHERE ${access.guard}`)
      .bind(...access.guardArgs),
  ]);
  if (!rows[2].results.length) throw denied();
  const snapshot = rows[0].results[0]
    ? assignmentSnapshotSchema.parse(rows[0].results[0])
    : null;
  const outcome =
    receipt.outcome === "conflict"
      ? "conflict"
      : z
            .object({ revision: z.string() })
            .nullable()
            .parse(rows[1].results[0] ?? null)?.revision === receipt.revision
        ? "applied"
        : "superseded";
  const result: ScheduleAssignmentResult = {
    requestId,
    assignmentId: currentId,
    outcome,
    snapshot,
    invitation: null,
  };
  if (outcome === "applied" && receipt.invitation) {
    const invitation = invitationSchema.parse(JSON.parse(receipt.invitation));
    const common = {
      id: currentId,
      label: invitation.role,
      updatedAt: Date.now(),
    };
    try {
      const delivery = await sendCrewScheduleInvite({
        orgId,
        assignmentId: currentId,
        ...invitation,
        origin: requireShowPilotBaseUrl(env.BETTER_AUTH_URL),
        requestId: `assignment:${userId}:${requestId}`,
        reviewedAssignment: {
          showId: invitation.showId,
          callTime: invitation.callTime,
        },
        authority: {
          sql: `${access.guard} AND EXISTS(SELECT 1 FROM schedule_assignment_revision WHERE orgId=? AND assignmentId=? AND revision=?)`,
          args: [...access.guardArgs, orgId, currentId, receipt.revision],
        },
      });
      result.invitation =
        "emailState" in delivery
          ? {
              ...common,
              email: delivery.emailState,
              inAppDelivered: delivery.inAppDelivered,
              reason: delivery.reason,
              updatedAt: delivery.updatedAt,
            }
          : {
              ...common,
              email:
                delivery.reason === "missing-email" ? "unavailable" : "changed",
              inAppDelivered: false,
              reason: delivery.reason,
            };
    } catch {
      result.invitation = {
        ...common,
        email: "uncertain",
        inAppDelivered: false,
        reason: "delivery-not-confirmed",
      };
    }
  }
  return result;
}
