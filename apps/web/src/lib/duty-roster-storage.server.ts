import { z } from "zod";
import { dutyRosterSnapshotSchema } from "./duty-roster-contract";
export type DutyDatabase = Pick<D1Database, "prepare" | "batch">;
export type DutySlot =
  | { kind: "pm"; roleId: null; userId: string | null; roleName: string }
  | { kind: "tech"; roleId: string; userId: string | null; roleName: string };
export async function readDutyRoster(
  database: DutyDatabase,
  orgId: string,
  weekStart: string,
) {
  const row = await database
    .prepare(
      `SELECT
  COALESCE((SELECT revision FROM duty_roster_version WHERE orgId=? AND scope='roles'),0) AS rolesRevision,
  COALESCE((SELECT revision FROM duty_roster_version WHERE orgId=? AND scope=?),0) AS weekRevision,
  (SELECT json_group_array(json_object('id',id,'code',code,'name',name,'short',short,'sortOrder',sortOrder,'revision',revision)) FROM (SELECT * FROM roster_role WHERE orgId=? ORDER BY sortOrder,code)) AS roles,
  (SELECT json_group_array(json_object('kind',kind,'roleId',roleId,'userId',userId)) FROM roster_assignment WHERE orgId=? AND weekStart=?) AS assignments,
  (SELECT json_group_array(json_object('id',u.id,'name',u.name)) FROM member m JOIN user u ON u.id=m.userId WHERE m.organizationId=?) AS members,
  (SELECT COUNT(*) FROM duty_notification_job WHERE orgId=? AND status='pending') AS pendingNotifications`,
    )
    .bind(
      orgId,
      orgId,
      `week:${weekStart}`,
      orgId,
      orgId,
      weekStart,
      orgId,
      orgId,
    )
    .first<{
      rolesRevision: number;
      weekRevision: number;
      roles: string;
      assignments: string;
      members: string;
      pendingNotifications: number;
    }>();
  if (!row) throw new Error("Roster state could not be read.");
  const assignments = z
    .array(
      z.object({
        kind: z.enum(["pm", "tech"]),
        roleId: z.string().nullable(),
        userId: z.string(),
      }),
    )
    .parse(JSON.parse(row.assignments));
  const tech: Record<string, string> = {};
  let pmUserId: string | null = null;
  for (const assignment of assignments) {
    if (assignment.kind === "pm") pmUserId = assignment.userId;
    else if (assignment.roleId) tech[assignment.roleId] = assignment.userId;
  }
  return dutyRosterSnapshotSchema.parse({
    ...row,
    roles: JSON.parse(row.roles),
    members: JSON.parse(row.members),
    tech,
    pmUserId,
  });
}
/** Capture removal notifications before deleting rows; the caller batches these together. */
export function removalJobs(
  database: DutyDatabase,
  where: string,
  args: unknown[],
  guard: string,
  guardArgs: unknown[],
) {
  return database
    .prepare(
      `INSERT INTO duty_notification_job(id,orgId,userId,assignmentId,weekStart,kind,roleId,roleName,removed)
  SELECT 'removed:'||a.id,a.orgId,a.userId,a.id,a.weekStart,a.kind,a.roleId,CASE WHEN a.kind='pm' THEN 'Production Manager' ELSE COALESCE(r.name,'Technical duty') END,1
  FROM roster_assignment a LEFT JOIN roster_role r ON r.id=a.roleId AND r.orgId=a.orgId
  WHERE ${where} AND ${guard} ON CONFLICT(id) DO NOTHING`,
    )
    .bind(...args, ...guardArgs);
}
/** Assignment, removal notices and addition notices share the caller's atomic batch. */
export function dutySlotWrites(
  database: DutyDatabase,
  orgId: string,
  weekStart: string,
  slot: DutySlot,
  guard: string,
  guardArgs: unknown[],
) {
  const scope = [orgId, weekStart, slot.kind, slot.roleId],
    id = crypto.randomUUID();
  const target = "orgId=? AND weekStart=? AND kind=? AND roleId IS ?";
  const statements = [];
  if (slot.kind === "tech")
    statements.push(
      database
        .prepare(
          `UPDATE roster_role SET revision=revision+1 WHERE orgId=? AND id=? AND ${guard} AND
  (EXISTS(SELECT 1 FROM roster_assignment WHERE ${target} AND (? IS NULL OR userId<>?)) OR (? IS NOT NULL AND NOT EXISTS(SELECT 1 FROM roster_assignment WHERE ${target} AND userId=?)))`,
        )
        .bind(
          orgId,
          slot.roleId,
          ...guardArgs,
          ...scope,
          slot.userId,
          slot.userId,
          slot.userId,
          ...scope,
          slot.userId,
        ),
    );
  statements.push(
    removalJobs(
      database,
      "a.orgId=? AND a.weekStart=? AND a.kind=? AND a.roleId IS ? AND (? IS NULL OR a.userId<>?)",
      [...scope, slot.userId, slot.userId],
      guard,
      guardArgs,
    ),
  );
  statements.push(
    database
      .prepare(
        `DELETE FROM roster_assignment WHERE ${target} AND (? IS NULL OR userId<>?) AND ${guard}`,
      )
      .bind(...scope, slot.userId, slot.userId, ...guardArgs),
  );
  statements.push(
    database
      .prepare(
        `INSERT INTO roster_assignment(id,orgId,weekStart,kind,roleId,userId)
  SELECT ?,?,?,?,?,? WHERE ? IS NOT NULL AND ${guard} AND NOT EXISTS(SELECT 1 FROM roster_assignment WHERE ${target} AND userId=?)`,
      )
      .bind(
        id,
        ...scope,
        slot.userId,
        slot.userId,
        ...guardArgs,
        ...scope,
        slot.userId,
      ),
  );
  statements.push(
    database
      .prepare(
        `INSERT INTO duty_notification_job(id,orgId,userId,assignmentId,weekStart,kind,roleId,roleName,removed)
  SELECT 'assigned:'||id,orgId,userId,id,weekStart,kind,roleId,?,0 FROM roster_assignment WHERE id=? AND ${guard} ON CONFLICT(id) DO NOTHING`,
      )
      .bind(slot.roleName, id, ...guardArgs),
  );
  return statements;
}
