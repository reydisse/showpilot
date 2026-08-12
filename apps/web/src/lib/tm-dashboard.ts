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
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { getPrisma } from "@/lib/db";
import { getD1 } from "@/lib/d1";
import { hasAnyPermission, type Permission } from "@/lib/app-permissions";
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

async function getViewer(orgId: string) {
  const { getAuth } = await import("@/lib/auth");
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: getRequestHeaders() });
  if (!session) throw new Error("Unauthorized");

  const prisma = getPrisma();
  const member = await prisma.member.findFirst({
    where: { organizationId: orgId, userId: session.user.id },
    select: { role: true },
  });
  if (!member) throw new Error("Forbidden");

  return {
    role: member.role ?? "member",
    userId: session.user.id,
    userName: session.user.name ?? "",
  };
}

async function assertTm(orgId: string, permissions: Permission[]) {
  const viewer = await getViewer(orgId);
  if (!hasAnyPermission(viewer.role, permissions)) throw new Error("Forbidden");
  return viewer;
}

export interface TmDashboardResult {
  model: TmDashboardModel;
  orgId: string;
  serviceDate: string;
  viewerId: string;
  /** Everyone a fault can be handed to. */
  members: { id: string; name: string }[];
}

export const getTmDashboard = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({ orgId: idSchema, serviceDate: serviceDateSchema.optional() }),
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
    const serviceDate = data.serviceDate ?? settingMap["active-service-date"] ?? today;

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
    ] =
      await Promise.all([
        loadRundownMeta(orgId, serviceDate),
        loadOpenFaults(orgId),
        prisma.equipment.findMany({
          where: { orgId },
          select: { id: true, name: true, category: true, status: true, nextService: true },
        }),
        prisma.checklistEntry.findMany({
          where: { orgId, serviceDate },
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
        prisma.rundownItem.count({ where: { orgId, serviceDate } }),
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
    };

    const members = await prisma.member.findMany({
      where: { organizationId: orgId },
      select: { user: { select: { id: true, name: true } } },
    });

    return {
      model: deriveTmDashboard(snapshot),
      orgId,
      serviceDate,
      viewerId: viewer.userId,
      members: members
        .map((row) => ({ id: row.user.id, name: row.user.name }))
        .filter((member) => member.name),
    };
  });

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
): Promise<{ scheduledStartTime: string | null; status: string } | null> {
  try {
    const row = await getD1()
      .prepare(
        `SELECT scheduledStartTime, status FROM rundown WHERE orgId = ? AND serviceDate = ?`,
      )
      .bind(orgId, serviceDate)
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
    const name = data.assignedTo ? data.assignedName || viewer.userName : "";

    // orgId in the WHERE, not just the permission check. The check proves
    // this caller may manage faults in their own org, not that this fault
    // belongs to it.
    const result = await getD1()
      .prepare(
        `UPDATE incident SET assignedTo = ?, assignedName = ?, acknowledgedAt = ?
          WHERE id = ? AND orgId = ?`,
      )
      .bind(
        data.assignedTo,
        name,
        claimingSelf ? new Date().toISOString() : null,
        data.id,
        data.orgId,
      )
      .run();
    if (!result.success) throw new Error("Could not assign that fault");
    return { ok: true as const };
  });

/** Confirm you have seen a fault someone else handed you. */
export const acknowledgeFault = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, id: idSchema }), data),
  )
  .handler(async ({ data }) => {
    await assertTm(data.orgId, ["dashboard:tm", "incidents:access"]);
    await getD1()
      .prepare(`UPDATE incident SET acknowledgedAt = ? WHERE id = ? AND orgId = ?`)
      .bind(new Date().toISOString(), data.id, data.orgId)
      .run();
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
    return { ok: true as const };
  });
