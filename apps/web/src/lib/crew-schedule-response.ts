import { getServiceTiming } from "@/lib/service-phase";
import { serviceTimeToIso } from "@/lib/utils";

export type CrewScheduleResponseWindow =
  | { status: "open"; closesAt: string }
  | { status: "closed"; closedAt: string | null };

export interface CrewScheduleResponseInput {
  serviceDate: string;
  scheduledStartTime?: string | null;
  plannedDurationMs?: number;
  serviceWindowMinutes?: number;
  timeZone?: string;
}

function nextServiceDate(serviceDate: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(serviceDate);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(date.getTime())) return null;
  if (date.toISOString().slice(0, 10) !== serviceDate) return null;
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/**
 * Derive the last instant at which an unanswered crew invitation may be
 * accepted. Scheduled services close at their expected end. Untimed services
 * close at the end of their service date in the organization's timezone.
 */
export function getCrewScheduleResponseWindow(
  input: CrewScheduleResponseInput,
  nowMs: number,
): CrewScheduleResponseWindow {
  const timing = getServiceTiming(input);
  let closesAt: string | null =
    timing.expectedEndMs === null
      ? null
      : new Date(timing.expectedEndMs).toISOString();

  if (!closesAt) {
    const nextDate = nextServiceDate(input.serviceDate);
    closesAt = nextDate
      ? serviceTimeToIso(nextDate, "00:00", input.timeZone)
      : null;
  }

  if (!closesAt) return { status: "closed", closedAt: null };
  const closesAtMs = new Date(closesAt).getTime();
  if (!Number.isFinite(closesAtMs) || nowMs >= closesAtMs) {
    return { status: "closed", closedAt: closesAt };
  }
  return { status: "open", closesAt };
}

/** Re-check a serialized response window against the current client clock. */
export function isCrewScheduleResponseOpen(
  window: CrewScheduleResponseWindow,
  nowMs: number,
): boolean {
  return window.status === "open" && nowMs < new Date(window.closesAt).getTime();
}
