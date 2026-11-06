import type { AutomationActionType, AutomationEvent } from "@/types/timecode";
import { scheduledDispatchFrame } from "./automation-timing";

/** At equal dispatch frames, Disable wins after Enable and before outputs. */
export function automationControlPriority(action: AutomationActionType): number {
  return action === "triggers-enable" ? 0 : action === "triggers-disable" ? 1 : 2;
}

export function compareAutomationCues(a: AutomationEvent, b: AutomationEvent): number {
  return scheduledDispatchFrame(a) - scheduledDispatchFrame(b)
    || automationControlPriority(a.action) - automationControlPriority(b.action);
}

/** One definition of Next for the relay, timeline and controller feedback. */
export function nextAutomationEvent(events: readonly AutomationEvent[], currentFrame: number): AutomationEvent | undefined {
  let next: AutomationEvent | undefined;
  for (const event of events) {
    if (!event.enabled || event.fired || event.skipped || event.executionStatus === "failed" || event.executionStatus === "dispatching" || scheduledDispatchFrame(event) < currentFrame) continue;
    if (!next || compareAutomationCues(event, next) < 0) next = event;
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
