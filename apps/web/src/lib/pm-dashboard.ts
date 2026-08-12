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
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { getPrisma } from "@/lib/db";
import { getD1 } from "@/lib/d1";
import { hasAnyPermission, type Permission } from "@/lib/app-permissions";
import { idSchema, parseOrThrow, serviceDateSchema } from "@/lib/validation";
import { getTodayDateString } from "@/lib/utils";
import { readPhaseSettings } from "@/lib/service-phase";
import { getRundownStateForOrg } from "@/lib/rundown";
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
import { isHeaderItem } from "@/types/rundown";
import type { RundownItem } from "@/types/rundown";

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

async function getOrgMemberRole(orgId: string) {
  const { getAuth } = await import("@/lib/auth");
  const auth = getAuth();
  const headers = getRequestHeaders();
  const session = await auth.api.getSession({ headers });
  if (!session) throw new Error("Unauthorized");

  const prisma = getPrisma();
  const member = await prisma.member.findFirst({
    where: { organizationId: orgId, userId: session.user.id },
    select: { role: true },
  });
  if (!member) throw new Error("Forbidden");

  return member.role ?? "member";
}

async function assertOrgPermission(orgId: string, permission: Permission) {
  const role = await getOrgMemberRole(orgId);
  if (!hasAnyPermission(role, [permission])) throw new Error("Forbidden");
}

interface RundownDateRow {
  serviceDate: string;
  scheduledStartTime: Date | null;
  status: string;
  name: string;
}

/**
 * Rundown rows carry the scheduled start time. The delegate is accessed
 * defensively for the same reason `rundown.ts` does it — older generated
 * clients in some environments predate the model.
 */
async function loadRundownRows(orgId: string): Promise<RundownDateRow[]> {
  const prisma = getPrisma() as unknown as {
    rundown?: {
      findMany(args: {
        where: { orgId: string };
        select: {
          serviceDate: true;
          scheduledStartTime: true;
          status: true;
          name: true;
        };
      }): Promise<RundownDateRow[]>;
    };
  };
  if (!prisma.rundown) return [];
  try {
    return await prisma.rundown.findMany({
      where: { orgId },
      select: { serviceDate: true, scheduledStartTime: true, status: true, name: true },
    });
  } catch {
    return [];
  }
}

interface AssignmentRow {
  id: string;
  role: string;
  status: string;
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
export async function loadRosterDuty(orgId: string, serviceDate: string): Promise<SnapshotRosterDuty> {
  const weekStart = weekStartFor(serviceDate);
  const empty: SnapshotRosterDuty = { weekStart, pm: null, tm: null };
  try {
    const rows =
      (
        await getD1()
          .prepare(
            `SELECT a.kind AS kind, r.code AS code, u.id AS userId, u.name AS name
               FROM roster_assignment a
               JOIN user u ON u.id = a.userId
               LEFT JOIN roster_role r ON r.id = a.roleId
              WHERE a.orgId = ? AND a.weekStart = ?`,
          )
          .bind(orgId, weekStart)
          .all<{ kind: string; code: string | null; userId: string; name: string }>()
      ).results ?? [];

    const duty: SnapshotRosterDuty = { weekStart, pm: null, tm: null };
    for (const row of rows) {
      const person = { id: row.userId, name: row.name };
      if (row.kind === "pm") duty.pm = person;
      else if ((row.code ?? "").toLowerCase() === "tm") duty.tm = person;
    }
    return duty;
  } catch {
    // Org predates migration 0005, or the roster tables are absent.
    return empty;
  }
}

/** Has this org ever assigned anyone to anything? */
async function countAllAssignments(orgId: string): Promise<number> {
  const prisma = getPrisma() as unknown as {
    serviceAssignment?: { count(args: unknown): Promise<number> };
  };
  if (!prisma.serviceAssignment) return 0;
  try {
    return await prisma.serviceAssignment.count({ where: { orgId } });
  } catch {
    return 0;
  }
}

async function loadAssignments(orgId: string, serviceDate: string): Promise<AssignmentRow[]> {
  const prisma = getPrisma() as unknown as {
    serviceAssignment?: {
      findMany(args: unknown): Promise<AssignmentRow[]>;
    };
  };
  if (!prisma.serviceAssignment) return [];
  try {
    return await prisma.serviceAssignment.findMany({
      where: { orgId, serviceDate },
      orderBy: { role: "asc" },
      select: {
        id: true,
        role: true,
        status: true,
        crewMember: { select: { name: true } },
      },
    });
  } catch {
    return [];
  }
}

interface OpenIncidentRow {
  id: string;
  serviceDate: string;
  category: string;
  severity: string;
  description: string;
}

/** Incidents left open on any service before the one on screen. */
async function loadOpenItems(orgId: string, serviceDate: string): Promise<OpenIncidentRow[]> {
  const prisma = getPrisma();
  try {
    return (await prisma.incident.findMany({
      where: {
        orgId,
        serviceDate: { lt: serviceDate },
        status: "open",
      } as never,
      orderBy: { timestamp: "desc" },
      take: OPEN_ITEM_LIMIT,
      select: {
        id: true,
        serviceDate: true,
        category: true,
        severity: true,
        description: true,
      },
    })) as OpenIncidentRow[];
  } catch {
    // Pre-0012 database: the status column does not exist yet.
    return [];
  }
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
    const parsed = JSON.parse(raw) as RundownItem[];
    if (!Array.isArray(parsed)) return EMPTY_SUMMARY;
    // Section bands have no duration and no owner on purpose; counting
    // them would report a planned service as full of holes.
    const items = parsed.filter((i) => !isHeaderItem(i));
    return {
      itemCount: items.length,
      missingDuration: items.filter((i) => !i.duration || i.duration <= 0).length,
      missingOwner: items.filter((i) => !i.assignee || !String(i.assignee).trim()).length,
      plannedMs: items.reduce((sum, i) => sum + Math.max(0, Number(i.duration) || 0), 0),
    };
  } catch {
    return EMPTY_SUMMARY;
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
export function resolveLastServiceDate(dates: string[], today: string): string | null {
  const past = [...new Set(dates)].sort().filter((d) => d < today);
  return past.length > 0 ? past[past.length - 1] : null;
}

export interface PmDashboardResult {
  model: PmDashboardModel;
  orgId: string;
  /** Every service date the org has, newest first — powers the picker. */
  serviceDates: string[];
  orgTimezone: string;
}

export const getPmDashboard = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({ orgId: idSchema, serviceDate: serviceDateSchema.optional() }),
      data,
    ),
  )
  .handler(async ({ data }): Promise<PmDashboardResult> => {
    await assertOrgPermission(data.orgId, "dashboard:pm");

    const prisma = getPrisma();
    const orgId = data.orgId;

    const [settingRows, rundownRows] = await Promise.all([
      prisma.appSetting.findMany({ where: { orgId }, select: { key: true, value: true } }),
      loadRundownRows(orgId),
    ]);

    const settings: Record<string, string> = {};
    const itemSummaries = new Map<string, ItemSummary>();
    for (const row of settingRows) {
      if (row.key.startsWith(RUNDOWN_ITEMS_PREFIX)) {
        itemSummaries.set(row.key.slice(RUNDOWN_ITEMS_PREFIX.length), summarizeItems(row.value));
      } else {
        settings[row.key] = row.value;
      }
    }

    const orgTimezone = settings["org-timezone"] ?? "";
    const today = getTodayDateString(orgTimezone);
    const { callLeadMinutes, serviceWindowMinutes, serviceWindowConfigured } =
      readPhaseSettings(settings);

    const startTimes = new Map<string, RundownDateRow>();
    for (const row of rundownRows) startTimes.set(row.serviceDate, row);

    const allDates = [...new Set([...itemSummaries.keys(), ...startTimes.keys()])].sort();
    const serviceDate = data.serviceDate ?? resolveServiceDate(allDates, today);
    const lastServiceDate = resolveLastServiceDate(allDates, today);

    // Every read below selects only the columns the dashboard uses. That
    // keeps the payload small and stops the page inheriting a failure from
    // a column it never reads.
    // The four most recent services before this one, for the history card.
    const recentDates = allDates.filter((d) => d < serviceDate).slice(-RECENT_LIMIT).reverse();

    const [rundownState, templates, entries, incidents, equipment, crew, destinations, liveInputs, notifications, assignments, assignmentsEver, rosterDuty, orgMemberRows, onFloorRows, onFloorTotal, openItems, recentItems, recentIncidents] =
      await Promise.all([
        getRundownStateForOrg({ orgId, serviceDate }),
        prisma.checklistTemplate.findMany({
          where: { orgId },
          orderBy: { sortOrder: "asc" },
          select: { id: true, label: true, category: true },
        }),
        prisma.checklistEntry.findMany({
          where: { orgId, serviceDate },
          select: { templateId: true, checked: true },
        }),
        prisma.incident.findMany({
          where: { orgId, serviceDate },
          orderBy: { timestamp: "desc" },
          select: { id: true, category: true, severity: true, description: true, reportedBy: true },
        }),
        prisma.equipment.findMany({
          where: { orgId },
          select: { id: true, name: true, category: true, status: true, nextService: true },
        }),
        prisma.crewMember.findMany({
          where: { orgId },
          orderBy: { name: "asc" },
          select: { id: true, name: true, role: true, isOnline: true, lastCheckIn: true },
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
        loadAssignments(orgId, serviceDate),
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
          select: { id: true, name: true, role: true, photoUrl: true, lastCheckIn: true },
        }),
        prisma.crewMember.count({ where: { orgId, isOnline: true } }),
        loadOpenItems(orgId, serviceDate),
        recentDates.length === 0
          ? Promise.resolve([])
          : prisma.rundownItem.findMany({
              where: { orgId, serviceDate: { in: recentDates } },
              select: { serviceDate: true, actualStart: true, actualEnd: true },
            }),
        recentDates.length === 0
          ? Promise.resolve([])
          : prisma.incident.findMany({
              where: { orgId, serviceDate: { in: recentDates } },
              select: { serviceDate: true },
            }),
      ]);

    // Actual runtime is the span from the first item that started to the
    // last that finished. Null until a service has actually been run with
    // the timer, which only became possible once 0011 added the columns.
    const actualByDate = new Map<string, { first: number; last: number }>();
    for (const row of recentItems) {
      const start = row.actualStart ? row.actualStart.getTime() : null;
      const end = row.actualEnd ? row.actualEnd.getTime() : null;
      if (start === null && end === null) continue;
      const current = actualByDate.get(row.serviceDate);
      const first = Math.min(current?.first ?? Number.POSITIVE_INFINITY, start ?? end ?? 0);
      const last = Math.max(current?.last ?? Number.NEGATIVE_INFINITY, end ?? start ?? 0);
      actualByDate.set(row.serviceDate, { first, last });
    }
    const incidentsByDate = new Map<string, number>();
    for (const row of recentIncidents) {
      incidentsByDate.set(row.serviceDate, (incidentsByDate.get(row.serviceDate) ?? 0) + 1);
    }

    const recent: SnapshotRecentService[] = recentDates.map((date) => {
      const span = actualByDate.get(date);
      return {
        serviceDate: date,
        name: startTimes.get(date)?.name ?? "",
        plannedMs: itemSummaries.get(date)?.plannedMs ?? 0,
        actualMs: span && Number.isFinite(span.first) ? span.last - span.first : null,
        incidentCount: incidentsByDate.get(date) ?? 0,
      };
    });

    const checkedByTemplate = new Map(entries.map((e) => [e.templateId, e.checked]));

    const upcoming: SnapshotUpcomingService[] = allDates
      .filter((d) => d > serviceDate)
      .slice(0, UPCOMING_LIMIT)
      .map((date) => {
        const summary = itemSummaries.get(date) ?? EMPTY_SUMMARY;
        const row = startTimes.get(date);
        return {
          serviceDate: date,
          scheduledStartTime: row?.scheduledStartTime ? row.scheduledStartTime.toISOString() : null,
          name: row?.name ?? "",
          itemCount: summary.itemCount,
          missingDuration: summary.missingDuration,
          missingOwner: summary.missingOwner,
        };
      });

    const snapshot: PmSnapshot = {
      serviceDate,
      serviceName: startTimes.get(serviceDate)?.name ?? "",
      now: Date.now(),
      callLeadMinutes,
      serviceWindowMinutes,
      serviceWindowConfigured,
      lastServiceDate,
      rundown: rundownState.meta
        ? {
            scheduledStartTime: rundownState.meta.scheduledStartTime ?? null,
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
      liveInputs: liveInputs.map((i) => ({ id: i.id, name: i.name, status: i.status })),
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
        crewMemberName: a.crewMember?.name ?? null,
        status: a.status,
      })),
      openItems: openItems.map<SnapshotOpenItem>((i) => ({
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
      model: derivePmDashboard(snapshot),
      orgId,
      serviceDates: [...allDates].reverse(),
      orgTimezone,
    };
  });
