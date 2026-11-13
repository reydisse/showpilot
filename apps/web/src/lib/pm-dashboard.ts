import { getWorkspaceProfileForOrg } from "@/lib/workspace/profile.server";
/**
 * Production manager dashboard — data layer.
 *
 * Resolves *the next service*, not today. The PM's job is week-shaped;
 * scoping this page to `getTodayDateString()` is what made the old
 * version render three zeros six days a week.
 *
 * All derivation lives in `pm-dashboard-derive.ts`. This module only
 * fetches, scopes to orgId, and hands over a snapshot.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getPrisma } from "@/lib/db";
import { getD1 } from "@/lib/d1";
import { requestDatabase } from "@/lib/request-database.server";
import { rundownItemStorageKey } from "@/lib/rundown-item-storage.server";
import type { Permission } from "@/lib/app-permissions";
import { assertOrgPermission as assertEffectiveOrgPermission } from "@/lib/org-access";
import { idSchema, parseOrThrow, serviceDateSchema } from "@/lib/validation";
import { getTodayDateString } from "@/lib/utils";
import { readPhaseSettings } from "@/lib/service-phase";
import { getRundownStateForOrg, normalizeLegacyRundownItems } from "@/lib/rundown";
import {
  derivePmDashboard,
  type PmDashboardModel,
  type PmSnapshot,
  type SnapshotAssignment,
  type SnapshotOpenItem,
  type SnapshotOnFloorMember,
  type SnapshotRosterDuty,
  weekStartFor,
  type SnapshotRecentService,
  type SnapshotUpcomingService,
} from "@/lib/pm-dashboard-derive";
import type { RundownState } from "@/types/rundown";
import { partitionShowsAround, resolveRundownOpeningShow } from "@/lib/rundown-opening";

const RUNDOWN_ITEMS_PREFIX = "rundown-items:";
const UPCOMING_LIMIT = 3;
const NOTIFICATION_LIMIT = 8;
const RECENT_LIMIT = 4;
/**
 * Crew photos are stored as data URLs (the schema allows ~2MB each), so
 * they are only fetched for people actually checked in, and capped.
 * Selecting photoUrl across a whole roster would be tens of megabytes.
 */
const ON_FLOOR_PHOTO_LIMIT = 18;
const OPEN_ITEM_LIMIT = 6;

async function assertOrgPermission(orgId: string, permission: Permission) {
  await assertEffectiveOrgPermission(orgId, permission);
}

interface RundownDateRow {
  id: string;
  serviceDate: string;
  scheduledStartTime: Date | null;
  scheduledCallTime: Date | null;
  status: string;
  name: string;
  createdAt: Date;
}

/** Database errors propagate to the dashboard's retained-state retry boundary. */
async function loadRundownRows(orgId: string): Promise<RundownDateRow[]> {
  return getPrisma().rundown.findMany({
    where: { orgId },
    select: { id: true, serviceDate: true, scheduledStartTime: true, scheduledCallTime: true, status: true, name: true, createdAt: true },
    orderBy: [{ serviceDate: "asc" }, { scheduledStartTime: "asc" }, { createdAt: "asc" }],
  });
}

interface AssignmentRow {
  id: string;
  role: string;
  department: string;
  status: string;
  notes: string;
  responseNote: string;
  respondedAt: Date | null;
  crewMember: { name: string } | null;
}

/**
 * service_assignment and the incident lifecycle columns arrive in
 * migration 0012. The generated Prisma client is gitignored, so a
 * checkout that has not run `pnpm db:generate` will not have the
 * delegate — same defensive access `rundown.ts` uses for `rundown`.
 */
/**
 * The org's weekly on-duty roster. These tables (roster_role,
 * roster_assignment, migration 0005) are raw D1 and not in the Prisma
 * client, so they are queried directly — the same way kiosk-admin.ts
 * and kiosk-api.ts do.
 *
 * The TM slot is whichever roster_role carries the code "tm"; the PM is
 * the row with kind = 'pm'.
 */
export async function loadRosterDuty(
  orgId: string,
  serviceDate: string,
): Promise<SnapshotRosterDuty> {
  const weekStart = weekStartFor(serviceDate);
  const rows =
    (
      await getD1()
        .prepare(
          `SELECT a.kind AS kind, r.code AS code, u.id AS userId, u.name AS name
             FROM roster_assignment a
             JOIN user u ON u.id = a.userId
             JOIN member m ON m.organizationId = a.orgId AND m.userId = a.userId
             LEFT JOIN roster_role r ON r.id = a.roleId AND r.orgId = a.orgId
            WHERE a.orgId = ? AND a.weekStart = ?`,
        )
        .bind(orgId, weekStart)
        .all<{
          kind: string;
          code: string | null;
          userId: string;
          name: string;
        }>()
    ).results ?? [];

  const duty: SnapshotRosterDuty = { weekStart, pm: null, tm: null };
  for (const row of rows) {
    const person = { id: row.userId, name: row.name };
    if (row.kind === "pm") duty.pm = person;
    else if ((row.code ?? "").toLowerCase() === "tm") duty.tm = person;
  }
  return duty;
}

/** Has this org ever assigned anyone to anything? */
async function countAllAssignments(orgId: string): Promise<number> {
  return getPrisma().serviceAssignment.count({ where: { orgId } });
}

async function loadAssignments(
  orgId: string,
  serviceDate: string,
  showId?: string,
): Promise<AssignmentRow[]> {
  return getPrisma().serviceAssignment.findMany({
    where: { orgId, ...(showId ? { showId } : { serviceDate }) },
    orderBy: [{ department: "asc" }, { role: "asc" }],
    select: {
      id: true,
      role: true,
      department: true,
      status: true,
      notes: true,
      responseNote: true,
      respondedAt: true,
      crewMember: { select: { name: true } },
    },
  });
}

interface OpenIncidentRow {
  id: string;
  serviceDate: string;
  category: string;
  severity: string;
  description: string;
}

/** Incidents left open on any service before the one on screen. */
async function loadOpenItems(
  orgId: string,
  serviceDate: string,
  previousShowIds: string[],
): Promise<OpenIncidentRow[]> {
  const previous = previousShowIds.length ? `showId IN (${previousShowIds.map(() => "?").join(",")}) OR ` : "";
  const { results } = await getD1().prepare(`SELECT id,serviceDate,category,severity,description FROM incident
    WHERE orgId=? AND (${previous}(showId IS NULL AND serviceDate<?)) AND status='open'
    ORDER BY CASE lower(severity) WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC, timestamp DESC LIMIT ?`)
    .bind(orgId, ...previousShowIds, serviceDate, OPEN_ITEM_LIMIT + 1).all<OpenIncidentRow>();
  return results;
}

/** Item counts per service date, read straight from the stored JSON. */
interface ItemSummary {
  itemCount: number;
  missingDuration: number;
  missingOwner: number;
  plannedMs: number;
}

const EMPTY_SUMMARY: ItemSummary = {
  itemCount: 0,
  missingDuration: 0,
  missingOwner: 0,
  plannedMs: 0,
};

function summarizeItems(raw: string): ItemSummary {
  try {
    const parsed = z.array(z.record(z.string(), z.unknown())).parse(JSON.parse(raw));
    // Section bands have no duration and no owner on purpose; counting
    // them would report a planned service as full of holes.
    const items = normalizeLegacyRundownItems(parsed).filter((i) => i.type !== "header");
    return {
      itemCount: items.length,
      missingDuration: items.filter((i) => !i.duration || i.duration <= 0)
        .length,
      missingOwner: items.filter(
        (i) => !i.assignee || !String(i.assignee).trim(),
      ).length,
      plannedMs: items.reduce(
        (sum, i) => sum + Math.max(0, Number(i.duration) || 0),
        0,
      ),
    };
  } catch {
    throw new Error("Saved rundown items could not be read. Open the rundown to review them, then retry the dashboard.");
  }
}

/**
 * The service the dashboard should open on: the nearest date at or after
 * today.
 *
 * When nothing is scheduled ahead we deliberately do NOT fall back to the
 * most recent past service. Opening on a service from three months ago,
 * rendered identically to an upcoming one, is a mystery state — the PM
 * cannot tell they are looking at history. Default to today instead, which
 * produces the plan-next view. Past services stay reachable in the picker.
 */
export function resolveServiceDate(dates: string[], today: string): string {
  if (dates.length === 0) return today;
  return [...new Set(dates)].sort().find((d) => d >= today) ?? today;
}

/** Most recent service strictly before today, for the plan-next prompt. */
export function resolveLastServiceDate(
  dates: string[],
  today: string,
): string | null {
  const past = [...new Set(dates)].sort().filter((d) => d < today);
  return past.length > 0 ? past[past.length - 1] : null;
}

export interface PmDashboardResult {
  model: PmDashboardModel;
  /** Initial relay seed for the PM's transport controls. */
  rundownState: RundownState;
  orgId: string;
  showId: string | null;
  shows: Array<{
    id: string;
    serviceDate: string;
    name: string;
    scheduledStartTime: string | null;
  }>;
  /** Every service date the org has, newest first — powers the picker. */
  serviceDates: string[];
  orgTimezone: string;
}

export const getPmDashboard = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({ orgId: idSchema, serviceDate: serviceDateSchema.optional(), showId: idSchema.optional() }),
      data,
    ),
  )
  .handler(async ({ data }): Promise<PmDashboardResult> => {
    await assertOrgPermission(data.orgId, "dashboard:pm");

    const prisma = getPrisma();
    const orgId = data.orgId;

    const [settingRows, rundownRows, itemRows] = await Promise.all([
      prisma.appSetting.findMany({
        where: { orgId },
        select: { key: true, value: true },
      }),
      loadRundownRows(orgId),
      requestDatabase.prepare(`SELECT showId, serviceDate,
        SUM(CASE WHEN type != 'header' THEN 1 ELSE 0 END) AS itemCount,
        SUM(CASE WHEN type != 'header' AND duration <= 0 THEN 1 ELSE 0 END) AS missingDuration,
        SUM(CASE WHEN type != 'header' AND TRIM(assignee) = '' THEN 1 ELSE 0 END) AS missingOwner,
        SUM(CASE WHEN type != 'header' THEN MAX(0, duration) ELSE 0 END) AS plannedMs
        FROM rundown_item WHERE orgId = ? GROUP BY showId, serviceDate`).bind(orgId).all<ItemSummary & { showId: string | null; serviceDate: string }>(),
    ]);

    const settings: Record<string, string> = {};
    const itemSummaries = new Map<string, ItemSummary>();
    for (const row of settingRows) {
      if (row.key.startsWith(RUNDOWN_ITEMS_PREFIX)) {
        itemSummaries.set(
          row.key.slice(RUNDOWN_ITEMS_PREFIX.length),
          summarizeItems(row.value),
        );
      } else {
        settings[row.key] = row.value;
      }
    }
    for (const row of itemRows.results) itemSummaries.set(row.showId ?? row.serviceDate, row);

    const orgTimezone = settings["org-timezone"] ?? "";
    const today = getTodayDateString(orgTimezone);
    const { callLeadMinutes, serviceWindowMinutes, serviceWindowConfigured } =
      readPhaseSettings(settings);

    const firstShowByDate = new Map<string, RundownDateRow>();
    for (const row of rundownRows) {
      if (!firstShowByDate.has(row.serviceDate)) firstShowByDate.set(row.serviceDate, row);
    }
    const summaryForShow = (show: RundownDateRow): ItemSummary =>
      itemSummaries.get(show.id) ??
      (settings[rundownItemStorageKey(show.id)] === "rows-v1" ? EMPTY_SUMMARY : firstShowByDate.get(show.serviceDate)?.id === show.id
        ? itemSummaries.get(show.serviceDate)
        : undefined) ??
      EMPTY_SUMMARY;

    const allDates = [
      ...new Set([
        ...[...itemSummaries.keys()].filter((key) => /^\d{4}-\d{2}-\d{2}$/.test(key)),
        ...firstShowByDate.keys(),
      ]),
    ].sort();
    const selectedShow = resolveRundownOpeningShow({
      shows: rundownRows,
      today,
      requestedShowId: data.showId,
      requestedServiceDate: data.serviceDate,
      activeShowId: settings["active-show-id"],
      activeServiceDate: settings["active-service-date"],
    });
    if (data.showId && !selectedShow) throw new Error("Show not found");
    const serviceDate = selectedShow?.serviceDate ?? data.serviceDate ?? resolveServiceDate(allDates, today);
    const showId = selectedShow?.id;
    const lastServiceDate = resolveLastServiceDate(allDates, today);
    const timeline = showId
      ? partitionShowsAround(rundownRows, showId)
      : {
          previous: rundownRows.filter((show) => show.serviceDate < serviceDate).reverse(),
          upcoming: rundownRows.filter((show) => show.serviceDate > serviceDate),
        };
    const recentShows = timeline.previous.slice(0, RECENT_LIMIT);
    const upcomingShows = timeline.upcoming.slice(0, UPCOMING_LIMIT);
    const recentShowIds = recentShows.map((show) => show.id);

    // Every read below selects only the columns the dashboard uses. That
    // keeps the payload small and stops the page inheriting a failure from
    // a column it never reads.
    // History and upcoming cards use exact show IDs. Calendar dates are not
    // unique because a venue can run several shows on the same day.

    const [
      rundownState,
      templates,
      entries,
      incidents,
      equipment,
      crew,
      destinations,
      liveInputs,
      notifications,
      assignments,
      assignmentsEver,
      rosterDuty,
      orgMemberRows,
      onFloorRows,
      onFloorTotal,
      openItems,
      recentItems,
      recentIncidents,
    ] = await Promise.all([
      getRundownStateForOrg({ orgId, serviceDate, showId }),
      prisma.checklistTemplate.findMany({
        where: { orgId },
        orderBy: { sortOrder: "asc" },
        select: { id: true, label: true, category: true },
      }),
      prisma.checklistEntry.findMany({
        where: { orgId, ...(showId ? { showId } : { serviceDate }) },
        select: { templateId: true, checked: true },
      }),
      prisma.incident.findMany({
        where: { orgId, ...(showId ? { OR: [{ showId }, { showId: null, serviceDate }] } : { serviceDate }) },
        orderBy: { timestamp: "desc" },
        select: {
          id: true,
          category: true,
          severity: true,
          description: true,
          reportedBy: true,
          status: true,
        },
      }),
      prisma.equipment.findMany({
        where: { orgId },
        select: {
          id: true,
          name: true,
          category: true,
          status: true,
          nextService: true,
        },
      }),
      prisma.crewMember.findMany({
        where: { orgId },
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          role: true,
          isOnline: true,
          lastCheckIn: true,
        },
      }),
      prisma.streamDestination.findMany({
        where: { orgId },
        select: { id: true, name: true, platform: true, enabled: true },
      }),
      prisma.liveInput.findMany({
        where: { orgId },
        select: { id: true, name: true, status: true },
      }),
      prisma.notification.findMany({
        where: {
          orgId,
          dismissed: false,
          target: { in: ["all", "production-manager"] },
        },
        orderBy: { createdAt: "desc" },
        take: NOTIFICATION_LIMIT,
        select: { id: true, title: true, message: true, severity: true },
      }),
      loadAssignments(orgId, serviceDate, showId),
      countAllAssignments(orgId),
      loadRosterDuty(orgId, serviceDate),
      prisma.member.findMany({
        where: { organizationId: orgId },
        select: { user: { select: { id: true, name: true } } },
      }),
      prisma.crewMember.findMany({
        where: { orgId, isOnline: true },
        orderBy: { lastCheckIn: "desc" },
        take: ON_FLOOR_PHOTO_LIMIT,
        select: {
          id: true,
          name: true,
          role: true,
          photoUrl: true,
          lastCheckIn: true,
        },
      }),
      prisma.crewMember.count({ where: { orgId, isOnline: true } }),
      loadOpenItems(orgId, serviceDate, timeline.previous.map((show) => show.id)),
      recentShowIds.length === 0
        ? Promise.resolve([])
        : prisma.rundownItem.findMany({
            where: { orgId, showId: { in: recentShowIds } },
            select: { showId: true, actualStart: true, actualEnd: true },
          }),
      recentShowIds.length === 0
        ? Promise.resolve([])
        : prisma.incident.findMany({
            where: { orgId, showId: { in: recentShowIds } },
            select: { showId: true },
          }),
    ]);

    // Actual runtime is the span from the first item that started to the
    // last that finished. Null until a service has actually been run with
    // the timer, which only became possible once 0011 added the columns.
    const actualByShow = new Map<string, { first: number; last: number }>();
    for (const row of recentItems) {
      if (!row.showId) continue;
      const start = row.actualStart ? row.actualStart.getTime() : null;
      const end = row.actualEnd ? row.actualEnd.getTime() : null;
      if (start === null && end === null) continue;
      const current = actualByShow.get(row.showId);
      const first = Math.min(
        current?.first ?? Number.POSITIVE_INFINITY,
        start ?? end ?? 0,
      );
      const last = Math.max(
        current?.last ?? Number.NEGATIVE_INFINITY,
        end ?? start ?? 0,
      );
      actualByShow.set(row.showId, { first, last });
    }
    const incidentsByShow = new Map<string, number>();
    for (const row of recentIncidents) {
      if (!row.showId) continue;
      incidentsByShow.set(row.showId, (incidentsByShow.get(row.showId) ?? 0) + 1);
    }

    const recent: SnapshotRecentService[] = recentShows.map((show) => {
      const span = actualByShow.get(show.id);
      return {
        showId: show.id,
        serviceDate: show.serviceDate,
        name: show.name,
        scheduledStartTime: show.scheduledStartTime?.toISOString() ?? null,
        plannedMs: summaryForShow(show).plannedMs,
        actualMs:
          span && Number.isFinite(span.first) ? span.last - span.first : null,
        incidentCount: incidentsByShow.get(show.id) ?? 0,
      };
    });

    const checkedByTemplate = new Map(
      entries.map((e) => [e.templateId, e.checked]),
    );

    const upcoming: SnapshotUpcomingService[] = upcomingShows
      .map((show) => {
        const summary = summaryForShow(show);
        return {
          showId: show.id,
          serviceDate: show.serviceDate,
          scheduledStartTime: show.scheduledStartTime
            ? show.scheduledStartTime.toISOString()
            : null,
          name: show.name,
          itemCount: summary.itemCount,
          missingDuration: summary.missingDuration,
          missingOwner: summary.missingOwner,
        };
      });

    const snapshot: PmSnapshot = {
      showId: showId ?? null,
      serviceDate,
      serviceName: selectedShow?.name ?? firstShowByDate.get(serviceDate)?.name ?? "",
      now: Date.now(),
      callLeadMinutes,
      serviceWindowMinutes,
      serviceWindowConfigured,
      lastServiceDate,
      rundown: rundownState.meta
        ? {
            scheduledStartTime: rundownState.meta.scheduledStartTime ?? null,
            scheduledCallTime: rundownState.meta.scheduledCallTime ?? null,
            status: rundownState.meta.status,
          }
        : null,
      items: rundownState.items,
      checklist: templates.map((t) => ({
        id: t.id,
        label: t.label,
        category: t.category,
        checked: checkedByTemplate.get(t.id) ?? false,
      })),
      incidents: incidents.map((i) => ({
        id: i.id,
        category: i.category,
        severity: i.severity,
        description: i.description,
        reportedBy: i.reportedBy,
        status: i.status,
      })),
      equipment: equipment.map((e) => ({
        id: e.id,
        name: e.name,
        category: e.category,
        status: e.status,
        nextService: e.nextService ? e.nextService.toISOString() : null,
      })),
      crew: crew.map((m) => ({
        id: m.id,
        name: m.name,
        role: m.role,
        isOnline: m.isOnline,
        lastCheckIn: m.lastCheckIn ? m.lastCheckIn.toISOString() : null,
      })),
      streamDestinations: destinations.map((d) => ({
        id: d.id,
        name: d.name,
        platform: d.platform,
        enabled: d.enabled,
      })),
      liveInputs: liveInputs.map((i) => ({
        id: i.id,
        name: i.name,
        status: i.status,
      })),
      notifications: notifications.map((n) => ({
        id: n.id,
        title: n.title,
        message: n.message,
        severity: n.severity,
      })),
      upcoming,
      assignments: assignments.map<SnapshotAssignment>((a) => ({
        id: a.id,
        role: a.role,
        department: a.department,
        crewMemberName: a.crewMember?.name ?? null,
        status: a.status,
        notes: a.notes,
        responseNote: a.responseNote,
        respondedAt: a.respondedAt?.toISOString() ?? null,
      })),
      openItemsTruncated: openItems.length > OPEN_ITEM_LIMIT,
      openItems: openItems.slice(0, OPEN_ITEM_LIMIT).map<SnapshotOpenItem>((i) => ({
        id: i.id,
        serviceDate: i.serviceDate,
        category: i.category,
        severity: i.severity,
        description: i.description,
      })),
      recent,
      onFloor: onFloorRows.map<SnapshotOnFloorMember>((m) => ({
        id: m.id,
        name: m.name,
        role: m.role,
        photoUrl: m.photoUrl,
        lastCheckIn: m.lastCheckIn ? m.lastCheckIn.toISOString() : null,
      })),
      onFloorTotal,
      schedulingInUse: assignmentsEver > 0,
      rosterDuty,
      orgMembers: orgMemberRows
        .map((row) => ({ id: row.user.id, name: row.user.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };

    return {
      model: derivePmDashboard(
        snapshot,
        (await getWorkspaceProfileForOrg(data.orgId)).terms,
      ),
      rundownState,
      orgId,
      showId: showId ?? null,
      shows: rundownRows.map((show) => ({
        id: show.id,
        serviceDate: show.serviceDate,
        name: show.name,
        scheduledStartTime: show.scheduledStartTime?.toISOString() ?? null,
      })),
      serviceDates: [...allDates].reverse(),
      orgTimezone,
    };
  });
