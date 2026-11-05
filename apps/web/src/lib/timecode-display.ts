import type { AutomationEvent, TimecodeDisplayState, TimecodeState } from "@/types/timecode";

/** Project internal timecode state to the intentionally public kiosk contract. */
export function projectTimecodeDisplayState(
  state: TimecodeState,
  serverTime = Date.now(),
  events: readonly AutomationEvent[] = [],
): TimecodeDisplayState {
  const failedCueCount = events.filter((event) => event.executionStatus === "failed").length;
  return {
    display: state.display,
    running: state.running,
    serverTime,
    lyrics: state.lyrics,
    automation: { status: failedCueCount > 0 ? "failed" : "ok", failedCueCount },
  };
}
