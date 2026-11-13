import type { AutomationEvent, TimecodeState, TimecodeValue } from "@/types/timecode";
import { automationDispatchFrame } from "./automation-timing";
import { framesToTimecode, isLargeTimecodeJump, isValidTimecode, isValidTimecodeFormat, normalizeTimecodeForFormat,
  sameTimecodeFormat, timecodeToFrames, timecodeToString } from "./timecode";

export type PreparedClockEdit = { state: TimecodeState; events: AutomationEvent[]; previousFeedFrame: number | null; reformatted: boolean };
/** Prepare without changing live state. Reviewed edits persist this and their
 * receipt atomically; legacy web commands use the same clock transformations. */
export function prepareTimecodeClockEdit(state: TimecodeState, events: AutomationEvent[], action: "set-timecode" | "set-format", payload: Record<string, unknown> | undefined): PreparedClockEdit | null {
  if (action === "set-timecode") {
    const parsed = payload?.timecode;
    if (!parsed || typeof parsed !== "object" || !("hours" in parsed) || !("minutes" in parsed) || !("seconds" in parsed) || !("frames" in parsed)) return null;
    if (typeof parsed.hours !== "number" || typeof parsed.minutes !== "number" || typeof parsed.seconds !== "number" || typeof parsed.frames !== "number") return null;
    const tc: TimecodeValue = { hours: parsed.hours, minutes: parsed.minutes, seconds: parsed.seconds, frames: parsed.frames };
    if (!isValidTimecode(tc, state.format)) return null;
    const totalFrames = timecodeToFrames(tc, state.format);
    const jump = isLargeTimecodeJump(state.totalFrames, totalFrames, state.format);
    const next: TimecodeState = { ...state, timecode: tc, totalFrames,
      display: timecodeToString(tc, state.format.dropFrame === "df"), serverTime: Date.now(),
      ...(jump ? { triggersEnabled: false, automationHold: {
        id: crypto.randomUUID(), reason: "timecode-jump" as const, detectedAt: Date.now(),
        from: timecodeToString(framesToTimecode(state.totalFrames, state.format), state.format.dropFrame === "df"),
        to: timecodeToString(tc, state.format.dropFrame === "df"),
      } } : {}),
    };
    return { state: next, events, previousFeedFrame: null, reformatted: false };
  }
  const format = payload?.format;
  if (!isValidTimecodeFormat(format) || !isValidTimecodeFormat(payload?.expectedFormat) || payload?.confirmed !== true)
    throw new Error("Confirm Reformat timeline before changing the frame rate.");
  if (!sameTimecodeFormat(payload.expectedFormat, state.format))
    throw new Error("The timeline format changed. Review the new format before confirming.");
  if (state.running) throw new Error("Stop the clock before reformatting the timeline.");
  if (events.some(event => event.executionStatus === "dispatching")) throw new Error("Wait for in-flight cues to finish before reformatting the timeline.");
  const incoming = state.incomingFormat;
  if (incoming ? payload.expectedIncomingFormatId !== incoming.id || !sameTimecodeFormat(incoming.format, format) : Boolean(payload.expectedIncomingFormatId))
    throw new Error("The input format changed. Review the latest detected format.");
  const invalid = events.find(event => !isValidTimecode(event.triggerTimecode, format));
  if (invalid) throw new Error(`Cue “${invalid.label}” has a timecode that is invalid at the new frame rate. Correct or remove that cue before reformatting.`);
  const timecode = normalizeTimecodeForFormat(state.timecode, format);
  const next: TimecodeState = { ...state, triggersEnabled: false, format, timecode,
    totalFrames: timecodeToFrames(timecode, format), display: timecodeToString(timecode, format.dropFrame === "df"),
    serverTime: Date.now(), incomingFormat: null,
    ...(state.signal?.status === "format-mismatch" ? { signal: { status: "waiting" as const, lastFeedAt: null } } : {}),
  };
  return { state: next, previousFeedFrame: next.totalFrames, reformatted: true,
    events: events.map(event => {
      const nextEvent = { ...event, triggerFrame: timecodeToFrames(event.triggerTimecode, format) };
      return { ...nextEvent, dispatchFrame: automationDispatchFrame(nextEvent, format) };
    })
      .sort((a, b) => a.triggerFrame - b.triggerFrame) };
}
