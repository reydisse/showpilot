import type { AutomationEvent } from "@/types/timecode";

/** Capture the exact attempt being reviewed before offering Re-arm. */
export function cueReviewState(event: AutomationEvent) {
  return { executionId: event.executionId ?? null, fired: event.fired, skipped: event.skipped === true };
}

export function cueReviewMatches(event: AutomationEvent, expected: ReturnType<typeof cueReviewState>): boolean {
  const current = cueReviewState(event);
  return expected.executionId === current.executionId && expected.fired === current.fired && expected.skipped === current.skipped;
}
