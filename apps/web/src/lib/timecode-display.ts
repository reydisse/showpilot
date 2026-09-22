import type { TimecodeDisplayState, TimecodeState } from "@/types/timecode";

/** Project internal timecode state to the intentionally public kiosk contract. */
export function projectTimecodeDisplayState(
  state: TimecodeState,
  serverTime = Date.now(),
): TimecodeDisplayState {
  return {
    display: state.display,
    running: state.running,
    serverTime,
    lyrics: state.lyrics,
  };
}
