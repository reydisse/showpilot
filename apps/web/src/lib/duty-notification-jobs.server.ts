import {
  notifyOperationalEvent,
  operationalNotificationId,
} from "./operational-notifications.server";
import { withOperationTimeout } from "./operation-timeout";
import type { DutyDatabase } from "./duty-roster-storage.server";
type Job = {
  id: string;
  orgId: string;
  userId: string;
  assignmentId: string;
  weekStart: string;
  kind: "pm" | "tech";
  roleId: string | null;
  roleName: string;
  removed: number;
};
export function dutyDateRange(weekStart: string) {
  const end = new Date(`${weekStart}T12:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 6);
  return `${weekStart} – ${end.toISOString().slice(0, 10)}`;
}
export async function pendingDutyNotifications(
  database: DutyDatabase,
  orgId: string,
) {
  return (
    (
      await database
        .prepare(
          "SELECT COUNT(*) AS n FROM duty_notification_job WHERE orgId=? AND status='pending'",
        )
        .bind(orgId)
        .first<{ n: number }>()
    )?.n ?? 0
  );
}
/** Durable inbox retry. Push remains best effort, and an existing inbox item is never pushed twice. */
export async function flushDutyNotifications(
  database: DutyDatabase,
  orgId?: string,
) {
  const jobs = await database
    .prepare(
      `SELECT * FROM duty_notification_job j WHERE status='pending' AND (? IS NULL OR orgId=?)
  AND NOT EXISTS(SELECT 1 FROM app_setting WHERE orgId=j.orgId AND key='organization-deleting') ORDER BY COALESCE(lastAttemptAt,createdAt),id LIMIT 60`,
    )
    .bind(orgId ?? null, orgId ?? null)
    .all<Job>();
  let delivered = 0,
    skipped = 0;
  for (let index = 0; index < jobs.results.length; index += 6) {
    await Promise.all(
      jobs.results.slice(index, index + 6).map(async (job) => {
        const dedupeKey = `duty:${job.assignmentId}:${job.removed ? "removed" : "assigned"}`;
        const notificationId = await operationalNotificationId(
          { orgId: job.orgId, dedupeKey },
          job.userId,
        );
        const finish = (status: "delivered" | "skipped") =>
          database
            .prepare(
              "UPDATE duty_notification_job SET status=?,lastAttemptAt=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND orgId=? AND status='pending'",
            )
            .bind(status, job.id, job.orgId)
            .run();
        try {
          if (
            await database
              .prepare(
                "SELECT 1 FROM notification WHERE orgId=? AND userId=? AND id=?",
              )
              .bind(job.orgId, job.userId, notificationId)
              .first()
          ) {
            await finish("delivered");
            return;
          }
          const state = await database
            .prepare(
              `SELECT
    EXISTS(SELECT 1 FROM member WHERE organizationId=? AND userId=?) AS memberActive,
    EXISTS(SELECT 1 FROM roster_assignment WHERE orgId=? AND id=? AND userId=?) AS sameAssignment,
    EXISTS(SELECT 1 FROM roster_assignment WHERE orgId=? AND weekStart=? AND kind=? AND roleId IS ? AND userId=?) AS reassigned`,
            )
            .bind(
              job.orgId,
              job.userId,
              job.orgId,
              job.assignmentId,
              job.userId,
              job.orgId,
              job.weekStart,
              job.kind,
              job.roleId,
              job.userId,
            )
            .first<{
              memberActive: number;
              sameAssignment: number;
              reassigned: number;
            }>();
          if (
            !state?.memberActive ||
            (job.removed ? state.reassigned : !state.sameAssignment)
          ) {
            await finish("skipped");
            skipped++;
            return;
          }
          await database
            .prepare(
              "UPDATE duty_notification_job SET lastAttemptAt=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND orgId=? AND status='pending'",
            )
            .bind(job.id, job.orgId)
            .run();
          await withOperationTimeout(
            notifyOperationalEvent({
              orgId: job.orgId,
              recipientIds: [job.userId],
              category: "schedule",
              type: "duty-assignment",
              title: job.removed
                ? "Your on-duty assignment changed"
                : "You’re on duty",
              message: `${job.roleName} · ${dutyDateRange(job.weekStart)}. ${job.removed ? "You are no longer assigned to this role." : "You have been assigned to this duty week."}`,
              actionUrl: `assignments?date=${job.weekStart}`,
              source: job.assignmentId,
              pushTag: `duty-${job.weekStart}-${job.kind}-${job.roleId ?? "pm"}`,
              dedupeKey,
              once: true,
            }),
            4_000,
            "Duty notification delivery timed out",
          );
          if (
            await database
              .prepare(
                "SELECT 1 FROM notification WHERE orgId=? AND userId=? AND id=?",
              )
              .bind(job.orgId, job.userId, notificationId)
              .first()
          ) {
            await finish("delivered");
            delivered++;
          }
        } catch (error) {
          console.error("[Duty notifications] Delivery remains pending", error);
        }
      }),
    );
  }
  return { delivered, skipped };
}
