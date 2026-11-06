import type { AutomationEvent, TimecodeDisplayState, TimecodeState } from "@/types/timecode";

/** Project internal timecode state to the intentionally public kiosk contract. */
export function projectTimecodeDisplayState(
  state: TimecodeState,
  serverTime = Date.now(),
  events: readonly AutomationEvent[] = [],
): TimecodeDisplayState {
  const failedCueCount = events.filter((event) => event.executionStatus === "failed").length;
  return {
    ...(state.showId ? { showId: state.showId, serviceDate: state.serviceDate } : {}),
    display: state.display,
    format: state.format,
    totalFrames: state.totalFrames,
    running: state.running,
    // lastFeedAt identifies the observed frame. A later lyrics/status broadcast
    // must not freshen it just because this message has a newer serverTime.
    ...(state.signal ? { signal: state.signal } : {}),
    serverTime,
    lyrics: state.lyrics,
    automation: { status: failedCueCount > 0 ? "failed" : "ok", failedCueCount },
  };
}
