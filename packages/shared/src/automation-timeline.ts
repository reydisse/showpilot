/** The relay supplies dispatchFrame after applying cue lead and device latency. */
export interface AutomationTimelineCue {
  action: string;
  triggerFrame: number;
  dispatchFrame?: number;
  enabled: boolean;
  fired: boolean;
  skipped?: boolean;
  executionStatus?: "scheduled" | "dispatching" | "acknowledged" | "failed";
  toleranceFrames?: number;
}

export function scheduledDispatchFrame(event: Pick<AutomationTimelineCue, "triggerFrame" | "dispatchFrame">): number {
  return event.dispatchFrame ?? event.triggerFrame;
}

/** At equal dispatch frames, Disable wins after Enable and before outputs. */
export function automationControlPriority(action: string): number {
  return action === "triggers-enable" ? 0 : action === "triggers-disable" ? 1 : 2;
}

export function compareAutomationCues(a: AutomationTimelineCue, b: AutomationTimelineCue): number {
  return scheduledDispatchFrame(a) - scheduledDispatchFrame(b)
    || automationControlPriority(a.action) - automationControlPriority(b.action);
}

/** One definition of Next for the relay, timeline and controller feedback. */
export function nextAutomationEvent<T extends AutomationTimelineCue>(events: readonly T[], currentFrame: number): T | undefined {
  let next: T | undefined;
  for (const event of events) {
    if (!event.enabled || event.fired || event.skipped || event.executionStatus === "failed" || event.executionStatus === "dispatching" || scheduledDispatchFrame(event) < currentFrame) continue;
    if (!next || compareAutomationCues(event, next) < 0) next = event;
  }
  return next;
}

/** Render nominal cue order without changing the relay snapshot. */
export function orderedAutomationEvents<T extends AutomationTimelineCue>(events: readonly T[]): T[] {
  return [...events].sort((a, b) => a.triggerFrame - b.triggerFrame || compareAutomationCues(a, b));
}

/** Failed, disabled, skipped and dispatched cues retain their execution status. */
export function cueTimingStatus(event: AutomationTimelineCue, currentFrame: number): "upcoming" | "overdue" | "missed" | null {
  if (!event.enabled || event.fired || event.skipped || event.executionStatus === "failed" || event.executionStatus === "dispatching") return null;
  const dispatch = scheduledDispatchFrame(event);
  if (dispatch >= currentFrame) return "upcoming";
  return dispatch + (event.toleranceFrames ?? 5) < currentFrame ? "missed" : "overdue";
}
