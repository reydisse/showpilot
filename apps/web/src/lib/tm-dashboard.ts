/**
 * Tech manager dashboard: reads and fault actions.
 *
 * Same shape as pm-dashboard.ts — permission asserted on the first line
 * of every handler, every query scoped by orgId, narrow selects so the
 * page cannot inherit a failure from a column it never reads.
 *
 * The actions here are the point of the page. A tech who has to leave
 * the dashboard to claim a fault will not do it during a service, so
 * claim, acknowledge and resolve all live next to the queue.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getPrisma } from "@/lib/db";
import { getD1 } from "@/lib/d1";
import {
  hasEffectivePermission,
  isAdminTier,
  type Permission,
} from "@/lib/app-permissions";
import { assertOrgPermission as assertEffectiveOrgPermission } from "@/lib/org-access";
import { resolveEffectiveAccess } from "@/lib/effective-access";
import { ROLE_META, type Role } from "@/lib/permissions";
import { idSchema, parseOrThrow, serviceDateSchema } from "@/lib/validation";
import { getTodayDateString } from "@/lib/utils";
import { loadRosterDuty } from "@/lib/pm-dashboard";
import { readPhaseSettings, getServicePhase } from "@/lib/service-phase";
import {
  deriveTmDashboard,
  type TmDashboardModel,
  type TmIncident,
  type TmSnapshot,
} from "@/lib/tm-dashboard-derive";

/** Carried-forward faults worth showing. Beyond this it is a backlog. */
const OPEN_FAULT_LIMIT = 25;

async function assertTm(orgId: string, permissions: Permission[]) {
  const { user, access } = await assertEffectiveOrgPermission(orgId, permissions);
  return {
    role: access.role,
    grantedPermissions: access.grantedPermissions,
    userId: user.id,
    userName: user.name,
  };
}

export interface TmDashboardResult {
  model: TmDashboardModel;
  orgId: string;
  showId: string | null;
  serviceDate: string;
  shows: Array<{ id: string; serviceDate: string; name: string; scheduledStartTime: string | null }>;
  viewerId: string;
  viewerRole: string;
  canAssignPeople: boolean;
  liveInputs: { id: string; name: string; status: string }[];
  streamDestinations: { id: string; name: string; platform: string; enabled: boolean; connected: boolean }[];
  /** Everyone a fault can be handed to. */
  members: { id: string; name: string; role: string; roleLabel: string }[];
}

export const getTmDashboard = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({ orgId: idSchema, serviceDate: serviceDateSchema.optional(), showId: idSchema.optional() }),
      data,
    ),
  )
  .handler(async ({ data }): Promise<TmDashboardResult> => {
    const viewer = await assertTm(data.orgId, ["dashboard:tm"]);

    const prisma = getPrisma();
    const orgId = data.orgId;

    const settings = await prisma.appSetting.findMany({
      where: { orgId },
      select: { key: true, value: true },
    });
    const settingMap: Record<string, string> = {};
    for (const row of settings) settingMap[row.key] = row.value;

    const orgTimezone = settingMap["org-timezone"] ?? "";
    const today = getTodayDateString(orgTimezone);
    // The rundown decides which service is current — same rule the cue
    // sheet follows, so the two pages never disagree about the date.
    const shows = await prisma.rundown.findMany({
      where: { orgId },
      orderBy: [{ serviceDate: "asc" }, { scheduledStartTime: "asc" }, { createdAt: "asc" }],
      select: { id: true, serviceDate: true, name: true, scheduledStartTime: true },
    });
    const targetShow =
      (data.showId ? shows.find((show) => show.id === data.showId) : undefined) ??
      (data.serviceDate ? shows.find((show) => show.serviceDate === data.serviceDate) : undefined) ??
      (settingMap["active-show-id"] ? shows.find((show) => show.id === settingMap["active-show-id"]) : undefined) ??
      (settingMap["active-service-date"] ? shows.find((show) => show.serviceDate === settingMap["active-service-date"]) : undefined) ??
      shows.find((show) => show.serviceDate >= today) ??
      shows.at(-1);
    const serviceDate = targetShow?.serviceDate ?? data.serviceDate ?? today;
    const showId = targetShow?.id;

    const [
      rundownRow,
      incidents,
      equipment,
      entries,
      destinations,
      liveInputs,
      devices,
      rosterDuty,
      checklistTemplateCount,
      rundownItemCount,
      rosterInUse,
    ] =
      await Promise.all([
        loadRundownMeta(orgId, serviceDate, showId),
        loadOpenFaults(orgId),
        prisma.equipment.findMany({
          where: { orgId },
          select: { id: true, name: true, category: true, status: true, nextService: true },
        }),
        prisma.checklistEntry.findMany({
          where: { orgId, ...(showId ? { showId } : { serviceDate }) },
          select: {
            id: true,
            checked: true,
            template: { select: { label: true, category: true } },
          },
        }),
        prisma.streamDestination.findMany({
          where: { orgId },
          select: { id: true, name: true, platform: true, enabled: true, cfOutputId: true },
        }),
        prisma.liveInput.findMany({
          where: { orgId },
          select: { id: true, name: true, status: true },
        }),
        prisma.device.findMany({
          where: { orgId },
          select: { id: true, name: true, category: true, adapterType: true, enabled: true },
        }),
        // The same weekly rota the PM dashboard reads. One source, so the
        // two pages can never name different people on duty.
        loadRosterDuty(orgId, serviceDate),
        prisma.checklistTemplate.count({ where: { orgId } }),
        prisma.rundownItem.count({ where: { orgId, ...(showId ? { showId } : { serviceDate }) } }),
        countRosterAssignments(orgId),
      ]);

    const { callLeadMinutes, serviceWindowMinutes, serviceWindowConfigured } =
      readPhaseSettings(settingMap);
    const now = Date.now();
    void serviceWindowConfigured;
    const phase = getServicePhase(
      {
        scheduledStartTime: rundownRow?.scheduledStartTime ?? null,
        callLeadMinutes,
        serviceWindowMinutes,
        // The column is a plain string in D1; narrow it rather than
        // trusting whatever happens to be in the row.
        status:
          rundownRow?.status === "live" || rundownRow?.status === "complete"
            ? rundownRow.status
            : "stopped",
      },
      now,
    );

    const snapshot: TmSnapshot = {
      serviceDate,
      now,
      phase,
      viewerId: viewer.userId,
      incidents,
      equipment: equipment.map((row) => ({
        id: row.id,
        name: row.name,
        category: row.category,
        status: row.status,
        nextServiceMs: row.nextService ? new Date(row.nextService).getTime() : null,
      })),
      checklist: entries.map((row) => ({
        id: row.id,
        label: row.template?.label ?? "",
        category: row.template?.category ?? "general",
        checked: row.checked,
      })),
      streamDestinations: destinations.map((row) => ({
        id: row.id,
        name: row.name,
        platform: row.platform,
        enabled: row.enabled,
        // Stream Connect gives an output id once the destination is
        // actually wired up. No id means configured but not connected.
        connected: Boolean(row.cfOutputId),
      })),
      liveInputs: liveInputs.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
      })),
      devices: devices.map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.adapterType || row.category,
        lastSeenMs: null,
        // Enabled with an adapter chosen is what "this org actually uses
        // this device" means. Anything else is a row someone started and
        // abandoned, and showing it as a fault would be a lie.
        configured: row.enabled && Boolean(row.adapterType),
      })),
      streamingConfigured: destinations.length > 0 || liveInputs.length > 0,
      duty: [
        { key: "pm" as const, label: "Production", name: rosterDuty.pm?.name ?? null },
        { key: "tm" as const, label: "Tech", name: rosterDuty.tm?.name ?? null },
      ],
      checklistTemplateCount,
      rundownItemCount,
      rosterInUse,
    };

    const members = await prisma.member.findMany({
      where: { organizationId: orgId },
      select: { role: true, user: { select: { id: true, name: true } } },
    });
    const assignableMembers = (
      await Promise.all(
        members.map(async (member) => ({
          member,
          access: await resolveEffectiveAccess(getD1(), member.user.id, orgId),
        })),
      )
    ).filter(({ access }) => access?.permissions.includes("incidents:access"));

    return {
      model: deriveTmDashboard(snapshot),
      orgId,
      showId: showId ?? null,
      serviceDate,
      shows: shows.map((show) => ({
        id: show.id,
        serviceDate: show.serviceDate,
        name: show.name,
        scheduledStartTime: show.scheduledStartTime?.toISOString() ?? null,
      })),
      viewerId: viewer.userId,
      viewerRole: viewer.role,
      canAssignPeople: isAdminTier(viewer.role),
      liveInputs: liveInputs.map((row) => ({ id: row.id, name: row.name, status: row.status })),
      streamDestinations: destinations.map((row) => ({
        id: row.id,
        name: row.name,
        platform: row.platform,
        enabled: row.enabled,
        connected: Boolean(row.cfOutputId),
      })),
      members: assignableMembers
        .map(({ member: row }) => ({
          id: row.user.id,
          name: row.user.name,
          role: row.role,
          roleLabel: ROLE_META[row.role as Role]?.label ?? row.role,
        }))
        .filter((member) => member.name),
    };
  });

/**
 * Has this org ever used the weekly rota?
 *
 * Raw D1 because roster_assignment predates the generated client in some
 * environments, and a missing table must read as "not in use" rather
 * than break the page — the same defensive read loadRosterDuty does.
 */
async function countRosterAssignments(orgId: string): Promise<boolean> {
  try {
    const row = await getD1()
      .prepare(`SELECT 1 AS present FROM roster_assignment WHERE orgId = ? LIMIT 1`)
      .bind(orgId)
      .first<{ present: number }>();
    return Boolean(row);
  } catch {
    return false;
  }
}

/**
 * Open faults, read with raw D1.
 *
 * 0015 added assignedTo, assignedName and acknowledgedAt. The generated
 * Prisma client is built per machine and gitignored, so it does not know
 * those columns until someone runs `pnpm db:generate` — and a tech
 * dashboard that 500s on a Sunday because a teammate has a stale client
 * is not a trade worth making. Same precedent as loadRosterDuty and the
 * cue sheet. Parameterised and orgId-scoped.
 *
 * Every open fault is loaded, not just this service's: a radio mic that
 * broke in May is still broken, and this is the team that fixes it.
 */
async function loadOpenFaults(orgId: string): Promise<TmIncident[]> {
  const rows =
    (
      await getD1()
        .prepare(
          `SELECT id, category, severity, description, reportedBy, serviceDate,
                  timestamp, status, assignedTo, assignedName, acknowledgedAt
             FROM incident
            WHERE orgId = ? AND status <> 'resolved'
            ORDER BY timestamp DESC
            LIMIT ?`,
        )
        .bind(orgId, OPEN_FAULT_LIMIT)
        .all<{
          id: string;
          category: string;
          severity: string;
          description: string;
          reportedBy: string;
          serviceDate: string;
          timestamp: string | null;
          status: string;
          assignedTo: string | null;
          assignedName: string | null;
          acknowledgedAt: string | null;
        }>()
    ).results ?? [];

  return rows.map((row) => ({
    id: row.id,
    category: row.category,
    severity: row.severity,
    description: row.description,
    reportedBy: row.reportedBy,
    serviceDate: row.serviceDate,
    reportedAt: row.timestamp ? new Date(row.timestamp).getTime() : Date.now(),
    status: row.status,
    assignedTo: row.assignedTo,
    assignedName: row.assignedName ?? "",
    acknowledgedAt: row.acknowledgedAt ? new Date(row.acknowledgedAt).getTime() : null,
  }));
}

/**
 * The rundown row carries the scheduled start the phase is derived from.
 * Accessed defensively for the same reason rundown.ts does it — some
 * generated clients in the wild predate the model.
 */
async function loadRundownMeta(
  orgId: string,
  serviceDate: string,
  showId?: string,
): Promise<{ scheduledStartTime: string | null; status: string } | null> {
  try {
    const row = await getD1()
      .prepare(
        `SELECT scheduledStartTime, status FROM rundown WHERE orgId = ? AND ${showId ? "id = ?" : "serviceDate = ?"}`,
      )
      .bind(orgId, showId ?? serviceDate)
      .first<{ scheduledStartTime: string | null; status: string }>();
    if (!row) return null;
    return {
      scheduledStartTime: row.scheduledStartTime
        ? new Date(row.scheduledStartTime).toISOString()
        : null,
      status: row.status,
    };
  } catch {
    return null;
  }
}

// ─── Fault actions ───────────────────────────────────────────

/**
 * Take a fault, or hand it to someone else.
 *
 * Claiming also acknowledges it: you cannot press this button without
 * having read the fault, so recording otherwise would be theatre.
 * Assigning someone *else* does not acknowledge — they have not seen it
 * yet, and that gap is exactly what the staleness rule watches for.
 */
export const assignFault = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        id: idSchema,
        /** Null hands it back to the pool. */
        assignedTo: idSchema.nullable(),
        assignedName: z.string().max(120).default(""),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    const viewer = await assertTm(data.orgId, ["dashboard:tm", "incidents:access"]);
    // Claiming a fault yourself acknowledges it — you cannot press the
    // button without having read it. Handing it to someone else does
    // not: they have not seen it yet, and that gap is exactly what the
    // staleness rule watches for.
    const claimingSelf = data.assignedTo === viewer.userId;
    if (
      claimingSelf &&
      !hasEffectivePermission(viewer.role, viewer.grantedPermissions, "incidents:access")
    ) throw new Error("Forbidden");
    let name = data.assignedTo ? data.assignedName || viewer.userName : "";

    if (data.assignedTo && !claimingSelf) {
      if (!isAdminTier(viewer.role)) throw new Error("Forbidden");
      const target = await getPrisma().member.findFirst({
        where: { organizationId: data.orgId, userId: data.assignedTo },
        select: { user: { select: { name: true } } },
      });
      const targetAccess = target
        ? await resolveEffectiveAccess(getD1(), data.assignedTo, data.orgId)
        : null;
      if (!target || !targetAccess?.permissions.includes("incidents:access")) {
        throw new Error("That person cannot be assigned operational issues");
      }
      // Never trust the display name supplied by the browser. It is
      // denormalised onto the incident, so source it from membership.
      name = target.user.name;
    }

    if (!data.assignedTo && !isAdminTier(viewer.role)) {
      const current = await getD1()
        .prepare(`SELECT assignedTo FROM incident WHERE id = ? AND orgId = ?`)
        .bind(data.id, data.orgId)
        .first<{ assignedTo: string | null }>();
      if (current?.assignedTo !== viewer.userId) throw new Error("Forbidden");
    }

    // orgId in the WHERE, not just the permission check. The check proves
    // this caller may manage faults in their own org, not that this fault
    // belongs to it.
    const result = await getD1()
      .prepare(
        `UPDATE incident SET assignedTo = ?, assignedName = ?, acknowledgedAt = ?,
          assignedBy = ?, assignedAt = ?
          WHERE id = ? AND orgId = ?`,
      )
      .bind(
        data.assignedTo,
        name,
        claimingSelf ? new Date().toISOString() : null,
        data.assignedTo ? viewer.userId : null,
        data.assignedTo ? new Date().toISOString() : null,
        data.id,
        data.orgId,
      )
      .run();
    if (!result.success) throw new Error("Could not assign that fault");

    try {
      const { notifyOperationalEvent } = await import("@/lib/operational-notifications.server");
      await notifyOperationalEvent({
        orgId: data.orgId,
        actorId: viewer.userId,
        recipientIds: data.assignedTo ? [data.assignedTo] : [],
        includeLeadership: true,
        type: data.assignedTo ? "incident-assigned" : "incident-unassigned",
        severity: "warning",
        title: data.assignedTo ? "Operational issue assigned" : "Operational issue returned to the queue",
        message: data.assignedTo ? `${name || "A technician"} is now responsible for this issue.` : `${viewer.userName} returned an issue to the unassigned queue.`,
        actionUrl: `production/incidents?incident=${encodeURIComponent(data.id)}`,
        source: data.id,
        pushTag: `fault-${data.id}`,
      });
    } catch {
      // The assignment remains authoritative when notification delivery fails.
    }

    return { ok: true as const };
  });

/** Confirm you have seen a fault someone else handed you. */
export const acknowledgeFault = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, id: idSchema }), data),
  )
  .handler(async ({ data }) => {
    const viewer = await assertTm(data.orgId, ["dashboard:tm", "incidents:access"]);
    await getD1()
      .prepare(`UPDATE incident SET acknowledgedAt = ? WHERE id = ? AND orgId = ? AND assignedTo = ?`)
      .bind(new Date().toISOString(), data.id, data.orgId, viewer.userId)
      .run();
    const { notifyOperationalEvent } = await import("@/lib/operational-notifications.server");
    await notifyOperationalEvent({
      orgId: data.orgId,
      actorId: viewer.userId,
      includeLeadership: true,
      type: "incident-acknowledged",
      title: "Operational issue acknowledged",
      message: `${viewer.userName} acknowledged the assigned issue.`,
      actionUrl: `production/incidents?incident=${encodeURIComponent(data.id)}`,
      source: data.id,
      pushTag: `fault-${data.id}`,
    });
    return { ok: true as const };
  });

export const resolveFault = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, id: idSchema }), data),
  )
  .handler(async ({ data }) => {
    const viewer = await assertTm(data.orgId, ["dashboard:tm", "incidents:access"]);
    await getD1()
      .prepare(
        `UPDATE incident SET status = 'resolved', resolvedAt = ?, resolvedBy = ?
          WHERE id = ? AND orgId = ?`,
      )
      .bind(new Date().toISOString(), viewer.userName, data.id, data.orgId)
      .run();
    const { notifyOperationalEvent } = await import("@/lib/operational-notifications.server");
    await notifyOperationalEvent({
      orgId: data.orgId,
      actorId: viewer.userId,
      includeLeadership: true,
      type: "incident-resolved",
      title: "Operational issue resolved",
      message: `${viewer.userName} marked the issue as resolved.`,
      actionUrl: `production/incidents?incident=${encodeURIComponent(data.id)}`,
      source: data.id,
      pushTag: `fault-${data.id}`,
    });
    return { ok: true as const };
  });
