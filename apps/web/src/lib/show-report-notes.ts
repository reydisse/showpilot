import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getD1 } from "@/lib/d1";
import { getRequestOrgAccess } from "@/lib/org-access";
import { hasEffectivePermission } from "@/lib/permissions";
import { idSchema, parseOrThrow } from "@/lib/validation";

export type ShowReportLane = "pm" | "tm";

export interface ShowReportNote {
  id: string;
  showId: string;
  userId: string;
  authorName: string;
  role: ShowReportLane;
  summary: string;
  wins: string;
  issues: string;
  followUps: string;
  createdAt: string;
  updatedAt: string;
}

const laneSchema = z.enum(["pm", "tm"]);
const noteField = z.string().trim().max(4_000).default("");
const noteWriteSchema = z.object({
  orgId: idSchema,
  showId: idSchema,
  role: laneSchema,
  summary: noteField,
  wins: noteField,
  issues: noteField,
  followUps: noteField,
});

function mayWriteLane(
  role: string,
  grantedPermissions: readonly import("@/lib/permissions").Permission[],
  lane: ShowReportLane,
) {
  return hasEffectivePermission(
    role,
    grantedPermissions,
    lane === "pm" ? "dashboard:pm" : "dashboard:tm",
  );
}

export const getShowReportNotes = createServerFn({ method: "GET" })
  .inputValidator((value: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, showId: idSchema }), value),
  )
  .handler(async ({ data }): Promise<{
    notes: ShowReportNote[];
    writableLanes: ShowReportLane[];
    currentUserId: string;
  }> => {
    const request = await getRequestOrgAccess(data.orgId);
    const canRead = hasEffectivePermission(
      request.access.role,
      request.access.grantedPermissions,
      "schedule:view",
    );
    if (!canRead) throw new Error("Forbidden");
    const show = await getD1().prepare(
      "SELECT id FROM rundown WHERE id = ? AND orgId = ? LIMIT 1",
    ).bind(data.showId, data.orgId).first<{ id: string }>();
    if (!show) throw new Error("Show not found");
    const rows = await getD1().prepare(
      `SELECT id, showId, userId, authorName, role, summary, wins, issues,
              followUps, createdAt, updatedAt
         FROM show_report_note
        WHERE orgId = ? AND showId = ?
        ORDER BY CASE role WHEN 'pm' THEN 0 ELSE 1 END, updatedAt ASC`,
    ).bind(data.orgId, data.showId).all<ShowReportNote>();
    const writableLanes = (["pm", "tm"] as const).filter((lane) =>
      mayWriteLane(request.access.role, request.access.grantedPermissions, lane),
    );
    return {
      notes: rows.results ?? [],
      writableLanes,
      currentUserId: request.user.id,
    };
  });

export const saveShowReportNote = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) => parseOrThrow(noteWriteSchema, value))
  .handler(async ({ data }): Promise<ShowReportNote> => {
    const request = await getRequestOrgAccess(data.orgId);
    if (!mayWriteLane(request.access.role, request.access.grantedPermissions, data.role)) {
      throw new Error(`You do not have ${data.role === "pm" ? "Production" : "Technical"} Manager report access.`);
    }
    const show = await getD1().prepare(
      "SELECT id FROM rundown WHERE id = ? AND orgId = ? LIMIT 1",
    ).bind(data.showId, data.orgId).first<{ id: string }>();
    if (!show) throw new Error("Show not found");

    const id = crypto.randomUUID();
    await getD1().prepare(
      `INSERT INTO show_report_note
         (id, orgId, showId, userId, authorName, role, summary, wins, issues,
          followUps, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(orgId, showId, userId) DO UPDATE SET
         authorName = excluded.authorName,
         role = excluded.role,
         summary = excluded.summary,
         wins = excluded.wins,
         issues = excluded.issues,
         followUps = excluded.followUps,
         updatedAt = CURRENT_TIMESTAMP`,
    ).bind(
      id,
      data.orgId,
      data.showId,
      request.user.id,
      request.user.name,
      data.role,
      data.summary,
      data.wins,
      data.issues,
      data.followUps,
    ).run();
    const note = await getD1().prepare(
      `SELECT id, showId, userId, authorName, role, summary, wins, issues,
              followUps, createdAt, updatedAt
         FROM show_report_note
        WHERE orgId = ? AND showId = ? AND userId = ? LIMIT 1`,
    ).bind(data.orgId, data.showId, request.user.id).first<ShowReportNote>();
    if (!note) throw new Error("The report note did not save.");
    return note;
  });

interface ReminderDatabase {
  prepare(sql: string): {
    bind(...params: unknown[]): {
      all<T>(): Promise<{ results?: T[] }>;
      run(): Promise<{ success?: boolean; meta?: { changes?: number } }>;
    };
  };
}

interface ReminderCandidate {
  orgId: string;
  showId: string;
  showName: string;
  serviceDate: string;
  scheduledStartTime: string;
  plannedDurationMs: number;
  reminderHours: string | null;
  userId: string;
}

/**
 * Enqueue each PM/TM reminder once. This is called by the existing five-minute
 * Worker cron, so reminder delivery does not depend on someone opening the app.
 */
export async function createDuePostShowReminders(
  database: ReminderDatabase,
  now = new Date(),
): Promise<{ created: number }> {
  const candidates = await database.prepare(
    `SELECT r.orgId, r.id AS showId, r.name AS showName, r.serviceDate,
            r.scheduledStartTime,
            COALESCE(SUM(CASE WHEN ri.type <> 'header' THEN ri.duration ELSE 0 END), 0) AS plannedDurationMs,
            reminder.value AS reminderHours,
            m.userId
       FROM rundown r
       JOIN member m ON m.organizationId = r.orgId AND lower(m.role) IN ('pm', 'tm')
       LEFT JOIN rundown_item ri ON ri.orgId = r.orgId AND ri.showId = r.id
       LEFT JOIN app_setting reminder ON reminder.orgId = r.orgId AND reminder.key = 'post-show-reminder-hours'
       LEFT JOIN show_report_note note ON note.orgId = r.orgId AND note.showId = r.id AND note.userId = m.userId
      WHERE r.scheduledStartTime IS NOT NULL
        AND r.scheduledStartTime >= datetime('now', '-30 days')
        AND r.scheduledStartTime <= datetime('now')
        AND note.id IS NULL
      GROUP BY r.orgId, r.id, m.userId
      ORDER BY r.scheduledStartTime ASC
      LIMIT 500`,
  ).bind().all<ReminderCandidate>();

  let created = 0;
  for (const candidate of candidates.results ?? []) {
    const reminderHours = Math.min(168, Math.max(1, Number(candidate.reminderHours ?? "24") || 24));
    const durationMs = candidate.plannedDurationMs > 0 ? candidate.plannedDurationMs : 4 * 60 * 60 * 1_000;
    const dueAt = new Date(candidate.scheduledStartTime).getTime() + durationMs + reminderHours * 60 * 60 * 1_000;
    if (!Number.isFinite(dueAt) || dueAt > now.getTime()) continue;
    const insert = await database.prepare(
      `INSERT INTO show_report_reminder (id, orgId, showId, userId, createdAt)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(orgId, showId, userId) DO NOTHING`,
    ).bind(crypto.randomUUID(), candidate.orgId, candidate.showId, candidate.userId).run();
    if (insert.success === false || insert.meta?.changes !== 1) continue;
    created += 1;
    const { notifyOperationalEvent } = await import("@/lib/operational-notifications.server");
    await notifyOperationalEvent({
      orgId: candidate.orgId,
      recipientIds: [candidate.userId],
      type: "post-show-notes",
      title: "Add your post-show notes",
      message: `Capture what worked, what changed, and what needs follow-up for ${candidate.showName || candidate.serviceDate}.`,
      actionUrl: `reports?date=${encodeURIComponent(candidate.serviceDate)}&show=${encodeURIComponent(candidate.showId)}`,
      source: candidate.showId,
      pushTag: `post-show-notes-${candidate.showId}`,
      dedupeKey: `post-show-notes:${candidate.showId}`,
    });
  }
  return { created };
}
