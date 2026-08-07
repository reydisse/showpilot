/**
 * Service phase — the single derived value that drives what a role
 * dashboard shows.
 *
 * The production dashboard is not a "today" view. A PM's work is
 * week-shaped: planning days look nothing like a call-time morning,
 * which looks nothing like a live service. One phase value keeps that
 * logic in one place so PM, TM and any future role dashboard agree on
 * what time it is.
 *
 * Pure module — no server imports, no Date.now() calls without an
 * explicit `now`. Everything here is unit-testable.
 */

export type ServicePhase = "planning" | "prep" | "call" | "live" | "debrief";

/** Minutes before scheduled start that crew is expected on site. */
export const DEFAULT_CALL_LEAD_MINUTES = 90;

/** Expected service length when the org hasn't set one. */
export const DEFAULT_SERVICE_WINDOW_MINUTES = 90;

/** Org setting keys. Both use the `default-` prefix so they fall under
 *  the existing `settings:production_defaults` permission mapping. */
export const CALL_LEAD_SETTING_KEY = "default-call-lead-minutes";
export const SERVICE_WINDOW_SETTING_KEY = "default-service-window-minutes";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** A service enters `prep` this far before its scheduled start. */
export const PREP_WINDOW_MS = 48 * HOUR_MS;

/** How long after the service ends the dashboard stays in `debrief`. */
export const DEBRIEF_WINDOW_MS = 6 * HOUR_MS;

export interface PhaseInput {
  /** ISO timestamp from Rundown.scheduledStartTime. */
  scheduledStartTime?: string | null;
  /** Rundown.status. */
  status?: "stopped" | "live" | "complete";
  /** Sum of rundown item durations, ms. Falls back to the service window. */
  plannedDurationMs?: number;
  callLeadMinutes?: number;
  serviceWindowMinutes?: number;
}

export interface ServiceTiming {
  scheduledStartMs: number | null;
  callTimeMs: number | null;
  expectedEndMs: number | null;
}

function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Resolve the three timestamps every phase decision depends on.
 * `expectedEnd` prefers the real planned runtime over the configured
 * window — a rundown that says 79 minutes is better evidence than a
 * setting that says 90.
 */
export function getServiceTiming(input: PhaseInput): ServiceTiming {
  const scheduledStartMs = toMs(input.scheduledStartTime);
  if (scheduledStartMs === null) {
    return { scheduledStartMs: null, callTimeMs: null, expectedEndMs: null };
  }

  const callLead = positive(input.callLeadMinutes, DEFAULT_CALL_LEAD_MINUTES);
  const windowMinutes = positive(input.serviceWindowMinutes, DEFAULT_SERVICE_WINDOW_MINUTES);
  const durationMs = positive(input.plannedDurationMs, windowMinutes * MINUTE_MS);

  return {
    scheduledStartMs,
    callTimeMs: scheduledStartMs - callLead * MINUTE_MS,
    expectedEndMs: scheduledStartMs + durationMs,
  };
}

/**
 * Which phase the given service is in at `nowMs`.
 *
 * A running rundown always wins — if the operator pressed go, we are
 * live regardless of what the clock says.
 */
export function getServicePhase(input: PhaseInput, nowMs: number): ServicePhase {
  if (input.status === "live") return "live";

  const { scheduledStartMs, callTimeMs, expectedEndMs } = getServiceTiming(input);

  // No start time set: there is nothing to count down to, so the only
  // useful job is planning.
  if (scheduledStartMs === null || callTimeMs === null || expectedEndMs === null) {
    return "planning";
  }

  if (nowMs >= expectedEndMs) {
    return nowMs < expectedEndMs + DEBRIEF_WINDOW_MS ? "debrief" : "planning";
  }

  // Explicitly completed before its expected end still means debrief.
  if (input.status === "complete") return "debrief";

  if (nowMs >= callTimeMs) return "call";
  if (scheduledStartMs - nowMs <= PREP_WINDOW_MS) return "prep";

  return "planning";
}

export interface PhaseCountdown {
  /** What the countdown is aimed at. Null when there is nothing to aim at. */
  targetMs: number | null;
  /** Signed ms remaining. Negative means the target has passed. */
  remainingMs: number | null;
  label: string;
  direction: "down" | "up";
}

/**
 * What the header should count toward in each phase. The target moves
 * as the phase advances: call time, then start, then elapsed.
 */
export function getPhaseCountdown(
  phase: ServicePhase,
  timing: ServiceTiming,
  nowMs: number,
): PhaseCountdown {
  const { scheduledStartMs, callTimeMs, expectedEndMs } = timing;

  if (phase === "live") {
    if (scheduledStartMs === null) {
      return { targetMs: null, remainingMs: null, label: "on air", direction: "up" };
    }
    return {
      targetMs: expectedEndMs,
      remainingMs: expectedEndMs === null ? null : expectedEndMs - nowMs,
      label: "to expected end",
      direction: "down",
    };
  }

  if (phase === "debrief") {
    return {
      targetMs: expectedEndMs,
      remainingMs: expectedEndMs === null ? null : nowMs - expectedEndMs,
      label: "since service ended",
      direction: "up",
    };
  }

  if (phase === "call") {
    return {
      targetMs: scheduledStartMs,
      remainingMs: scheduledStartMs === null ? null : scheduledStartMs - nowMs,
      label: "to service start",
      direction: "down",
    };
  }

  if (callTimeMs === null) {
    return { targetMs: null, remainingMs: null, label: "no start time set", direction: "down" };
  }

  return {
    targetMs: callTimeMs,
    remainingMs: callTimeMs - nowMs,
    label: "to call time",
    direction: "down",
  };
}

const PHASE_LABELS: Record<ServicePhase, string> = {
  planning: "Planning",
  prep: "Prep",
  call: "Call",
  live: "Live",
  debrief: "Debrief",
};

export function phaseLabel(phase: ServicePhase): string {
  return PHASE_LABELS[phase];
}

/** Read the two phase settings out of an org's AppSetting map. */
export function readPhaseSettings(settings: Record<string, string>): {
  callLeadMinutes: number;
  serviceWindowMinutes: number;
} {
  const parse = (raw: string | undefined, fallback: number) => {
    const n = Number.parseInt(raw ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    callLeadMinutes: parse(settings[CALL_LEAD_SETTING_KEY], DEFAULT_CALL_LEAD_MINUTES),
    serviceWindowMinutes: parse(
      settings[SERVICE_WINDOW_SETTING_KEY],
      DEFAULT_SERVICE_WINDOW_MINUTES,
    ),
  };
}
