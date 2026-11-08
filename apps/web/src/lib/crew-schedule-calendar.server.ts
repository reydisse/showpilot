import { z } from "zod";
import { getPrisma } from "./db";
import { crewScheduleTokenSchema as publicTokenSchema } from "./crew-response-contract";
import {
  resolveCrewScheduleAccess as resolvePortal,
  assertCrewScheduleAccess,
} from "./crew-schedule-access.server";
import { getAssignmentCallTime } from "./assignment-call-time";
import { readPhaseSettings } from "./service-phase";
function calendarStamp(date: Date) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

function calendarText(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

export async function getCrewScheduleCalendar(
  token: string,
  assignmentId: string,
) {
  const parsedToken = publicTokenSchema.parse(token);
  const parsedAssignmentId = z.string().min(1).max(128).parse(assignmentId);
  const access = await resolvePortal(parsedToken);
  const assignment = await getPrisma().serviceAssignment.findFirst({
    where: {
      id: parsedAssignmentId,
      orgId: access.orgId,
      crewMemberId: access.crewMemberId,
    },
    select: {
      id: true,
      showId: true,
      serviceDate: true,
      role: true,
      notes: true,
      callTime: true,
    },
  });
  if (!assignment) throw new Error("Assignment not found");
  const [rundown, timezoneSetting, callLeadSetting] = await Promise.all([
    getPrisma().rundown.findFirst({
      where: assignment.showId
        ? { id: assignment.showId, orgId: access.orgId }
        : { orgId: access.orgId, serviceDate: assignment.serviceDate },
      select: {
        name: true,
        scheduledStartTime: true,
        scheduledCallTime: true,
        location: true,
      },
    }),
    getPrisma().appSetting.findUnique({
      where: { orgId_key: { orgId: access.orgId, key: "org-timezone" } },
      select: { value: true },
    }),
    getPrisma().appSetting.findUnique({
      where: {
        orgId_key: { orgId: access.orgId, key: "default-call-lead-minutes" },
      },
      select: { value: true },
    }),
  ]);
  const callIso = getAssignmentCallTime({
    ...assignment,
    scheduledStartTime: rundown?.scheduledStartTime?.toISOString(),
    scheduledCallTime: rundown?.scheduledCallTime?.toISOString(),
    callLeadMinutes: readPhaseSettings({
      "default-call-lead-minutes": callLeadSetting?.value ?? "",
    }).callLeadMinutes,
    timeZone: timezoneSetting?.value,
  });
  if (!callIso)
    throw new Error(
      "Set a call time or show start time before downloading the calendar.",
    );
  const start = new Date(callIso);
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
  const title = `${rundown?.name || "Service"} — ${assignment.role}`;
  const content = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "PRODID:-//ShowPilot//Crew Schedule//EN",
    "BEGIN:VEVENT",
    `UID:${assignment.id}@showpilot.tech`,
    `DTSTAMP:${calendarStamp(new Date())}`,
    `DTSTART:${calendarStamp(start)}`,
    `DTEND:${calendarStamp(end)}`,
    `SUMMARY:${calendarText(title)}`,
    ...(rundown?.location
      ? [`LOCATION:${calendarText(rundown.location)}`]
      : []),
    `DESCRIPTION:${calendarText(assignment.notes || `Scheduled as ${assignment.role}`)}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  const filename = `${
    (rundown?.name || "showpilot-service")
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase() || "showpilot-service"
  }.ics`;
  await assertCrewScheduleAccess(access);
  return { content, filename };
}
