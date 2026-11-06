import type { AutomationEvent } from "@/types/timecode";
import { scheduledDispatchFrame } from "./automation-timing";

/** One definition of Next for the relay, timeline and controller feedback. */
export function nextAutomationEvent(events: readonly AutomationEvent[], currentFrame: number): AutomationEvent | undefined {
  let next: AutomationEvent | undefined;
  for (const event of events) {
    if (!event.enabled || event.fired || event.skipped || event.executionStatus === "failed" || event.executionStatus === "dispatching" || scheduledDispatchFrame(event) < currentFrame) continue;
    if (!next || scheduledDispatchFrame(event) < scheduledDispatchFrame(next)) next = event;
  }
  return next;
}

/** Capture the exact attempt being reviewed before offering Re-arm. */
export function cueReviewState(event: AutomationEvent) {
  return { executionId: event.executionId ?? null, fired: event.fired, skipped: event.skipped === true };
}

export function cueReviewMatches(event: AutomationEvent, expected: ReturnType<typeof cueReviewState>): boolean {
  const current = cueReviewState(event);
  return expected.executionId === current.executionId && expected.fired === current.fired && expected.skipped === current.skipped;
}
