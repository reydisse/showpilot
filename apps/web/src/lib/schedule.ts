import {
  resolveWorkspaceProfile,
  legacyTerminologyProfile,
} from "@showpilot/shared";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getPrisma } from "@/lib/db";
import { getD1 } from "@/lib/d1";
import { assertOrgPermission, getRequestOrgAccess } from "@/lib/org-access";
import { idSchema, parseOrThrow, serviceDateSchema } from "@/lib/validation";
import { editServiceTimeToIso } from "@/lib/utils";
import { getCrewScheduleResponseWindow } from "@/lib/crew-schedule-response";
import { getServiceTiming, readPhaseSettings } from "@/lib/service-phase";
import { buildScheduleQuerySelection } from "@/lib/schedule-selection";
import { deleteServiceForOrg } from "@/lib/service-deletion.server";
import { env } from "cloudflare:workers";
import { updateRundownMetadataThroughRelay } from "@/lib/rundown-meta-update.server";
import { getAssignmentCallTime } from "@/lib/assignment-call-time";
import { assignmentResponseVersion } from "@/lib/assignment-response-version";

import { scheduleProviderSchema } from "./schedule-provider-contract";

const rangeInput = z.object({
  orgId: idSchema,
  from: serviceDateSchema,
  to: serviceDateSchema,
  selectedDate: serviceDateSchema.optional(),
  selectedShowId: idSchema.optional(),
});

export type { ScheduleProvider } from "./schedule-provider-contract";

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
        timeZone: z.string().min(1).max(100).optional(),
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
      select: { id: true, scheduledStartTime: true, scheduledCallTime: true },
    });
    if (!show) throw new Error("Show not found");
    const timezone = await getPrisma().appSetting.findUnique({
      where: { orgId_key: { orgId: data.orgId, key: "org-timezone" } },
      select: { value: true },
    });
    const scheduledStartIso = editServiceTimeToIso({ serviceDate: data.serviceDate, time: data.startTime, timeZone: data.timeZone || timezone?.value || "UTC", referenceTime: show.scheduledStartTime });
    const scheduledStartTime = scheduledStartIso ? new Date(scheduledStartIso) : null;
    const scheduledCallIso = editServiceTimeToIso({ serviceDate: data.serviceDate, time: data.callTime, timeZone: data.timeZone || timezone?.value || "UTC", referenceTime: show.scheduledCallTime ?? show.scheduledStartTime });
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
              "workspace-type",
              "workspace-modules",
              "workspace-custom",
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
    const workspace = resolveWorkspaceProfile(providerMap);
    const terminologyProfile = legacyTerminologyProfile(workspace.type);
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
        effectiveCallTime: getAssignmentCallTime({
          ...assignment,
          scheduledStartTime: assignment.showId ? serviceById.get(assignment.showId)?.scheduledStartTime : null,
          scheduledCallTime: assignment.showId ? serviceById.get(assignment.showId)?.scheduledCallTime : null,
          callLeadMinutes,
          timeZone: providerMap["org-timezone"],
        }),
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
      workspace,
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
          scheduledCallTime: true,
          items: { select: { duration: true } },
        },
      }),
      prisma.appSetting.findMany({
        where: {
          orgId: data.orgId,
          key: { in: ["org-timezone", "default-service-window-minutes", "default-call-lead-minutes"] },
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
      effectiveCallTime: getAssignmentCallTime({
        ...assignment,
        scheduledStartTime: rundown?.scheduledStartTime?.toISOString(),
        scheduledCallTime: rundown?.scheduledCallTime?.toISOString(),
        callLeadMinutes: readPhaseSettings(settingMap).callLeadMinutes,
        timeZone: settingMap["org-timezone"],
      }),
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
              scheduledCallTime: true,
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
          key: { in: ["org-timezone", "default-service-window-minutes", "default-call-lead-minutes"] },
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
      assignments: assignments.map((assignment) => {
        const effectiveCallTime = getAssignmentCallTime({
          ...assignment,
          scheduledStartTime: assignment.show?.scheduledStartTime?.toISOString(),
          scheduledCallTime: assignment.show?.scheduledCallTime?.toISOString(),
          callLeadMinutes: readPhaseSettings(settingMap).callLeadMinutes,
          timeZone: settingMap["org-timezone"],
        });
        return {
          id: assignment.id,
          showId: assignment.showId,
          serviceDate: assignment.serviceDate,
          role: assignment.role,
          department: assignment.department,
          status: assignment.status,
          callTime: assignment.callTime,
          effectiveCallTime,
          notes: assignment.notes,
          responseNote: assignment.responseNote,
          respondedAt: assignment.respondedAt?.toISOString() ?? null,
          serviceName: assignment.show?.name || "Show",
          scheduledStartTime:
            assignment.show?.scheduledStartTime?.toISOString() ?? null,
          location: assignment.show?.location ?? "",
          responseVersion: assignmentResponseVersion({
            effectiveCallTime,
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
        };
      }),
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
              scheduledCallTime: true,
              items: { select: { duration: true } },
            },
          },
        },
      }),
      prisma.appSetting.findMany({
        where: {
          orgId: data.orgId,
          key: { in: ["org-timezone", "default-service-window-minutes", "default-call-lead-minutes"] },
        },
        select: { key: true, value: true },
      }),
    ]);
    if (!assignment) throw new Error("Assignment not found");
    const settingMap = Object.fromEntries(
      settings.map((setting) => [setting.key, setting.value]),
    );
    const currentVersion = assignmentResponseVersion({
      effectiveCallTime: getAssignmentCallTime({
        ...assignment,
        scheduledStartTime: assignment.show?.scheduledStartTime?.toISOString(),
        scheduledCallTime: assignment.show?.scheduledCallTime?.toISOString(),
        callLeadMinutes: readPhaseSettings(settingMap).callLeadMinutes,
        timeZone: settingMap["org-timezone"],
      }),
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
