import { useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { TimecodeState } from "@/types/timecode";

interface Props {
  state: TimecodeState | null;
  connected: boolean;
  canControl: boolean;
  onSetEnabled: (enabled: boolean, expectedHoldId?: string) => void;
}

export function TimecodeAutomationControl({ state, connected, canControl, onSetEnabled }: Props) {
  const [review, setReview] = useState<NonNullable<TimecodeState["automationHold"]> | null>(null);
  const hold = state?.automationHold;
  const reviewChanged = review?.id !== hold?.id;
  return <div className="space-y-3">
    {hold && <p role="alert" className="rounded-xl border border-amber-500/40 p-4 text-sm text-amber-200">
      Timecode jumped from {hold.from} to {hold.to}. Automation paused for review. The clock and displays keep updating.
    </p>}
    <button type="button" disabled={!connected || !canControl || !state}
      aria-pressed={state?.triggersEnabled ?? true}
      onClick={() => {
        if (hold && state?.triggersEnabled === false) setReview(hold);
        else onSetEnabled(!state?.triggersEnabled);
      }}
      className="min-h-11 rounded-xl border border-amber-500/40 px-4 py-2 text-sm font-semibold text-amber-200 disabled:opacity-50">
      {state?.triggersEnabled === false ? hold ? "Review and resume automation" : "Enable automation" : "Disable automation"}
    </button>
    {state?.triggersEnabled === false && <p role="status" className="text-sm text-amber-200">
      Automation disabled. The clock and displays keep running. Missed cues will not replay automatically.
    </p>}
    <ConfirmDialog open={review !== null} onOpenChange={open => { if (!open) setReview(null); }}
      title="Resume automation at the current timecode?"
      description={reviewChanged ? "Timecode changed again. Close this dialog and review the latest jump before resuming."
        : `The clock jumped from ${review?.from} to ${review?.to}. Resume from its current position. Missed cues stay skipped and previously fired cues stay fired.`}
      confirmLabel="Resume automation" variant="warning"
      confirmDisabled={!connected || !canControl || reviewChanged}
      onConfirm={() => { if (review && !reviewChanged && connected && canControl) onSetEnabled(true, review.id); }} />
  </div>;
}
