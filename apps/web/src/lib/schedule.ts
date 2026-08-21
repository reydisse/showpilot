import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { getPrisma } from "@/lib/db";
import { getD1 } from "@/lib/d1";
import { assertOrgPermission } from "@/lib/org-access";
import { idSchema, parseOrThrow, serviceDateSchema } from "@/lib/validation";
import { orgTerminologyProfileSchema } from "@/lib/org-terminology";
import { serviceTimeToIso } from "@/lib/utils";

const rangeInput = z.object({
  orgId: idSchema,
  from: serviceDateSchema,
  to: serviceDateSchema,
  selectedDate: serviceDateSchema.optional(),
  selectedShowId: idSchema.optional(),
});

export const scheduleProviderSchema = z.enum([
  "native",
  "planning-center",
  "faithteams",
  "other",
]);
export type ScheduleProvider = z.infer<typeof scheduleProviderSchema>;

const providerConfigInput = z.object({
  orgId: idSchema,
  provider: scheduleProviderSchema,
  url: z.union([z.literal(""), z.string().url().max(500)]),
  label: z.string().trim().max(80).default(""),
  terminologyProfile: orgTerminologyProfileSchema.default("general"),
});

export const saveScheduleProvider = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) => parseOrThrow(providerConfigInput, value))
  .handler(async ({ data }) => {
    await assertAccess(data.orgId, true);
    if (data.provider !== "native" && !data.url)
      throw new Error("A scheduling workspace URL is required");
    if (data.url) {
      const url = new URL(data.url);
      if (url.protocol !== "https:")
        throw new Error("Scheduling links must use HTTPS");
    }
    const prisma = getPrisma();
    await prisma.$transaction([
      prisma.appSetting.upsert({
        where: { orgId_key: { orgId: data.orgId, key: "schedule-provider" } },
        update: { value: data.provider },
        create: {
          orgId: data.orgId,
          key: "schedule-provider",
          value: data.provider,
        },
      }),
      prisma.appSetting.upsert({
        where: {
          orgId_key: { orgId: data.orgId, key: "schedule-provider-url" },
        },
        update: { value: data.url },
        create: {
          orgId: data.orgId,
          key: "schedule-provider-url",
          value: data.url,
        },
      }),
      prisma.appSetting.upsert({
        where: {
          orgId_key: { orgId: data.orgId, key: "schedule-provider-label" },
        },
        update: { value: data.label },
        create: {
          orgId: data.orgId,
          key: "schedule-provider-label",
          value: data.label,
        },
      }),
      prisma.appSetting.upsert({
        where: { orgId_key: { orgId: data.orgId, key: "terminology-profile" } },
        update: { value: data.terminologyProfile },
        create: {
          orgId: data.orgId,
          key: "terminology-profile",
          value: data.terminologyProfile,
        },
      }),
    ]);
    return { ok: true };
  });

export const saveServiceDetails = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        showId: idSchema,
        serviceDate: serviceDateSchema,
        name: z.string().trim().max(120),
        startTime: z.union([
          z.literal(""),
          z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        ]),
        location: z.string().trim().max(240),
      }),
      value,
    ),
  )
  .handler(async ({ data }) => {
    await assertAccess(data.orgId, true);
    const show = await getPrisma().rundown.findFirst({
      where: {
        id: data.showId,
        orgId: data.orgId,
        serviceDate: data.serviceDate,
      },
      select: { id: true },
    });
    if (!show) throw new Error("Show not found");
    const timezone = await getPrisma().appSetting.findUnique({
      where: { orgId_key: { orgId: data.orgId, key: "org-timezone" } },
      select: { value: true },
    });
    const scheduledStartIso = serviceTimeToIso(data.serviceDate, data.startTime, timezone?.value);
    const scheduledStartTime = scheduledStartIso ? new Date(scheduledStartIso) : null;
    return getPrisma().rundown.update({
      where: { id: show.id },
      data: { name: data.name, scheduledStartTime, location: data.location },
    });
  });

/** Remove one stopped show and only the operational data owned by it. */
export const deleteService = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, showId: idSchema }), value),
  )
  .handler(async ({ data }) => {
    await assertAccess(data.orgId, true);
    const prisma = getPrisma();
    const rundown = await prisma.rundown.findFirst({
      where: { id: data.showId, orgId: data.orgId },
      select: { id: true, serviceDate: true, status: true },
    });
    if (!rundown) throw new Error("Show not found");
    if (rundown.status === "live") throw new Error("Stop the show before deleting it");

    const timerSettings = await prisma.appSetting.findMany({
      where: {
        orgId: data.orgId,
        key: { in: [`rundown-timer:${rundown.id}`, `rundown-timer:${rundown.serviceDate}`] },
      },
      select: { value: true },
    });
    for (const timerSetting of timerSettings) {
      try {
        const timer = JSON.parse(timerSetting.value) as { playback?: string } | null;
        if (timer?.playback === "play" || timer?.playback === "pause") {
          throw new Error("Stop the show before deleting it");
        }
      } catch (error) {
        if (error instanceof Error && error.message === "Stop the show before deleting it") throw error;
      }
    }

    // Prisma and raw D1 use the same database, but separate calls are not one
    // transaction. Keep the complete deletion in a single atomic D1 batch so
    // a failed notification cleanup cannot leave half a show behind.
    const db = getD1();
    const showArgs = [data.orgId, rundown.id] as const;
    await db.batch([
      db.prepare("DELETE FROM content_reaction WHERE orgId = ? AND targetType = 'incident-comment' AND targetId IN (SELECT id FROM incident_comment WHERE orgId = ? AND incidentId IN (SELECT id FROM incident WHERE orgId = ? AND showId = ?))").bind(data.orgId, data.orgId, ...showArgs),
      db.prepare("DELETE FROM incident_comment WHERE orgId = ? AND incidentId IN (SELECT id FROM incident WHERE orgId = ? AND showId = ?)").bind(data.orgId, ...showArgs),
      db.prepare("DELETE FROM notification WHERE orgId = ? AND source IN (SELECT id FROM incident WHERE orgId = ? AND showId = ?)").bind(data.orgId, ...showArgs),
      db.prepare("DELETE FROM notification WHERE orgId = ? AND source IN (SELECT id FROM service_assignment WHERE orgId = ? AND showId = ?)").bind(data.orgId, ...showArgs),
      db.prepare("DELETE FROM cue_note WHERE orgId = ? AND showId = ?").bind(...showArgs),
      db.prepare("DELETE FROM cue_sheet WHERE orgId = ? AND showId = ?").bind(...showArgs),
      db.prepare("DELETE FROM checklist_entry WHERE orgId = ? AND showId = ?").bind(...showArgs),
      db.prepare("DELETE FROM service_assignment WHERE orgId = ? AND showId = ?").bind(...showArgs),
      db.prepare("DELETE FROM rundown_item WHERE orgId = ? AND showId = ?").bind(...showArgs),
      db.prepare("DELETE FROM incident WHERE orgId = ? AND showId = ?").bind(...showArgs),
      db.prepare("DELETE FROM mic_assignment WHERE orgId = ? AND showId = ?").bind(...showArgs),
      db.prepare("DELETE FROM app_setting WHERE orgId = ? AND key IN (?, ?, ?, ?)").bind(
        data.orgId,
        `rundown-items:${rundown.id}`,
        `rundown-timer:${rundown.id}`,
        `rundown-message:${rundown.id}`,
        `rundown-ppslide:${rundown.id}`,
      ),
      db.prepare("DELETE FROM app_setting WHERE orgId = ? AND key = 'active-show-id' AND value = ?").bind(data.orgId, rundown.id),
      db.prepare("DELETE FROM rundown WHERE orgId = ? AND id = ?").bind(...showArgs),
      db.prepare("DELETE FROM app_setting WHERE orgId = ? AND key IN (?, ?, ?, ?) AND NOT EXISTS (SELECT 1 FROM rundown WHERE orgId = ? AND serviceDate = ?)").bind(
        data.orgId,
        `rundown-items:${rundown.serviceDate}`,
        `rundown-timer:${rundown.serviceDate}`,
        `rundown-message:${rundown.serviceDate}`,
        `rundown-ppslide:${rundown.serviceDate}`,
        data.orgId,
        rundown.serviceDate,
      ),
      db.prepare("DELETE FROM app_setting WHERE orgId = ? AND key = 'active-service-date' AND value = ? AND NOT EXISTS (SELECT 1 FROM rundown WHERE orgId = ? AND serviceDate = ?)").bind(
        data.orgId,
        rundown.serviceDate,
        data.orgId,
        rundown.serviceDate,
      ),
    ]);

    return { ok: true as const };
  });

async function assertAccess(orgId: string, manage = false) {
  const { user } = await assertOrgPermission(
    orgId,
    manage ? "schedule:manage" : "schedule:view",
  );
  return {
    userId: user.id,
    email: user.email.toLowerCase(),
    name: user.name,
  };
}

export const getSchedule = createServerFn({ method: "GET" })
  .inputValidator((value: unknown) => parseOrThrow(rangeInput, value))
  .handler(async ({ data }) => {
    const viewer = await assertAccess(data.orgId);
    const prisma = getPrisma();
    const dateWhere = { gte: data.from, lte: data.to };
    const [
      rundowns,
      items,
      assignments,
      checklist,
      incidents,
      crew,
      providerSettings,
    ] = await Promise.all([
      prisma.rundown.findMany({
        where: { orgId: data.orgId, serviceDate: dateWhere },
        orderBy: [
          { serviceDate: "asc" },
          { scheduledStartTime: "asc" },
          { createdAt: "asc" },
        ],
      }),
      prisma.rundownItem.findMany({
        where: { orgId: data.orgId, serviceDate: dateWhere },
        select: {
          showId: true,
          serviceDate: true,
          status: true,
          duration: true,
          actualStart: true,
          actualEnd: true,
        },
      }),
      prisma.serviceAssignment.findMany({
        where: { orgId: data.orgId, serviceDate: dateWhere },
        include: {
          crewMember: {
            select: { id: true, name: true, role: true, email: true },
          },
        },
        orderBy: { role: "asc" },
      }),
      prisma.checklistEntry.findMany({
        where: { orgId: data.orgId, serviceDate: dateWhere },
        select: { showId: true, serviceDate: true, checked: true },
      }),
      prisma.incident.findMany({
        where: { orgId: data.orgId, serviceDate: dateWhere },
        select: { showId: true, serviceDate: true, status: true },
      }),
      prisma.crewMember.findMany({
        where: { orgId: data.orgId },
        select: { id: true, name: true, role: true, email: true },
        orderBy: { name: "asc" },
      }),
      prisma.appSetting.findMany({
        where: {
          orgId: data.orgId,
          key: {
            in: [
              "schedule-provider",
              "schedule-provider-url",
              "schedule-provider-label",
              "terminology-profile",
            ],
          },
        },
        select: { key: true, value: true },
      }),
    ]);
    const providerMap = Object.fromEntries(
      providerSettings.map((setting) => [setting.key, setting.value]),
    );
    const parsedProvider = scheduleProviderSchema.safeParse(
      providerMap["schedule-provider"],
    );
    const provider = parsedProvider.success ? parsedProvider.data : "native";
    const parsedTerminology = orgTerminologyProfileSchema.safeParse(
      providerMap["terminology-profile"],
    );
    const terminologyProfile = parsedTerminology.success
      ? parsedTerminology.data
      : "general";
    const selectedShow = data.selectedShowId
      ? rundowns.find((rundown) => rundown.id === data.selectedShowId)
      : undefined;
    const selectedDate = selectedShow?.serviceDate ?? data.selectedDate ?? rundowns[0]?.serviceDate;
    const services = rundowns.map((rundown) => {
      const dayItems = items.filter(
        (item) => item.showId === rundown.id,
      );
      const dayCrew = assignments.filter(
        (item) => item.showId === rundown.id,
      );
      const dayChecklist = checklist.filter(
        (item) => item.showId === rundown.id,
      );
      const completed = dayItems.filter(
        (item) => item.status === "complete",
      ).length;
      const confirmed = dayCrew.filter(
        (item) => item.status === "confirmed",
      ).length;
      const readinessParts = [
        dayItems.length ? completed / dayItems.length : 0,
        dayChecklist.length
          ? dayChecklist.filter((item) => item.checked).length /
            dayChecklist.length
          : 0,
        dayCrew.length ? confirmed / dayCrew.length : 0,
      ];
      return {
        id: rundown.id,
        serviceDate: rundown.serviceDate,
        name: rundown.name || "Service",
        scheduledStartTime: rundown.scheduledStartTime?.toISOString() ?? null,
        location: rundown.location,
        status: rundown.status,
        itemCount: dayItems.length,
        completedItems: completed,
        plannedDurationMs: dayItems.reduce(
          (sum, item) => sum + item.duration,
          0,
        ),
        actualStart:
          dayItems
            .map((item) => item.actualStart)
            .filter(Boolean)
            .sort((a, b) => a!.getTime() - b!.getTime())[0]
            ?.toISOString() ?? null,
        actualEnd:
          dayItems
            .map((item) => item.actualEnd)
            .filter(Boolean)
            .sort((a, b) => b!.getTime() - a!.getTime())[0]
            ?.toISOString() ?? null,
        crewTotal: dayCrew.length,
        crewConfirmed: confirmed,
        crewOpen: dayCrew.filter((item) => !item.crewMemberId).length,
        checklistTotal: dayChecklist.length,
        checklistComplete: dayChecklist.filter((item) => item.checked).length,
        incidentCount: incidents.filter(
          (item) => item.showId === rundown.id,
        ).length,
        readiness: Math.round(
          (readinessParts.reduce((sum, part) => sum + part, 0) /
            readinessParts.length) *
            100,
        ),
      };
    });
    return {
      services,
      selectedDate: selectedDate ?? null,
      assignments: assignments.map((assignment) => ({
        ...assignment,
        canRespond:
          Boolean(assignment.crewMember?.email) &&
          assignment.crewMember!.email.toLowerCase() === viewer.email,
      })),
      crew,
      provider: {
        type: provider,
        url: providerMap["schedule-provider-url"] ?? "",
        label: providerMap["schedule-provider-label"] ?? "",
      },
      terminologyProfile,
    };
  });

export const getServiceAssignments = createServerFn({ method: "GET" })
  .inputValidator((value: unknown) =>
    parseOrThrow(
      z.object({ orgId: idSchema, showId: idSchema }),
      value,
    ),
  )
  .handler(async ({ data }) => {
    const viewer = await assertAccess(data.orgId);
    const assignments = await getPrisma().serviceAssignment.findMany({
      where: { orgId: data.orgId, showId: data.showId },
      include: {
        crewMember: {
          select: { id: true, name: true, role: true, email: true },
        },
      },
      orderBy: [{ department: "asc" }, { role: "asc" }],
    });
    return assignments.map((assignment) => ({
      ...assignment,
      canRespond:
        Boolean(assignment.crewMember?.email) &&
        assignment.crewMember!.email.toLowerCase() === viewer.email,
    }));
  });

const assignmentInput = z.object({
  orgId: idSchema,
  id: idSchema.optional(),
  showId: idSchema,
  serviceDate: serviceDateSchema,
  role: z.string().trim().min(1).max(120),
  department: z.string().trim().min(1).max(80).default("Production"),
  crewMemberId: idSchema.nullable(),
  status: z.enum(["assigned", "confirmed", "declined"]).default("assigned"),
  callTime: z.union([z.literal(""), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)]).default(""),
  notes: z.string().trim().max(500).default(""),
});

export const saveServiceAssignment = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) => parseOrThrow(assignmentInput, value))
  .handler(async ({ data }) => {
    await assertAccess(data.orgId, true);
    const show = await getPrisma().rundown.findFirst({
      where: { id: data.showId, orgId: data.orgId, serviceDate: data.serviceDate },
      select: { id: true },
    });
    if (!show) throw new Error("Show not found");
    if (data.crewMemberId) {
      const valid = await getPrisma().crewMember.count({
        where: { id: data.crewMemberId, orgId: data.orgId },
      });
      if (!valid) throw new Error("Crew member not found");
    }
    if (data.id) {
      const existing = await getPrisma().serviceAssignment.findFirst({
        where: { id: data.id, orgId: data.orgId },
      });
      if (!existing) throw new Error("Assignment not found");
      const personChanged = existing.crewMemberId !== data.crewMemberId;
      // A decline is part of the service record. Reassigning that position
      // creates a fresh invitation while leaving the declined response and
      // note visible in the roster history.
      if (personChanged && existing.status === "declined") {
        const replacement = await getPrisma().serviceAssignment.create({
          data: {
            orgId: data.orgId,
            showId: existing.showId ?? show.id,
            serviceDate: existing.serviceDate,
            role: data.role,
            department: data.department,
            crewMemberId: data.crewMemberId,
            status: "assigned",
            callTime: data.callTime,
            notes: data.notes,
            invitedAt: null,
          },
        });
        if (data.crewMemberId) {
          const delivered = await notifyAssignment(
            data.orgId,
            replacement.id,
            replacement.serviceDate,
            replacement.role,
            data.crewMemberId,
          );
          if (delivered) {
            return getPrisma().serviceAssignment.update({
              where: { id: replacement.id },
              data: { invitedAt: new Date() },
            });
          }
        }
        return replacement;
      }
      const updated = await getPrisma().serviceAssignment.update({
        where: { id: data.id },
        data: {
          role: data.role,
          department: data.department,
          crewMemberId: data.crewMemberId,
          callTime: data.callTime,
          notes: data.notes,
          ...(personChanged
            ? { status: "assigned", responseNote: "", respondedAt: null, invitedAt: null }
            : {}),
        },
      });
      if (personChanged && data.crewMemberId) {
        const delivered = await notifyAssignment(
          data.orgId,
          updated.id,
          updated.serviceDate,
          updated.role,
          data.crewMemberId,
        );
        if (delivered)
          return getPrisma().serviceAssignment.update({
            where: { id: updated.id },
            data: { invitedAt: new Date() },
          });
      }
      return updated;
    }
    const assignment = await getPrisma().serviceAssignment.create({
      data: {
        orgId: data.orgId,
        showId: show.id,
        serviceDate: data.serviceDate,
        role: data.role,
        department: data.department,
        crewMemberId: data.crewMemberId,
        status: data.status,
        callTime: data.callTime,
        notes: data.notes,
        invitedAt: null,
      },
    });
    if (data.crewMemberId && data.status === "assigned") {
      const delivered = await notifyAssignment(
        data.orgId,
        assignment.id,
        data.serviceDate,
        data.role,
        data.crewMemberId,
      );
      if (delivered)
        return getPrisma().serviceAssignment.update({
          where: { id: assignment.id },
          data: { invitedAt: new Date() },
        });
    }
    return assignment;
  });

async function notifyAssignment(
  orgId: string,
  assignmentId: string,
  serviceDate: string,
  role: string,
  crewMemberId: string,
  reminder = false,
) {
  try {
    const { sendCrewScheduleInvite } = await import("@/lib/crew-schedule");
    const headers = getRequestHeaders();
    const host = headers.get("x-forwarded-host") ?? headers.get("host");
    const protocol =
      headers.get("x-forwarded-proto") ??
      (host?.includes("localhost") || host?.startsWith("127.0.0.1")
        ? "http"
        : "https");
    const origin =
      headers.get("origin") ??
      (host ? `${protocol}://${host}` : "https://showpilot.tech");
    const result = await sendCrewScheduleInvite({
      orgId,
      assignmentId,
      serviceDate,
      role,
      crewMemberId,
      reminder,
      origin,
    });
    return result.delivered;
  } catch (error) {
    console.error("[Schedule] Crew invitation delivery failed", error);
    return false;
  }
}

export const remindServiceAssignment = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, id: idSchema }), value),
  )
  .handler(async ({ data }) => {
    await assertAccess(data.orgId, true);
    const assignment = await getPrisma().serviceAssignment.findFirst({
      where: {
        id: data.id,
        orgId: data.orgId,
        status: "assigned",
        crewMemberId: { not: null },
      },
    });
    if (!assignment?.crewMemberId)
      throw new Error("Only pending assignments can be reminded");
    const delivered = await notifyAssignment(
      data.orgId,
      assignment.id,
      assignment.serviceDate,
      assignment.role,
      assignment.crewMemberId,
      true,
    );
    if (delivered)
      await getPrisma().serviceAssignment.update({
        where: { id: assignment.id },
        data: { invitedAt: new Date() },
      });
    return { ok: true as const, delivered };
  });

export const remindAllServiceAssignments = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) =>
    parseOrThrow(
      z.object({ orgId: idSchema, showId: idSchema }),
      value,
    ),
  )
  .handler(async ({ data }) => {
    await assertAccess(data.orgId, true);
    const assignments = await getPrisma().serviceAssignment.findMany({
      where: {
        orgId: data.orgId,
        showId: data.showId,
        status: "assigned",
        crewMemberId: { not: null },
      },
      select: { id: true, serviceDate: true, role: true, crewMemberId: true },
    });
    const results = await Promise.all(
      assignments.map(async (assignment) => {
        const delivered = await notifyAssignment(
          data.orgId,
          assignment.id,
          assignment.serviceDate,
          assignment.role,
          assignment.crewMemberId!,
          true,
        );
        if (delivered)
          await getPrisma().serviceAssignment.update({
            where: { id: assignment.id },
            data: { invitedAt: new Date() },
          });
        return delivered;
      }),
    );
    return {
      ok: true as const,
      delivered: results.filter(Boolean).length,
      total: assignments.length,
    };
  });

export const deleteServiceAssignment = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, id: idSchema }), value),
  )
  .handler(async ({ data }) => {
    await assertAccess(data.orgId, true);
    const existing = await getPrisma().serviceAssignment.findFirst({
      where: { id: data.id, orgId: data.orgId },
    });
    if (!existing) throw new Error("Assignment not found");
    await getPrisma().serviceAssignment.delete({ where: { id: data.id } });
    return { ok: true };
  });
