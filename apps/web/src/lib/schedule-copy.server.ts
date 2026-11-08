import { env } from "cloudflare:workers";
import { z } from "zod";
import { getD1 } from "./d1";
import { getAuth } from "./auth";
import { memberPermissionGuard } from "./member-permission-guard.server";
import { markDatabaseWrite } from "./request-database.server";
import { requireShowPilotBaseUrl } from "./auth-origins";
import { sendCrewScheduleInvite } from "./crew-schedule";
import {
  copyTeamResultSchema,
  type CopyTeamCommand,
  type CopyTeamResult,
} from "./schedule-copy-contract";

type Database = Pick<D1Database, "prepare" | "batch">;
const rowsSchema = z.array(
  z.object({
    id: z.string(),
    role: z.string(),
    department: z.string(),
    crewMemberId: z.string().nullable(),
    callTime: z.string(),
    revision: z.string(),
  }),
);
export async function runCopyScheduleTeam(
  headers: Headers,
  command: CopyTeamCommand,
  db: Database = getD1(),
): Promise<CopyTeamResult> {
  const session = await getAuth().api.getSession({
    headers,
    query: { disableCookieCache: true },
  });
  if (!session || session.user.id !== command.userId)
    throw new Error(
      "Your account changed. Reopen Schedule before copying a team.",
    );
  const {
    orgId,
    userId,
    requestId,
    showId,
    serviceDate,
    copyFromShowId,
    copyFrom,
  } = command;
  const access = await memberPermissionGuard(
    db,
    orgId,
    { userId, sessionId: session.session.id },
    ["schedule:manage"],
  );
  const fingerprint = JSON.stringify([
    showId,
    serviceDate,
    copyFromShowId,
    copyFrom,
  ]);
  const read = `SELECT fingerprint,reason,rows FROM schedule_copy_request WHERE orgId=? AND actorId=? AND requestId=? AND ${access.guard}`;
  const readArgs = [orgId, userId, requestId, ...access.guardArgs];
  let stored: unknown = await db
    .prepare(read)
    .bind(...readArgs)
    .first();
  if (!stored) {
    const nonce = crypto.randomUUID();
    const owns =
      "r.orgId=? AND r.actorId=? AND r.requestId=? AND r.nonce=? AND r.reason IS NULL";
    const ownsArgs = [orgId, userId, requestId, nonce];
    // Source selection, empty/stopped target check, all rows and their receipt
    // commit as one transaction. Another copy/add cannot slip between them.
    const results = await db.batch([
      db
        .prepare(
          `INSERT INTO schedule_copy_request(orgId,actorId,requestId,fingerprint,nonce,reason,rows,createdAt)
        SELECT ?,?,?,?,?,CASE
          WHEN NOT EXISTS(SELECT 1 FROM rundown WHERE orgId=? AND id=? AND serviceDate=?)
            OR NOT EXISTS(SELECT 1 FROM rundown WHERE orgId=? AND id=? AND serviceDate=?) THEN 'show-missing'
          WHEN EXISTS(SELECT 1 FROM rundown WHERE orgId=? AND id=? AND status IN ('running','paused')) THEN 'live-show'
          WHEN EXISTS(SELECT 1 FROM service_assignment WHERE orgId=? AND showId=?) THEN 'target-not-empty'
          WHEN NOT EXISTS(SELECT 1 FROM service_assignment WHERE orgId=? AND showId=?) THEN 'source-empty'
          WHEN EXISTS(SELECT 1 FROM service_assignment a WHERE a.orgId=? AND a.showId=? AND a.crewMemberId IS NOT NULL
            AND NOT EXISTS(SELECT 1 FROM crew_member c WHERE c.orgId=a.orgId AND c.id=a.crewMemberId)) THEN 'crew-changed'
          ELSE NULL END,
          (SELECT json_group_array(json_object('id',lower(hex(randomblob(16))),'role',a.role,'department',a.department,'crewMemberId',a.crewMemberId,'callTime',a.callTime))
            FROM (SELECT * FROM service_assignment WHERE orgId=? AND showId=? ORDER BY department,role,createdAt,id) a),?
        WHERE ${access.guard} ON CONFLICT(orgId,actorId,requestId) DO NOTHING`,
        )
        .bind(
          orgId,
          userId,
          requestId,
          fingerprint,
          nonce,
          orgId,
          showId,
          serviceDate,
          orgId,
          copyFromShowId,
          copyFrom,
          orgId,
          showId,
          orgId,
          showId,
          orgId,
          copyFromShowId,
          orgId,
          copyFromShowId,
          orgId,
          copyFromShowId,
          Date.now(),
          ...access.guardArgs,
        ),
      db
        .prepare(
          `INSERT INTO service_assignment(id,orgId,showId,serviceDate,crewMemberId,assignedByUserId,role,department,status,callTime,notes,responseNote,createdAt,updatedAt)
        SELECT json_extract(j.value,'$.id'),?,?,?,json_extract(j.value,'$.crewMemberId'),?,
          json_extract(j.value,'$.role'),json_extract(j.value,'$.department'),'assigned',json_extract(j.value,'$.callTime'),'','',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
        FROM schedule_copy_request r,json_each(r.rows) j WHERE ${owns}`,
        )
        .bind(orgId, showId, serviceDate, userId, ...ownsArgs),
      db
        .prepare(
          `UPDATE schedule_copy_request AS r SET rows=(
        SELECT json_group_array(json_set(j.value,'$.revision',v.revision))
        FROM json_each(r.rows) j JOIN schedule_assignment_revision v ON v.orgId=r.orgId AND v.assignmentId=json_extract(j.value,'$.id')
      ) WHERE ${owns}`,
        )
        .bind(...ownsArgs),
      db.prepare(read).bind(...readArgs),
    ]);
    stored = results[3].results[0];
  }
  if (!stored)
    throw new Error(
      "Your scheduling permission changed. Reopen Schedule before copying a team.",
    );
  const receipt = z
    .object({
      fingerprint: z.string(),
      reason: copyTeamResultSchema.shape.reason,
      rows: z.string(),
    })
    .parse(stored);
  if (receipt.fingerprint !== fingerprint)
    throw new Error("This copy request belongs to a different show selection.");
  markDatabaseWrite();
  if (receipt.reason)
    return {
      orgId,
      userId,
      requestId,
      copied: 0,
      reason: receipt.reason,
      items: [],
    };
  const rows = rowsSchema.parse(JSON.parse(receipt.rows));
  const items = await Promise.all(
    rows.map(async (row) => {
      const common = {
        id: row.id,
        label: `${row.department} · ${row.role}`,
        changed: false,
        invitation: null,
      };
      const current = await db
        .prepare(
          `SELECT a.id FROM service_assignment a JOIN schedule_assignment_revision v ON v.orgId=a.orgId AND v.assignmentId=a.id
      WHERE a.orgId=? AND a.id=? AND v.revision=? AND ${access.guard}`,
        )
        .bind(orgId, row.id, row.revision, ...access.guardArgs)
        .first();
      if (!current) return { ...common, changed: true };
      if (!row.crewMemberId) return common;
      try {
        const delivery = await sendCrewScheduleInvite({
          orgId,
          assignmentId: row.id,
          crewMemberId: row.crewMemberId,
          serviceDate,
          role: row.role,
          requestId: `copy:${userId}:${requestId}`,
          origin: requireShowPilotBaseUrl(env.BETTER_AUTH_URL),
          reviewedAssignment: { showId, callTime: row.callTime },
          authority: {
            sql: `${access.guard} AND EXISTS(SELECT 1 FROM schedule_assignment_revision WHERE orgId=? AND assignmentId=? AND revision=?)
          AND EXISTS(SELECT 1 FROM rundown WHERE orgId=? AND id=? AND serviceDate=? AND status NOT IN ('running','paused'))`,
            args: [
              ...access.guardArgs,
              orgId,
              row.id,
              row.revision,
              orgId,
              showId,
              serviceDate,
            ],
          },
        });
        const invitation =
          "emailState" in delivery
            ? {
                id: row.id,
                label: common.label,
                email: delivery.emailState,
                inAppDelivered: delivery.inAppDelivered,
                reason: delivery.reason,
                updatedAt: delivery.updatedAt,
              }
            : {
                id: row.id,
                label: common.label,
                email:
                  delivery.reason === "missing-email"
                    ? ("unavailable" as const)
                    : ("changed" as const),
                inAppDelivered: false,
                reason: delivery.reason,
                updatedAt: Date.now(),
              };
        return { ...common, invitation };
      } catch {
        return {
          ...common,
          invitation: {
            id: row.id,
            label: common.label,
            email: "uncertain" as const,
            inAppDelivered: false,
            reason: "delivery-not-confirmed",
            updatedAt: Date.now(),
          },
        };
      }
    }),
  );
  return { orgId, userId, requestId, copied: rows.length, reason: null, items };
}
