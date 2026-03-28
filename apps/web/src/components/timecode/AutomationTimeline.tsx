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
} from "lucide-react";
import type { AutomationEvent, TimecodeState } from "@/types/timecode";
import { timecodeToString } from "@/lib/timecode";

interface AutomationTimelineProps {
  events: AutomationEvent[];
  state: TimecodeState | null;
  onRemoveEvent: (id: string) => void;
  onResetEvents: () => void;
}

const ACTION_ICONS: Record<string, React.ElementType> = {
  "device-action": Monitor,
  "lower-third-show": Tv,
  "lower-third-clear": Tv,
  "rundown-advance": Play,
  "rundown-start-item": Play,
  "lighting-scene": Lightbulb,
  "custom-webhook": Globe,
};

const ACTION_COLORS: Record<string, string> = {
  "device-action": "text-blue-400 bg-blue-500/10 border-blue-500/20",
  "lower-third-show": "text-purple-400 bg-purple-500/10 border-purple-500/20",
  "lower-third-clear": "text-purple-400 bg-purple-500/10 border-purple-500/20",
  "rundown-advance": "text-fire-500 bg-fire-500/10 border-fire-500/20",
  "rundown-start-item": "text-fire-500 bg-fire-500/10 border-fire-500/20",
  "lighting-scene": "text-yellow-400 bg-yellow-500/10 border-yellow-500/20",
  "custom-webhook": "text-board-muted bg-board-border/30 border-board-border",
};

export function AutomationTimeline({
  events,
  state,
  onRemoveEvent,
  onResetEvents,
}: AutomationTimelineProps) {
  const currentFrame = state?.totalFrames ?? 0;
  const isRunning = state?.running ?? false;
  const dropFrame = state?.format.dropFrame === "df";

  return (
    <div className="rounded-xl border border-board-border bg-board-card">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-board-border">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-board-muted" />
          <h3 className="text-xs font-medium text-board-muted uppercase tracking-wider">
            Automation Timeline
          </h3>
          <span className="text-[10px] text-board-muted/60">
            {events.length} event{events.length !== 1 ? "s" : ""}
          </span>
        </div>
        {events.length > 0 && (
          <button
            onClick={onResetEvents}
            className="flex items-center gap-1.5 text-[10px] text-board-muted hover:text-fire-500 transition-colors"
          >
            <RotateCcw className="w-3 h-3" />
            Reset All
          </button>
        )}
      </div>

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
          {events.map((event) => {
            const Icon = ACTION_ICONS[event.action] ?? Monitor;
            const colorClass = ACTION_COLORS[event.action] ?? ACTION_COLORS["custom-webhook"];
            const isPast = isRunning && event.triggerFrame <= currentFrame;
            const isNext =
              isRunning &&
              !event.fired &&
              event.triggerFrame > currentFrame &&
              events.filter(
                (e) => !e.fired && e.triggerFrame > currentFrame
              )[0]?.id === event.id;

            return (
              <div
                key={event.id}
                className={`flex items-center gap-3 px-4 py-3 transition-colors ${
                  event.fired
                    ? "opacity-40"
                    : isNext
                      ? "bg-fire-500/5"
                      : ""
                }`}
              >
                {/* Timecode */}
                <span className="font-mono text-xs tabular-nums text-board-muted w-24 shrink-0">
                  {timecodeToString(event.triggerTimecode, dropFrame)}
                </span>

                {/* Status indicator */}
                <div className="w-5 shrink-0">
                  {event.fired ? (
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
                <span className="text-sm text-board-text truncate flex-1">
                  {event.label}
                </span>

                {/* Delete */}
                <button
                  onClick={() => onRemoveEvent(event.id)}
                  className="p-1 rounded-lg text-board-muted hover:text-red-400 hover:bg-red-500/10 transition-colors shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
