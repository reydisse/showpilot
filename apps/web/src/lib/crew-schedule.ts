import {
  resolveWorkspaceProfile,
  WORKSPACE_SETTING_KEYS,
  legacyTerminologyProfile,
} from "@showpilot/shared";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getD1 } from "@/lib/d1";
import { getPrisma } from "@/lib/db";
import { parseOrThrow } from "@/lib/validation";
import { getTodayDateString } from "@/lib/utils";
import { getCrewScheduleResponseWindow } from "@/lib/crew-schedule-response";
import { getAssignmentCallTime } from "@/lib/assignment-call-time";
import { readPhaseSettings } from "@/lib/service-phase";
import { assignmentResponseVersion } from "@/lib/assignment-response-version";

import {
  crewScheduleTokenSchema as publicTokenSchema,
  crewResponseCommandSchema,
  crewResponseSubmissionSchema,
} from "./crew-response-contract";
import {
  resolveCrewScheduleAccess as resolvePortal,
  assertCrewScheduleAccess,
} from "./crew-schedule-access.server";

export async function sendCrewScheduleInvite(input: {
  orgId: string;
  assignmentId: string;
  crewMemberId: string;
  serviceDate: string;
  role: string;
  origin: string;
  reminder?: boolean;
  requestId?: string;
  reviewedAssignment?: { showId: string | null; callTime: string };
  authority?: import("./schedule-invitation-delivery.server").InvitationGuard;
}) {
  const prisma = getPrisma();
  const requestId = input.requestId ?? crypto.randomUUID();
  const accepted = await getD1()
    .prepare(
      "SELECT updatedAt,inAppDelivered FROM schedule_invitation_delivery WHERE orgId=? AND assignmentId=? AND requestId=? AND state='accepted'",
    )
    .bind(input.orgId, input.assignmentId, requestId)
    .first<{ updatedAt: number; inAppDelivered: number }>();
  if (accepted)
    return {
      delivered: true,
      reason: null,
      emailState: "accepted" as const,
      inAppDelivered: !!accepted.inAppDelivered,
      requestId,
      updatedAt: accepted.updatedAt,
    };
  const assignment = await prisma.serviceAssignment.findFirst({
    where: {
      id: input.assignmentId,
      orgId: input.orgId,
      crewMemberId: input.crewMemberId,
    },
    select: {
      showId: true,
      serviceDate: true,
      role: true,
      callTime: true,
      status: true,
    },
  });
  if (!assignment)
    return { delivered: false, reason: "assignment-not-found" as const };
  if (
    input.reviewedAssignment &&
    (assignment.role !== input.role ||
      assignment.serviceDate !== input.serviceDate ||
      assignment.showId !== input.reviewedAssignment.showId ||
      assignment.callTime !== input.reviewedAssignment.callTime)
  )
    return { delivered: false, reason: "assignment-changed" as const };
  const [
    crew,
    org,
    rundown,
    timezoneSetting,
    serviceWindowSetting,
    callLeadSetting,
  ] = await Promise.all([
    prisma.crewMember.findFirst({
      where: { id: input.crewMemberId, orgId: input.orgId },
      select: { name: true, email: true },
    }),
    prisma.organization.findUnique({
      where: { id: input.orgId },
      select: { name: true },
    }),
    prisma.rundown.findFirst({
      where: assignment.showId
        ? { id: assignment.showId, orgId: input.orgId }
        : { orgId: input.orgId, serviceDate: assignment.serviceDate },
      select: {
        name: true,
        scheduledStartTime: true,
        scheduledCallTime: true,
        location: true,
        items: { select: { duration: true } },
      },
    }),
    prisma.appSetting.findUnique({
      where: { orgId_key: { orgId: input.orgId, key: "org-timezone" } },
      select: { value: true },
    }),
    prisma.appSetting.findUnique({
      where: {
        orgId_key: {
          orgId: input.orgId,
          key: "default-service-window-minutes",
        },
      },
      select: { value: true },
    }),
    prisma.appSetting.findUnique({
      where: {
        orgId_key: { orgId: input.orgId, key: "default-call-lead-minutes" },
      },
      select: { value: true },
    }),
  ]);
  if (!crew?.email || !org)
    return { delivered: false, reason: "missing-email" as const };
  const { serviceWindowMinutes } = readPhaseSettings({
    "default-service-window-minutes": serviceWindowSetting?.value ?? "",
  });
  const responseWindow = getCrewScheduleResponseWindow(
    {
      serviceDate: assignment.serviceDate,
      scheduledStartTime: assignment.showId
        ? rundown?.scheduledStartTime?.toISOString()
        : null,
      plannedDurationMs: assignment.showId
        ? rundown?.items.reduce((sum, item) => sum + item.duration, 0)
        : undefined,
      serviceWindowMinutes,
      timeZone: timezoneSetting?.value,
    },
    Date.now(),
  );
  if (assignment.status !== "assigned" || responseWindow.status === "closed") {
    return { delivered: false, reason: "assignment-expired" as const };
  }

  const serviceName = rundown?.name || "Service";
  const effectiveCallTime = getAssignmentCallTime({
    ...assignment,
    scheduledStartTime: rundown?.scheduledStartTime?.toISOString(),
    scheduledCallTime: rundown?.scheduledCallTime?.toISOString(),
    callLeadMinutes: readPhaseSettings({
      "default-call-lead-minutes": callLeadSetting?.value ?? "",
    }).callLeadMinutes,
    timeZone: timezoneSetting?.value,
  });
  const recipientZone = await getD1()
    .prepare(
      `SELECT s.value FROM app_setting s
     JOIN member m ON m.organizationId = s.orgId AND s.key = 'notification-timezone:' || m.userId
     JOIN user u ON u.id = m.userId
     WHERE s.orgId = ? AND LOWER(u.email) = ? LIMIT 1`,
    )
    .bind(input.orgId, crew.email.trim().toLowerCase())
    .first<{ value: string }>();
  const start = effectiveCallTime
    ? new Date(effectiveCallTime).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
        timeZone: recipientZone?.value || timezoneSetting?.value || "UTC",
      })
    : "Time to be confirmed";
  const { crewScheduleEmail } = await import("./email");
  const { deliverScheduleInvitation } =
    await import("./schedule-invitation-delivery.server");
  const terms = resolveWorkspaceProfile(
    Object.fromEntries(
      (
        await prisma.appSetting.findMany({
          where: {
            orgId: input.orgId,
            key: { in: [...WORKSPACE_SETTING_KEYS] },
          },
          select: { key: true, value: true },
        })
      ).map((setting) => [setting.key, setting.value]),
    ),
  ).terms;
  const render = (link: string) => ({
    to: crew.email!,
    ...crewScheduleEmail({
      orgName: org.name,
      serviceName,
      serviceDate: assignment.serviceDate,
      start,
      role: assignment.role,
      location: rundown?.location,
      link,
      reminder: input.reminder,
      terms,
    }),
  });
  const fingerprint = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          JSON.stringify(render("schedule-invitation-link")),
        ),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const guard = {
    sql: `EXISTS(SELECT 1 FROM service_assignment a JOIN crew_member c ON c.id=a.crewMemberId AND c.orgId=a.orgId
      WHERE a.orgId=? AND a.id=? AND a.crewMemberId=? AND a.status='assigned' AND a.serviceDate=? AND a.role=? AND a.callTime=? AND a.showId IS ? AND c.email=?)
      AND julianday('now')<julianday(?) AND NOT EXISTS(SELECT 1 FROM app_setting WHERE orgId=? AND key='organization-deleting')${input.authority ? ` AND (${input.authority.sql})` : ""}`,
    args: [
      input.orgId,
      input.assignmentId,
      input.crewMemberId,
      assignment.serviceDate,
      assignment.role,
      assignment.callTime,
      assignment.showId,
      crew.email,
      responseWindow.closesAt,
      input.orgId,
      ...(input.authority?.args ?? []),
    ],
  };
  return deliverScheduleInvitation({
    orgId: input.orgId,
    assignmentId: input.assignmentId,
    crewMemberId: input.crewMemberId,
    requestId,
    origin: input.origin,
    fingerprint,
    guard,
    render,
    notify: async (deliveryId) => {
      const { notifyAssignmentRecipient } =
        await import("./assignment-notifications.server");
      return (
        await notifyAssignmentRecipient({
          orgId: input.orgId,
          assignmentId: input.assignmentId,
          crewEmail: crew.email!,
          serviceName,
          serviceDate: assignment.serviceDate,
          role: assignment.role,
          start,
          reminder: input.reminder,
          deliveryId,
        })
      ).notified;
    },
  });
}

type PortalAssignmentRow = {
  id: string;
  revision: string | null;
  showId: string | null;
  serviceDate: string;
  role: string;
  status: string;
  notes: string;
  responseNote: string;
  callTime: string;
  invitedAt: string | null;
  respondedAt: string | null;
  responseVersion?: string;
};

export const getCrewSchedulePortal = createServerFn({ method: "GET" })
  .inputValidator((value: unknown) =>
    parseOrThrow(z.object({ token: publicTokenSchema }), value),
  )
  .handler(async ({ data }) => {
    const access = await resolvePortal(data.token);
    const prisma = getPrisma();
    const [crew, org, settings] = await Promise.all([
      prisma.crewMember.findFirst({
        where: { id: access.crewMemberId, orgId: access.orgId },
        select: { name: true },
      }),
      prisma.organization.findUnique({
        where: { id: access.orgId },
        select: { name: true },
      }),
      prisma.appSetting.findMany({
        where: {
          orgId: access.orgId,
          key: {
            in: [
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
    const settingMap = Object.fromEntries(
      settings.map((setting) => [setting.key, setting.value]),
    );
    const today = getTodayDateString(settingMap["org-timezone"]);
    const threshold = new Date(`${today}T12:00:00`);
    threshold.setDate(threshold.getDate() - 1);
    const assignments = await getD1()
      .prepare(
        "SELECT id, (SELECT revision FROM schedule_assignment_revision v WHERE v.orgId=service_assignment.orgId AND v.assignmentId=service_assignment.id) AS revision, showId, serviceDate, role, status, callTime, notes, responseNote, invitedAt, respondedAt FROM service_assignment WHERE orgId = ? AND crewMemberId = ? AND (serviceDate >= ? OR id = ?) ORDER BY CASE WHEN id = ? THEN 0 WHEN serviceDate >= ? THEN 1 ELSE 2 END, serviceDate ASC LIMIT 20",
      )
      .bind(
        access.orgId,
        access.crewMemberId,
        threshold.toISOString().slice(0, 10),
        access.assignmentId,
        access.assignmentId,
        today,
      )
      .all<PortalAssignmentRow>();
    const rows = assignments.results ?? [];
    const showIds = rows
      .map((row) => row.showId)
      .filter((value): value is string => Boolean(value));
    const rundowns = showIds.length
      ? await prisma.rundown.findMany({
          where: { orgId: access.orgId, id: { in: showIds } },
          select: {
            id: true,
            serviceDate: true,
            name: true,
            scheduledStartTime: true,
            scheduledCallTime: true,
            location: true,
            items: { select: { duration: true } },
          },
        })
      : [];
    const rundownMap = new Map(
      rundowns.map((rundown) => [rundown.id, rundown]),
    );
    const { serviceWindowMinutes } = readPhaseSettings(settingMap);
    const nowMs = Date.now();
    const result = {
      crewName: crew?.name ?? "Crew member",
      orgName: org?.name ?? "Organization",
      today,
      responseAsOf: nowMs,
      initialAssignmentId: access.assignmentId,
      orgTimezone: settingMap["org-timezone"],
      terminologyProfile: legacyTerminologyProfile(
        resolveWorkspaceProfile(settingMap).type,
      ),
      workspace: resolveWorkspaceProfile(settingMap),
      assignments: rows.map((assignment) => {
        const rundown = assignment.showId
          ? rundownMap.get(assignment.showId)
          : undefined;
        const effectiveCallTime = getAssignmentCallTime({
          ...assignment,
          scheduledStartTime: rundown?.scheduledStartTime?.toISOString(),
          scheduledCallTime: rundown?.scheduledCallTime?.toISOString(),
          callLeadMinutes: readPhaseSettings(settingMap).callLeadMinutes,
          timeZone: settingMap["org-timezone"],
        });
        return {
          ...assignment,
          responseVersion: assignmentResponseVersion({
            effectiveCallTime,
            showId: assignment.showId,
            serviceDate: assignment.serviceDate,
            role: assignment.role,
            callTime: assignment.callTime,
            scheduledStartTime:
              rundown?.scheduledStartTime?.toISOString() ?? null,
          }),
          serviceName: rundown?.name || "Show",
          scheduledStartTime:
            rundown?.scheduledStartTime?.toISOString() ?? null,
          callTime: assignment.callTime,
          effectiveCallTime,
          location: rundown?.location ?? "",
          responseWindow: getCrewScheduleResponseWindow(
            {
              serviceDate: assignment.serviceDate,
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
        };
      }),
    };
    await assertCrewScheduleAccess(access);
    return result;
  });

export const respondToCrewScheduleInvite = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) =>
    parseOrThrow(crewResponseSubmissionSchema, value),
  )
  .handler(async ({ data }) => {
    const { writeCrewScheduleResponse } =
      await import("./crew-response.server");
    const modern = "requestId" in data;
    const result = await writeCrewScheduleResponse(data.token, {
      ...data,
      requestId: modern ? data.requestId : crypto.randomUUID(),
      expectedRevision: modern ? data.expectedRevision : null,
    });
    if (modern) return result;
    if (result.outcome === "applied") return { ok: true as const };
    throw new Error(
      result.outcome === "closed"
        ? "This assignment is closed because its scheduled event has ended"
        : result.outcome === "unavailable"
          ? "Assignment not found"
          : "This assignment changed or already has a response. Review the current details before responding.",
    );
  });
export const reviewCrewScheduleResponse = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) =>
    parseOrThrow(crewResponseCommandSchema, value),
  )
  .handler(async ({ data }) => {
    const { writeCrewScheduleResponse } =
      await import("./crew-response.server");
    return writeCrewScheduleResponse(data.token, data, true);
  });
