import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getPrisma } from "@/lib/db";
import { getD1 } from "@/lib/d1";
import { assertOrgPermission, getRequestOrgAccess } from "@/lib/org-access";
import { idSchema, parseOrThrow, serviceDateSchema } from "@/lib/validation";
import { orgTerminologyProfileSchema } from "@/lib/org-terminology";
import { serviceTimeToIso } from "@/lib/utils";
import { getCrewScheduleResponseWindow } from "@/lib/crew-schedule-response";
import { getServiceTiming, readPhaseSettings } from "@/lib/service-phase";
import { buildScheduleQuerySelection } from "@/lib/schedule-selection";
import { deleteServiceForOrg } from "@/lib/service-deletion.server";
import { deliverScheduleAssignmentInvitation } from "@/lib/schedule-assignment-delivery.server";
import { env } from "cloudflare:workers";
import { updateRundownMetadataThroughRelay } from "@/lib/rundown-meta-update.server";
import { assignmentResponseVersion } from "@/lib/assignment-response-version";

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
        callTime: z.union([
          z.literal(""),
          z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        ]).default(""),
        location: z.string().trim().max(240),
        expectedUpdatedAt: z.string().min(1).max(64),
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
    const scheduledCallIso = serviceTimeToIso(data.serviceDate, data.callTime, timezone?.value);
    const scheduledCallTime = scheduledCallIso ? new Date(scheduledCallIso) : null;
    await updateRundownMetadataThroughRelay({
      env: env as unknown as {
        DB: D1Database;
        RUNDOWN_RELAY?: DurableObjectNamespace<import("@/durable-objects/RundownRelay").RundownRelay>;
      },
      orgId: data.orgId,
      showId: show.id,
      serviceDate: data.serviceDate,
      expectedUpdatedAt: data.expectedUpdatedAt,
      payload: {
        serviceName: data.name,
        scheduledStartTime: scheduledStartTime?.toISOString() ?? null,
        scheduledCallTime: scheduledCallTime?.toISOString() ?? null,
        location: data.location,
      },
    });
    return getPrisma().rundown.findUniqueOrThrow({ where: { id: show.id } });
  });

export const deleteService = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, showId: idSchema }), value),
  )
  .handler(async ({ data }) => {
    await assertAccess(data.orgId, true);
    return deleteServiceForOrg(data);
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
    const selection = buildScheduleQuerySelection(data);
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
        where: { orgId: data.orgId, OR: selection.rundowns },
        orderBy: [
          { serviceDate: "asc" },
          { scheduledStartTime: "asc" },
          { createdAt: "asc" },
        ],
      }),
      prisma.rundownItem.findMany({
        where: { orgId: data.orgId, OR: selection.related },
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
        where: { orgId: data.orgId, OR: selection.related },
        include: {
          crewMember: {
            select: { id: true, name: true, role: true, email: true },
          },
        },
        orderBy: { role: "asc" },
      }),
      prisma.checklistEntry.findMany({
        where: { orgId: data.orgId, OR: selection.related },
        select: { showId: true, serviceDate: true, checked: true },
      }),
      prisma.incident.findMany({
        where: { orgId: data.orgId, OR: selection.related },
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
              "org-timezone",
              "default-service-window-minutes",
              "default-call-lead-minutes",
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
    const { serviceWindowMinutes, callLeadMinutes } = readPhaseSettings(providerMap);
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
      const callTimeMs = getServiceTiming({
        scheduledStartTime: rundown.scheduledStartTime?.toISOString(),
        scheduledCallTime: rundown.scheduledCallTime?.toISOString(),
        callLeadMinutes,
      }).callTimeMs;
      return {
        id: rundown.id,
        updatedAt: rundown.updatedAt.toISOString(),
        serviceDate: rundown.serviceDate,
        name: rundown.name || "Service",
        scheduledStartTime: rundown.scheduledStartTime?.toISOString() ?? null,
        scheduledCallTime: rundown.scheduledCallTime?.toISOString() ?? null,
        effectiveCallTime: callTimeMs === null ? null : new Date(callTimeMs).toISOString(),
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
    const serviceById = new Map(services.map((service) => [service.id, service]));
    const nowMs = Date.now();
    return {
      services,
      selectedDate: selectedDate ?? null,
      assignments: assignments.map((assignment) => ({
        ...assignment,
        canRespond:
          Boolean(assignment.crewMember?.email) &&
          assignment.crewMember!.email.toLowerCase() === viewer.email,
        responseWindow: getCrewScheduleResponseWindow(
          (() => {
            const service = assignment.showId
              ? serviceById.get(assignment.showId)
              : undefined;
            return {
              serviceDate: assignment.serviceDate,
              scheduledStartTime: service?.scheduledStartTime,
              plannedDurationMs: service?.plannedDurationMs,
              serviceWindowMinutes,
              timeZone: providerMap["org-timezone"],
            };
          })(),
          nowMs,
        ),
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
    const prisma = getPrisma();
    const [assignments, rundown, settings] = await Promise.all([
      prisma.serviceAssignment.findMany({
        where: { orgId: data.orgId, showId: data.showId },
        include: {
          crewMember: {
            select: { id: true, name: true, role: true, email: true },
          },
        },
        orderBy: [{ department: "asc" }, { role: "asc" }],
      }),
      prisma.rundown.findFirst({
        where: { id: data.showId, orgId: data.orgId },
        select: {
          serviceDate: true,
          scheduledStartTime: true,
          items: { select: { duration: true } },
        },
      }),
      prisma.appSetting.findMany({
        where: {
          orgId: data.orgId,
          key: { in: ["org-timezone", "default-service-window-minutes"] },
        },
        select: { key: true, value: true },
      }),
    ]);
    const settingMap = Object.fromEntries(
      settings.map((setting) => [setting.key, setting.value]),
    );
    const { serviceWindowMinutes } = readPhaseSettings(settingMap);
    const nowMs = Date.now();
    return assignments.map((assignment) => ({
      ...assignment,
      canRespond:
        Boolean(assignment.crewMember?.email) &&
        assignment.crewMember!.email.toLowerCase() === viewer.email,
      responseWindow: getCrewScheduleResponseWindow(
        {
          serviceDate: rundown?.serviceDate ?? assignment.serviceDate,
          scheduledStartTime: rundown?.scheduledStartTime?.toISOString(),
          plannedDurationMs: rundown?.items.reduce(
            (sum, item) => sum + item.duration,
            0,
          ),
          serviceWindowMinutes,
          timeZone: settingMap["org-timezone"],
        },
        nowMs,
      ),
    }));
  });

const myAssignmentsInput = z.object({
  orgId: idSchema,
  assignmentId: idSchema.optional(),
});

async function getPersonalCrewMember(orgId: string) {
  const requestAccess = await getRequestOrgAccess(orgId);
  const crew = await getD1()
    .prepare(
      "SELECT id, name FROM crew_member WHERE orgId = ? AND LOWER(email) = ? LIMIT 1",
    )
    .bind(orgId, requestAccess.user.email.trim().toLowerCase())
    .first<{ id: string; name: string }>();
  return { requestAccess, crew };
}

export const getMyAssignments = createServerFn({ method: "GET" })
  .inputValidator((value: unknown) => parseOrThrow(myAssignmentsInput, value))
  .handler(async ({ data }) => {
    const { crew } = await getPersonalCrewMember(data.orgId);
    if (!crew) {
      return {
        crewName: "Crew member",
        requestedFound: !data.assignmentId,
        orgTimezone: "UTC",
        assignments: [],
      };
    }
    const prisma = getPrisma();
    const [assignments, settings] = await Promise.all([
      prisma.serviceAssignment.findMany({
        where: {
          orgId: data.orgId,
          crewMemberId: crew.id,
          ...(data.assignmentId ? { id: data.assignmentId } : {}),
        },
        include: {
          show: {
            select: {
              name: true,
              scheduledStartTime: true,
              location: true,
              items: { select: { duration: true } },
            },
          },
        },
        orderBy: [{ serviceDate: "desc" }, { createdAt: "desc" }],
        take: 50,
      }),
      prisma.appSetting.findMany({
        where: {
          orgId: data.orgId,
          key: { in: ["org-timezone", "default-service-window-minutes"] },
        },
        select: { key: true, value: true },
      }),
    ]);
    const settingMap = Object.fromEntries(
      settings.map((setting) => [setting.key, setting.value]),
    );
    const { serviceWindowMinutes } = readPhaseSettings(settingMap);
    const nowMs = Date.now();
    return {
      crewName: crew.name,
      requestedFound: !data.assignmentId || assignments.length === 1,
      orgTimezone: settingMap["org-timezone"] || "UTC",
      assignments: assignments.map((assignment) => ({
        id: assignment.id,
        showId: assignment.showId,
        serviceDate: assignment.serviceDate,
        role: assignment.role,
        department: assignment.department,
        status: assignment.status,
        callTime: assignment.callTime,
        notes: assignment.notes,
        responseNote: assignment.responseNote,
        respondedAt: assignment.respondedAt?.toISOString() ?? null,
        serviceName: assignment.show?.name || "Show",
        scheduledStartTime:
          assignment.show?.scheduledStartTime?.toISOString() ?? null,
        location: assignment.show?.location ?? "",
        responseVersion: assignmentResponseVersion({
          showId: assignment.showId,
          serviceDate: assignment.serviceDate,
          role: assignment.role,
          callTime: assignment.callTime,
          scheduledStartTime:
            assignment.show?.scheduledStartTime?.toISOString() ?? null,
        }),
        responseWindow: getCrewScheduleResponseWindow(
          {
            serviceDate: assignment.serviceDate,
            scheduledStartTime:
              assignment.show?.scheduledStartTime?.toISOString(),
            plannedDurationMs: assignment.show?.items.reduce(
              (sum, item) => sum + item.duration,
              0,
            ),
            serviceWindowMinutes,
            timeZone: settingMap["org-timezone"],
          },
          nowMs,
        ),
      })),
    };
  });

export const respondToMyAssignment = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) =>
    parseOrThrow(
      myAssignmentsInput.extend({
        assignmentId: idSchema,
        response: z.enum(["confirmed", "declined"]),
        reason: z.string().trim().max(500).default(""),
        reviewedVersion: z.string().min(2).max(512),
      }),
      value,
    ),
  )
  .handler(async ({ data }) => {
    const { requestAccess, crew } = await getPersonalCrewMember(data.orgId);
    if (!crew) throw new Error("Assignment not found");
    const prisma = getPrisma();
    const [assignment, settings] = await Promise.all([
      prisma.serviceAssignment.findFirst({
        where: {
          id: data.assignmentId,
          orgId: data.orgId,
          crewMemberId: crew.id,
        },
        include: {
          show: {
            select: {
              scheduledStartTime: true,
              items: { select: { duration: true } },
            },
          },
        },
      }),
      prisma.appSetting.findMany({
        where: {
          orgId: data.orgId,
          key: { in: ["org-timezone", "default-service-window-minutes"] },
        },
        select: { key: true, value: true },
      }),
    ]);
    if (!assignment) throw new Error("Assignment not found");
    const currentVersion = assignmentResponseVersion({
      showId: assignment.showId,
      serviceDate: assignment.serviceDate,
      role: assignment.role,
      callTime: assignment.callTime,
      scheduledStartTime:
        assignment.show?.scheduledStartTime?.toISOString() ?? null,
    });
    if (currentVersion !== data.reviewedVersion) {
      throw new Error(
        "This assignment changed. Review the updated details before responding.",
      );
    }
    const settingMap = Object.fromEntries(
      settings.map((setting) => [setting.key, setting.value]),
    );
    const { serviceWindowMinutes } = readPhaseSettings(settingMap);
    const responseWindow = getCrewScheduleResponseWindow(
      {
        serviceDate: assignment.serviceDate,
        scheduledStartTime:
          assignment.show?.scheduledStartTime?.toISOString(),
        plannedDurationMs: assignment.show?.items.reduce(
          (sum, item) => sum + item.duration,
          0,
        ),
        serviceWindowMinutes,
        timeZone: settingMap["org-timezone"],
      },
      Date.now(),
    );
    if (assignment.status !== "assigned") {
      throw new Error("A response has already been recorded for this assignment");
    }
    if (responseWindow.status === "closed") {
      throw new Error("This assignment is closed because the show has ended");
    }
    const update = await getD1()
      .prepare(
        "UPDATE service_assignment SET status = ?, responseNote = ?, respondedAt = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP WHERE id = ? AND orgId = ? AND crewMemberId = ? AND status = 'assigned'",
      )
      .bind(
        data.response,
        data.reason,
        assignment.id,
        data.orgId,
        crew.id,
      )
      .run();
    if (!update.success || update.meta.changes !== 1) {
      throw new Error("A response has already been recorded for this assignment");
    }
    const { notifyOperationalEvent } = await import(
      "@/lib/operational-notifications.server"
    );
    const responseLabel =
      data.response === "confirmed" ? "accepted" : "declined";
    await notifyOperationalEvent({
      orgId: data.orgId,
      actorId: requestAccess.user.id,
      recipientIds: assignment.assignedByUserId
        ? [assignment.assignedByUserId]
        : [],
      category: "schedule",
      type: `assignment-${data.response}`,
      severity: data.response === "declined" ? "warning" : "info",
      title: `${crew.name} ${responseLabel} an assignment`,
      message: `${assignment.role} · ${assignment.serviceDate}${data.reason ? ` · ${data.reason}` : ""}`,
      actionUrl: `schedule?date=${encodeURIComponent(assignment.serviceDate)}&assignment=${encodeURIComponent(assignment.id)}`,
      source: assignment.id,
      pushTag: `assignment-response-${assignment.id}`,
    });
    return { ok: true as const };
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
    const actor = await assertAccess(data.orgId, true);
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
            assignedByUserId: actor.userId,
            status: "assigned",
            callTime: data.callTime,
            notes: data.notes,
            invitedAt: null,
          },
        });
        if (data.crewMemberId) {
          const delivered = await deliverScheduleAssignmentInvitation(
            data.orgId,
            replacement.id,
            replacement.serviceDate,
            replacement.role,
            data.crewMemberId,
          );
          if (delivered.delivered) {
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
            ? {
                status: "assigned",
                responseNote: "",
                respondedAt: null,
                invitedAt: null,
                assignedByUserId: actor.userId,
              }
            : {}),
        },
      });
      if (personChanged) {
        const { clearAssignmentInvitation } = await import(
          "@/lib/assignment-notifications.server"
        );
        await clearAssignmentInvitation(data.orgId, updated.id);
      }
      if (personChanged && data.crewMemberId) {
        const delivered = await deliverScheduleAssignmentInvitation(
          data.orgId,
          updated.id,
          updated.serviceDate,
          updated.role,
          data.crewMemberId,
        );
        if (delivered.delivered)
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
        assignedByUserId: actor.userId,
        status: data.status,
        callTime: data.callTime,
        notes: data.notes,
        invitedAt: null,
      },
    });
    if (data.crewMemberId && data.status === "assigned") {
      const delivered = await deliverScheduleAssignmentInvitation(
        data.orgId,
        assignment.id,
        data.serviceDate,
        data.role,
        data.crewMemberId,
      );
      if (delivered.delivered)
        return getPrisma().serviceAssignment.update({
          where: { id: assignment.id },
          data: { invitedAt: new Date() },
        });
    }
    return assignment;
  });

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
    const delivered = await deliverScheduleAssignmentInvitation(
      data.orgId,
      assignment.id,
      assignment.serviceDate,
      assignment.role,
      assignment.crewMemberId,
      true,
    );
    if (!delivered.delivered && delivered.reason === "assignment-expired") {
      throw new Error("This assignment is closed because the service has ended");
    }
    if (delivered.delivered)
      await getPrisma().serviceAssignment.update({
        where: { id: assignment.id },
        data: { invitedAt: new Date() },
      });
    return { ok: true as const, delivered: delivered.delivered };
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
        const delivered = await deliverScheduleAssignmentInvitation(
          data.orgId,
          assignment.id,
          assignment.serviceDate,
          assignment.role,
          assignment.crewMemberId!,
          true,
        );
        if (delivered.delivered)
          await getPrisma().serviceAssignment.update({
            where: { id: assignment.id },
            data: { invitedAt: new Date() },
          });
        return delivered;
      }),
    );
    const availableResults = results.filter(
      (result) => result.reason !== "assignment-expired",
    );
    return {
      ok: true as const,
      delivered: availableResults.filter((result) => result.delivered).length,
      total: availableResults.length,
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
    const db = getD1();
    await db.batch([
      db
        .prepare("DELETE FROM notification WHERE orgId = ? AND source = ?")
        .bind(data.orgId, data.id),
      db
        .prepare("DELETE FROM service_assignment WHERE orgId = ? AND id = ?")
        .bind(data.orgId, data.id),
    ]);
    return { ok: true };
  });
