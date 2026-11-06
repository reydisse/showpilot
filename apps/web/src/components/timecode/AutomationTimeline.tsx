import { scheduledDispatchFrame } from "@/lib/automation-timing";
import {
  Clock,
  Trash2,
  RotateCcw,
  Tv,
  Lightbulb,
  Monitor,
  Play,
  Globe,
  CheckCircle2,
  AlertCircle,
  Loader2,
} from "lucide-react";
import type { AutomationEvent, TimecodeState } from "@/types/timecode";
import { framesToTimecode, timecodeToString } from "@/lib/timecode";
import { useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cueReviewState, cueReviewMatches, nextAutomationEvent } from "@/lib/automation-cues";

interface AutomationTimelineProps {
  events: AutomationEvent[];
  state: TimecodeState | null;
  onRemoveEvent: (id: string) => void;
  onResetEvents: () => void;
  onRetryEvent: (id: string) => void;
  onFireEvent: (id: string) => void;
  onFireNext: () => void;
  onSkipEvent: (id: string) => void;
  onRearmEvent: (id: string, expected: ReturnType<typeof cueReviewState>) => void;
  onSetEventEnabled: (id: string, enabled: boolean) => void;
  connected: boolean;
}

const ACTION_ICONS: Record<string, React.ElementType> = {
  "device-action": Monitor,
  "lower-third-show": Tv,
  "lower-third-clear": Tv,
  "rundown-advance": Play,
  "rundown-start-item": Play,
  "rundown-goto-item": Play,
  "rundown-previous": Play,
  "rundown-pause": Play,
  "rundown-resume": Play,
  "rundown-stop": Play,
  "rundown-adjust": Clock,
  "stage-message": Monitor,
  "stage-clear": Monitor,
  "lighting-scene": Lightbulb,
  "lighting-blackout": Lightbulb,
  "lyrics-goto": Tv,
  "lyrics-clear": Tv,
  "pp-trigger-slide": Tv,
  "pp-trigger-next": Tv,
  "pp-trigger-previous": Tv,
  "pp-trigger-prop": Tv,
  "pp-clear-props": Tv,
  "pp-trigger-clear": Tv,
  "custom-webhook": Globe,
};

const ACTION_COLORS: Record<string, string> = {
  "device-action": "text-blue-400 bg-blue-500/10 border-blue-500/20",
  "lower-third-show": "text-purple-400 bg-purple-500/10 border-purple-500/20",
  "lower-third-clear": "text-purple-400 bg-purple-500/10 border-purple-500/20",
  "rundown-advance": "text-fire-500 bg-fire-500/10 border-fire-500/20",
  "rundown-start-item": "text-fire-500 bg-fire-500/10 border-fire-500/20",
  "rundown-goto-item": "text-fire-500 bg-fire-500/10 border-fire-500/20",
  "rundown-previous": "text-fire-500 bg-fire-500/10 border-fire-500/20",
  "rundown-pause": "text-fire-500 bg-fire-500/10 border-fire-500/20",
  "rundown-resume": "text-fire-500 bg-fire-500/10 border-fire-500/20",
  "rundown-stop": "text-fire-500 bg-fire-500/10 border-fire-500/20",
  "rundown-adjust": "text-fire-500 bg-fire-500/10 border-fire-500/20",
  "stage-message": "text-sky-400 bg-sky-500/10 border-sky-500/20",
  "stage-clear": "text-sky-400 bg-sky-500/10 border-sky-500/20",
  "lighting-scene": "text-yellow-400 bg-yellow-500/10 border-yellow-500/20",
  "lighting-blackout": "text-yellow-400 bg-yellow-500/10 border-yellow-500/20",
  "lyrics-goto": "text-amber-300 bg-amber-500/10 border-amber-500/20",
  "lyrics-clear": "text-amber-300 bg-amber-500/10 border-amber-500/20",
  "pp-trigger-slide": "text-blue-300 bg-blue-500/10 border-blue-500/20",
  "pp-trigger-next": "text-blue-300 bg-blue-500/10 border-blue-500/20",
  "pp-trigger-previous": "text-blue-300 bg-blue-500/10 border-blue-500/20",
  "pp-trigger-prop": "text-blue-300 bg-blue-500/10 border-blue-500/20",
  "pp-clear-props": "text-blue-300 bg-blue-500/10 border-blue-500/20",
  "pp-trigger-clear": "text-blue-300 bg-blue-500/10 border-blue-500/20",
  "custom-webhook": "text-board-muted bg-board-border/30 border-board-border",
};

export function AutomationTimeline({
  events,
  state,
  onRemoveEvent,
  onResetEvents,
  onRetryEvent,
  onFireEvent,
  onFireNext,
  onSkipEvent,
  onRearmEvent,
  onSetEventEnabled,
  connected,
}: AutomationTimelineProps) {
  const currentFrame = state?.totalFrames ?? 0;
  const dropFrame = state?.format.dropFrame === "df";
  const [confirmation, setConfirmation] = useState<{ kind: "delete" | "refire" | "rearm"; event: AutomationEvent } | { kind: "reset" } | null>(null);
  const ordered = [...events].sort((a, b) => scheduledDispatchFrame(a) - scheduledDispatchFrame(b));
  const missed = (event: AutomationEvent) => event.enabled && !event.fired && !event.skipped
    && event.executionStatus !== "dispatching" && event.executionStatus !== "failed"
    && scheduledDispatchFrame(event) + event.toleranceFrames < currentFrame;
  const needsAttention = ordered.filter((event) => event.executionStatus === "failed" || missed(event));
  const next = nextAutomationEvent(events, currentFrame);
  const nextId = next?.id;
  const reviewed = confirmation && "event" in confirmation ? events.find(event => event.id === confirmation.event.id) : null;
  const rearmChanged = confirmation?.kind === "rearm" && (!reviewed || reviewed.executionStatus === "dispatching"
    || !cueReviewMatches(reviewed, cueReviewState(confirmation.event)));

  return (
    <div className="rounded-xl border border-board-border bg-board-card">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-board-border">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-board-muted" />
          <h3 className="text-xs font-medium text-board-muted uppercase tracking-wider">
            Automation Timeline
          </h3>
          <span className="text-[10px] text-board-muted/60">
            {events.length} event{events.length !== 1 ? "s" : ""}
          </span>
        </div>
        <button type="button" onClick={onFireNext} disabled={!connected || !next || state?.triggersEnabled === false}
          title={next ? `Fire ${next.label} now` : "No upcoming cue is ready"}
          className="min-h-11 rounded-lg border border-fire-500/30 px-3 text-sm text-fire-500 disabled:opacity-40">Fire next</button>
        {events.length > 0 && (
          <button
            onClick={() => setConfirmation({ kind: "reset" })}
            disabled={!connected || events.some((event) => event.executionStatus === "dispatching")}
            className="flex min-h-11 items-center gap-1.5 text-xs text-board-muted hover:text-fire-500 disabled:opacity-50"
          >
            <RotateCcw className="w-3 h-3" />
            Reset All
          </button>
        )}
      </div>

      {needsAttention.length > 0 && (
        <section aria-label="Missed or failed cues" className="border-b border-red-400/30 bg-red-500/5 p-4">
          <h4 className="text-sm font-semibold text-red-300">Missed / failed cues ({needsAttention.length})</h4>
          <ul className="mt-2 space-y-1">
            {needsAttention.map((event) => <li key={event.id} className="flex items-center justify-between gap-3 text-sm text-board-text"><span>{event.label} · {event.executionStatus === "failed" ? "Failed" : "Missed"}{event.skipped ? " · Skipped" : ""}</span><button type="button" disabled={!connected || !event.enabled || event.skipped || state?.triggersEnabled === false} onClick={() => onRetryEvent(event.id)} className="min-h-11 rounded-lg px-3 text-amber-200 disabled:opacity-40" aria-label={`Retry ${event.label}`}>Retry</button></li>)}
          </ul>
        </section>
      )}

      {/* Event list */}
      {events.length === 0 ? (
        <div className="p-8 text-center">
          <Clock className="w-8 h-8 text-board-muted/20 mx-auto mb-2" />
          <p className="text-sm text-board-muted">No automation events</p>
          <p className="text-xs text-board-muted/60 mt-1">
            Add events below to fire actions at specific timecodes
          </p>
        </div>
      ) : (
        <div className="divide-y divide-board-border">
          {ordered.map((event) => {
            const Icon = ACTION_ICONS[event.action] ?? Monitor;
            const colorClass = ACTION_COLORS[event.action] ?? ACTION_COLORS["custom-webhook"];
            const isNext = nextId === event.id;

            return (
              <div
                key={event.id}
                className={`flex flex-wrap items-center gap-3 px-4 py-3 transition-colors ${
                  event.fired && event.executionStatus !== "failed"
                    ? "opacity-40"
                    : isNext
                      ? "bg-fire-500/5"
                      : ""
                }`}
              >
                {/* Timecode */}
                <span className="font-mono text-xs tabular-nums text-board-muted w-24 shrink-0">
                  {timecodeToString(event.triggerTimecode, dropFrame)}
                  {((event.leadMs ?? 0) + (event.deviceLatencyMs ?? 0)) > 0 && <span className="mt-1 block font-sans text-[11px] text-amber-200">
                    Lead {event.leadMs ?? 0} ms + device {event.deviceLatencyMs ?? 0} ms
                    {state && <span className="block font-mono">Send {timecodeToString(framesToTimecode(scheduledDispatchFrame(event), state.format), dropFrame)}</span>}
                  </span>}
                </span>

                {/* Status indicator */}
                <div className="w-5 shrink-0">
                  {event.executionStatus === "failed" ? (
                    <AlertCircle className="h-4 w-4 text-red-400" />
                  ) : event.executionStatus === "dispatching" ? (
                    <Loader2 className="h-4 w-4 animate-spin text-fire-500" />
                  ) : event.fired ? (
                    <CheckCircle2 className="w-4 h-4 text-green-500" />
                  ) : isNext ? (
                    <div className="w-3 h-3 rounded-full bg-fire-500 animate-pulse mx-0.5" />
                  ) : (
                    <div className="w-3 h-3 rounded-full bg-board-border mx-0.5" />
                  )}
                </div>

                {/* Action badge */}
                <div
                  className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-[10px] font-medium shrink-0 ${colorClass}`}
                >
                  <Icon className="w-3 h-3" />
                  {event.action.replace(/-/g, " ")}
                </div>

                {/* Label */}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-board-text">{event.label}</span>
                  <span className="block text-xs text-board-muted">{event.skipped ? "Skipped" : !event.enabled ? "Disabled" : event.executionStatus === "failed" ? "Failed" : event.executionStatus === "dispatching" ? "Awaiting acknowledgement" : event.fired ? "Acknowledged" : missed(event) ? "Missed" : isNext ? "Next" : "Scheduled"}</span>
                  {event.executionStatus === "failed" && event.executionError ? (
                    <span className="mt-0.5 block text-xs text-red-400">
                      {event.executionError}
                    </span>
                  ) : null}
                  {event.executionDurationMs !== undefined && <span className="block text-xs text-board-muted">Last attempt: {event.executionDurationMs} ms</span>}
                </span>

                <label className="flex min-h-11 items-center gap-2 text-xs text-board-muted">
                  <input type="checkbox" checked={event.enabled} disabled={!connected} onChange={(change) => onSetEventEnabled(event.id, change.target.checked)} aria-label={`Enable ${event.label}`} />Enabled
                </label>
                {!event.fired && !event.skipped && event.executionStatus !== "failed" && <button type="button" aria-label={`Fire ${event.label}`} disabled={!connected || !event.enabled || event.executionStatus === "dispatching" || state?.triggersEnabled === false}
                  onClick={() => onFireEvent(event.id)} className="min-h-11 min-w-11 rounded-lg px-3 text-xs text-fire-500 focus-visible:ring-2 disabled:opacity-40">Fire</button>}
                {!event.fired && !event.skipped && <button type="button" aria-label={`Skip ${event.label}`} disabled={!connected || event.executionStatus === "dispatching"}
                  onClick={() => onSkipEvent(event.id)} className="min-h-11 min-w-11 rounded-lg px-3 text-xs text-board-muted focus-visible:ring-2 disabled:opacity-40">Skip</button>}
                {(event.fired || event.skipped || event.executionStatus === "failed") && <button type="button" aria-label={`Re-arm ${event.label}`} disabled={!connected || event.executionStatus === "dispatching"}
                  onClick={() => setConfirmation({ kind: "rearm", event: { ...event } })} className="min-h-11 min-w-11 rounded-lg px-3 text-xs text-board-muted focus-visible:ring-2 disabled:opacity-40">Re-arm</button>}
                {event.fired && <button type="button" disabled={!connected || !event.enabled || state?.triggersEnabled === false} onClick={() => setConfirmation({ kind: "refire", event })} className="min-h-11 rounded-lg px-3 text-xs text-board-muted disabled:opacity-50">Re-fire</button>}

                {/* Delete */}
                <button
                  type="button"
                  onClick={() => setConfirmation({ kind: "delete", event })}
                  disabled={!connected || event.executionStatus === "dispatching"}
                  aria-label={`Delete ${event.label} automation`}
                  title={`Delete ${event.label} automation`}
                  className="min-h-11 min-w-11 rounded-lg text-board-muted hover:text-red-400 hover:bg-red-500/10 disabled:opacity-50 flex items-center justify-center"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}
      <ConfirmDialog
        open={confirmation !== null}
        onOpenChange={(open) => { if (!open) setConfirmation(null); }}
        title={confirmation?.kind === "reset" ? "Reset all automation cues?" : confirmation?.kind === "rearm" ? "Re-arm this cue?" : confirmation?.kind === "refire" ? "Fire this cue again?" : "Delete this automation cue?"}
        description={confirmation?.kind === "reset" ? "This re-arms every cue. Previously fired actions may run again when their timecode is crossed." : confirmation?.kind === "rearm" ? rearmChanged ? "The cue changed. Close this dialog and review its latest status." : `Make ${confirmation.event.label} available again? This clears its attempt status without firing it now. Check the output before repeating an action.` : confirmation?.kind === "refire" ? `Run ${confirmation.event.label} again now? Check the output before repeating a device action.` : `Remove ${confirmation && "event" in confirmation ? confirmation.event.label : "this cue"} from the timeline?`}
        confirmLabel={confirmation?.kind === "reset" ? "Reset all" : confirmation?.kind === "rearm" ? "Re-arm cue" : confirmation?.kind === "refire" ? "Fire again" : "Delete cue"}
        confirmDisabled={!connected || Boolean(rearmChanged)}
        onConfirm={() => {
          if (!connected || !confirmation) return;
          if (confirmation.kind === "reset") onResetEvents();
          else if (confirmation.kind === "rearm") { if (!rearmChanged) onRearmEvent(confirmation.event.id, cueReviewState(confirmation.event)); }
          else if (confirmation.kind === "refire") onRetryEvent(confirmation.event.id);
          else onRemoveEvent(confirmation.event.id);
        }}
      />
    </div>
  );
}
