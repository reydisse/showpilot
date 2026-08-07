import { describe, expect, it } from "vitest";
import {
  DEBRIEF_WINDOW_MS,
  PREP_WINDOW_MS,
  getPhaseCountdown,
  getServicePhase,
  getServiceTiming,
  readPhaseSettings,
} from "@/lib/service-phase";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const START = new Date("2026-08-09T10:00:00.000Z").getTime();

function input(overrides: Partial<Parameters<typeof getServicePhase>[0]> = {}) {
  return {
    scheduledStartTime: new Date(START).toISOString(),
    status: "stopped" as const,
    plannedDurationMs: 70 * MINUTE,
    callLeadMinutes: 90,
    serviceWindowMinutes: 90,
    ...overrides,
  };
}

describe("getServiceTiming", () => {
  it("derives call time from the configured lead", () => {
    const timing = getServiceTiming(input());
    expect(timing.callTimeMs).toBe(START - 90 * MINUTE);
  });

  it("prefers real planned runtime over the configured window", () => {
    const timing = getServiceTiming(input());
    expect(timing.expectedEndMs).toBe(START + 70 * MINUTE);
  });

  it("falls back to the service window when nothing is planned", () => {
    const timing = getServiceTiming(input({ plannedDurationMs: 0 }));
    expect(timing.expectedEndMs).toBe(START + 90 * MINUTE);
  });

  it("returns nulls when no start time is set", () => {
    const timing = getServiceTiming(input({ scheduledStartTime: null }));
    expect(timing).toEqual({ scheduledStartMs: null, callTimeMs: null, expectedEndMs: null });
  });
});

describe("getServicePhase", () => {
  it("is planning well before the service", () => {
    expect(getServicePhase(input(), START - PREP_WINDOW_MS - HOUR)).toBe("planning");
  });

  it("enters prep at the 48 hour boundary", () => {
    expect(getServicePhase(input(), START - PREP_WINDOW_MS + MINUTE)).toBe("prep");
  });

  it("enters call at call time", () => {
    expect(getServicePhase(input(), START - 90 * MINUTE)).toBe("call");
  });

  it("stays in prep one minute before call time", () => {
    expect(getServicePhase(input(), START - 91 * MINUTE)).toBe("prep");
  });

  it("is live whenever the rundown is running, regardless of clock", () => {
    expect(getServicePhase(input({ status: "live" }), START - 5 * 24 * HOUR)).toBe("live");
  });

  it("moves to debrief once the expected end passes", () => {
    expect(getServicePhase(input(), START + 71 * MINUTE)).toBe("debrief");
  });

  it("treats an explicitly completed rundown as debrief before its end", () => {
    expect(getServicePhase(input({ status: "complete" }), START + 10 * MINUTE)).toBe("debrief");
  });

  it("falls back to planning once the debrief window closes", () => {
    expect(getServicePhase(input(), START + 70 * MINUTE + DEBRIEF_WINDOW_MS + MINUTE)).toBe(
      "planning",
    );
  });

  it("is planning when there is no start time to count toward", () => {
    expect(getServicePhase(input({ scheduledStartTime: null }), START)).toBe("planning");
  });
});

describe("getPhaseCountdown", () => {
  const timing = getServiceTiming(input());

  it("aims at call time during prep", () => {
    const countdown = getPhaseCountdown("prep", timing, START - 3 * HOUR);
    expect(countdown.targetMs).toBe(timing.callTimeMs);
    expect(countdown.label).toBe("to call time");
    expect(countdown.remainingMs).toBe(90 * MINUTE);
  });

  it("retargets to service start during call", () => {
    const countdown = getPhaseCountdown("call", timing, START - 30 * MINUTE);
    expect(countdown.targetMs).toBe(START);
    expect(countdown.remainingMs).toBe(30 * MINUTE);
  });

  it("counts up after the service ends", () => {
    const countdown = getPhaseCountdown("debrief", timing, START + 90 * MINUTE);
    expect(countdown.direction).toBe("up");
    expect(countdown.remainingMs).toBe(20 * MINUTE);
  });
});

describe("readPhaseSettings", () => {
  it("uses defaults when unset", () => {
    expect(readPhaseSettings({})).toEqual({ callLeadMinutes: 90, serviceWindowMinutes: 90 });
  });

  it("reads configured values", () => {
    expect(
      readPhaseSettings({
        "default-call-lead-minutes": "45",
        "default-service-window-minutes": "75",
      }),
    ).toEqual({ callLeadMinutes: 45, serviceWindowMinutes: 75 });
  });

  it("ignores junk and non-positive values", () => {
    expect(
      readPhaseSettings({ "default-call-lead-minutes": "0", "default-service-window-minutes": "x" }),
    ).toEqual({ callLeadMinutes: 90, serviceWindowMinutes: 90 });
  });
});
