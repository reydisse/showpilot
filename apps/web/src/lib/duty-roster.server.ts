import { dutyDateRange, flushDutyNotifications } from "./duty-notification-jobs.server";
import type { DutyDatabase } from "./duty-roster-storage.server";
import { notifyOperationalEvent } from "@/lib/operational-notifications.server";

/** 09:00 on the day before duty begins, in the organization's time zone.
 * The rest of that local day is a catch-up window if a cron tick is missed. */
export function isDutyReminderDue(weekStart: string, timeZone: string, now: Date) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
    }).formatToParts(now);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
    const tomorrow = new Date(`${part("year")}-${part("month")}-${part("day")}T12:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    return Number(part("hour")) >= 9 && tomorrow.toISOString().slice(0, 10) === weekStart;
  } catch {
    return false;
  }
}

export async function createDueDutyReminders(database: DutyDatabase, now = new Date()) {
  await flushDutyNotifications(database);
  const start = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  const end = new Date(now.getTime() + 2 * 86_400_000).toISOString().slice(0, 10);
  const candidates = await database.prepare(`
    SELECT a.id, a.orgId, a.userId, a.weekStart,
      CASE WHEN a.kind = 'pm' THEN 'Production Manager' ELSE r.name END AS roleName,
      COALESCE(NULLIF(tz.value, ''), 'Africa/Accra') AS timeZone
    FROM roster_assignment a
    JOIN member m ON m.organizationId = a.orgId AND m.userId = a.userId
    LEFT JOIN roster_role r ON r.orgId = a.orgId AND r.id = a.roleId
    LEFT JOIN app_setting tz ON tz.orgId = a.orgId AND tz.key = 'org-timezone'
    WHERE a.weekStart BETWEEN ? AND ?
      AND NOT EXISTS(SELECT 1 FROM app_setting WHERE orgId=a.orgId AND key='organization-deleting')
  `).bind(start, end).all<{ id: string; orgId: string; userId: string; weekStart: string; roleName: string; timeZone: string }>();
  let created = 0;
  for (const row of candidates.results ?? []) {
    if (!isDutyReminderDue(row.weekStart, row.timeZone, now)) continue;
    const delivery = await notifyOperationalEvent({
      orgId: row.orgId, recipientIds: [row.userId], category: "schedule", type: "duty-reminder",
      title: "Your duty week starts tomorrow",
      message: `${row.roleName || "Technical duty"} · ${dutyDateRange(row.weekStart)}. Review your on-duty assignment before the week begins.`,
      actionUrl: `assignments?date=${row.weekStart}`, source: row.id, pushTag: `duty-reminder-${row.id}`,
      dedupeKey: `duty-reminder:${row.id}`, once: true,
    });
    created += delivery.notified;
  }
  return { created };
}
