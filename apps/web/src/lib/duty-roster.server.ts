import { notifyOperationalEvent } from "@/lib/operational-notifications.server";

export type DutySlot = { kind: "pm"; roleId: null; userId: string | null }
  | { kind: "tech"; roleId: string; userId: string | null };
type DutyChange = { id: string; userId: string };

export function dutyDateRange(weekStart: string) {
  const end = new Date(`${weekStart}T12:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 6);
  return `${weekStart} – ${end.toISOString().slice(0, 10)}`;
}

/** Call after authorization. Each slot is changed in one D1 transaction;
 * RETURNING reports actual changes, including under concurrent identical saves.
 * Unchanged assignments retain their IDs and never generate another alert. */
export async function saveDutySlots(database: D1Database, orgId: string, weekStart: string, slots: DutySlot[]) {
  const date = new Date(`${weekStart}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== weekStart) throw new Error("Invalid duty date");
  const roles = await database.prepare("SELECT id, name FROM roster_role WHERE orgId = ?")
    .bind(orgId).all<{ id: string; name: string }>();
  const names = new Map(roles.results.map((role) => [role.id, role.name]));
  const members = await database.prepare("SELECT userId FROM member WHERE organizationId = ?")
    .bind(orgId).all<{ userId: string }>();
  const memberIds = new Set(members.results.map((member) => member.userId));
  const keys = new Set<string>();
  for (const slot of slots) {
    const key = slot.kind === "pm" ? "pm" : slot.roleId;
    if (keys.has(key)) throw new Error("A duty role can only be assigned once");
    keys.add(key);
    if (slot.kind === "tech" && !names.has(slot.roleId)) throw new Error("Duty role not found");
    if (slot.userId && !memberIds.has(slot.userId)) throw new Error("Duty member not found");
  }
  if (!slots.length) return;
  const statements = slots.flatMap((slot) => [
    database.prepare(`DELETE FROM roster_assignment
      WHERE orgId = ? AND weekStart = ? AND kind = ? AND roleId IS ?
        AND (? IS NULL OR userId <> ?) RETURNING id, userId`)
      .bind(orgId, weekStart, slot.kind, slot.roleId, slot.userId, slot.userId),
    database.prepare(`INSERT INTO roster_assignment (id, orgId, weekStart, kind, roleId, userId)
      SELECT ?, ?, ?, ?, ?, ? WHERE ? IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM roster_assignment WHERE orgId = ? AND weekStart = ? AND kind = ? AND roleId IS ? AND userId = ?
      ) RETURNING id, userId`)
      .bind(crypto.randomUUID(), orgId, weekStart, slot.kind, slot.roleId, slot.userId, slot.userId,
        orgId, weekStart, slot.kind, slot.roleId, slot.userId),
  ]);
  const changes = await database.batch<DutyChange>(statements);
  for (const [index, slot] of slots.entries()) {
    const name = slot.kind === "pm" ? "Production Manager" : names.get(slot.roleId) ?? "Technical duty";
    for (const [offset, removed] of [[0, true], [1, false]] as const) {
      for (const change of changes[index * 2 + offset].results) {
        await notifyOperationalEvent({
          orgId, recipientIds: [change.userId], category: "schedule", type: "duty-assignment",
          title: removed ? "Your on-duty assignment changed" : "You’re on duty",
          message: `${name} · ${dutyDateRange(weekStart)}. ${removed ? "You are no longer assigned to this role." : "You have been assigned to this duty week."}`,
          actionUrl: `assignments?date=${weekStart}`, source: change.id,
          pushTag: `duty-${weekStart}-${slot.kind}-${slot.roleId ?? "pm"}`,
          dedupeKey: `duty:${change.id}:${removed ? "removed" : "assigned"}`, once: true,
        });
      }
    }
  }
}

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

interface ReminderDatabase {
  prepare(sql: string): { bind(...values: unknown[]): { all<T>(): Promise<{ results?: T[] }> } };
}

export async function createDueDutyReminders(database: ReminderDatabase, now = new Date()) {
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
