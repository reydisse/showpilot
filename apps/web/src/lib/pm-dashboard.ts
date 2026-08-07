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
import { hasAnyPermission, type Permission } from "@/lib/app-permissions";
import { idSchema, parseOrThrow, serviceDateSchema } from "@/lib/validation";
import { getTodayDateString } from "@/lib/utils";
import { readPhaseSettings } from "@/lib/service-phase";
import { getRundownStateForOrg } from "@/lib/rundown";
import {
  derivePmDashboard,
  type PmDashboardModel,
  type PmSnapshot,
  type SnapshotUpcomingService,
} from "@/lib/pm-dashboard-derive";
import type { RundownItem } from "@/types/rundown";

const RUNDOWN_ITEMS_PREFIX = "rundown-items:";
const UPCOMING_LIMIT = 3;
const NOTIFICATION_LIMIT = 8;

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
        select: { serviceDate: true; scheduledStartTime: true; status: true };
      }): Promise<RundownDateRow[]>;
    };
  };
  if (!prisma.rundown) return [];
  try {
    return await prisma.rundown.findMany({
      where: { orgId },
      select: { serviceDate: true, scheduledStartTime: true, status: true },
    });
  } catch {
    return [];
  }
}

/** Item counts per service date, read straight from the stored JSON. */
function summarizeItems(raw: string): { itemCount: number; missingDuration: number; missingOwner: number } {
  try {
    const items = JSON.parse(raw) as RundownItem[];
    if (!Array.isArray(items)) return { itemCount: 0, missingDuration: 0, missingOwner: 0 };
    return {
      itemCount: items.length,
      missingDuration: items.filter((i) => !i.duration || i.duration <= 0).length,
      missingOwner: items.filter((i) => !i.assignee || !String(i.assignee).trim()).length,
    };
  } catch {
    return { itemCount: 0, missingDuration: 0, missingOwner: 0 };
  }
}

/**
 * The service the dashboard should open on: the nearest date at or after
 * today. If every service is in the past, show the most recent one so the
 * debrief is still reachable.
 */
export function resolveServiceDate(dates: string[], today: string): string {
  if (dates.length === 0) return today;
  const sorted = [...new Set(dates)].sort();
  const next = sorted.find((d) => d >= today);
  return next ?? sorted[sorted.length - 1];
}

export interface PmDashboardResult {
  model: PmDashboardModel;
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
    const itemSummaries = new Map<string, ReturnType<typeof summarizeItems>>();
    for (const row of settingRows) {
      if (row.key.startsWith(RUNDOWN_ITEMS_PREFIX)) {
        itemSummaries.set(row.key.slice(RUNDOWN_ITEMS_PREFIX.length), summarizeItems(row.value));
      } else {
        settings[row.key] = row.value;
      }
    }

    const orgTimezone = settings["org-timezone"] ?? "";
    const today = getTodayDateString(orgTimezone);
    const { callLeadMinutes, serviceWindowMinutes } = readPhaseSettings(settings);

    const startTimes = new Map<string, RundownDateRow>();
    for (const row of rundownRows) startTimes.set(row.serviceDate, row);

    const allDates = [...new Set([...itemSummaries.keys(), ...startTimes.keys()])].sort();
    const serviceDate = data.serviceDate ?? resolveServiceDate(allDates, today);

    // Every read below selects only the columns the dashboard uses. That
    // keeps the payload small and stops the page inheriting a failure from
    // a column it never reads.
    const [rundownState, templates, entries, incidents, cues, equipment, crew, destinations, liveInputs, notifications] =
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
        prisma.cueSheet.findMany({
          where: { orgId, serviceDate },
          orderBy: { cueNumber: "asc" },
          select: { id: true, cueNumber: true, rundownItem: true, cameraAssignments: true },
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
      ]);

    const checkedByTemplate = new Map(entries.map((e) => [e.templateId, e.checked]));

    const upcoming: SnapshotUpcomingService[] = allDates
      .filter((d) => d > serviceDate)
      .slice(0, UPCOMING_LIMIT)
      .map((date) => {
        const summary = itemSummaries.get(date) ?? { itemCount: 0, missingDuration: 0, missingOwner: 0 };
        const row = startTimes.get(date);
        return {
          serviceDate: date,
          scheduledStartTime: row?.scheduledStartTime ? row.scheduledStartTime.toISOString() : null,
          ...summary,
        };
      });

    const snapshot: PmSnapshot = {
      serviceDate,
      now: Date.now(),
      callLeadMinutes,
      serviceWindowMinutes,
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
      cues: cues.map((c) => ({
        id: c.id,
        cueNumber: c.cueNumber,
        rundownItem: c.rundownItem,
        cameraAssignments: c.cameraAssignments,
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
    };

    return {
      model: derivePmDashboard(snapshot),
      serviceDates: [...allDates].reverse(),
      orgTimezone,
    };
  });
