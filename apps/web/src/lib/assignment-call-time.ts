import { getServiceTiming } from "./service-phase";
import { editServiceTimeToIso, formatTimeInput, serviceTimeToIso } from "./utils";

/** Resolve arrival time consistently for invitations, schedules and calendars. */
export function getAssignmentCallTime(input: {
  serviceDate: string;
  callTime: string;
  scheduledStartTime?: string | null;
  scheduledCallTime?: string | null;
  callLeadMinutes?: number;
  timeZone?: string;
}): string | null {
  if (input.callTime) {
    return serviceTimeToIso(input.serviceDate, input.callTime, input.timeZone || "UTC");
  }
  if (input.scheduledCallTime) return input.scheduledCallTime;
  const { callTimeMs } = getServiceTiming(input);
  return callTimeMs === null ? null : new Date(callTimeMs).toISOString();
}

/** Assignment overrides are stored as venue wall times; forms accept device wall times. */
export function assignmentCallTimeForStorage(input: {
  serviceDate: string;
  callTime: string;
  deviceTimeZone: string;
  venueTimeZone: string;
  referenceTime?: string | null;
}): string {
  if (!input.callTime) return "";
  const iso = editServiceTimeToIso({
    serviceDate: input.serviceDate,
    time: input.callTime,
    timeZone: input.deviceTimeZone,
    referenceTime: input.referenceTime,
  });
  if (!iso) return "";
  const venueDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: input.venueTimeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(iso));
  if (venueDate !== input.serviceDate) {
    throw new Error("This individual call falls on another venue date. Set the show's crew call for an overnight arrival.");
  }
  return formatTimeInput(iso, input.venueTimeZone);
}
