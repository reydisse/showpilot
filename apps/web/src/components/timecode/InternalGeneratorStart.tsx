import { useId, useState } from "react";
import { Play } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  framesToTimecode,
  parseTimecodeString,
  timecodeToString,
} from "@/lib/timecode";
import {
  startPositionProblem,
  type TimecodeStartPosition,
} from "@/lib/timecode-start";
import type { TimecodeState } from "@/types/timecode";

interface Props {
  clock: Pick<
    TimecodeState,
    | "showId"
    | "format"
    | "totalFrames"
    | "running"
    | "signal"
    | "incomingFormat"
  >;
  connected: boolean;
  pending: "starting" | "stopping" | null;
  onStart: (position?: TimecodeStartPosition) => void;
  initialCustom?: boolean;
}

export function InternalGeneratorStart({
  clock,
  connected,
  pending,
  onStart,
  initialCustom = false,
}: Props) {
  const [custom, setCustom] = useState(initialCustom);
  const [text, setText] = useState(() => initialCustom ? timecodeToString(framesToTimecode(clock.totalFrames, clock.format), clock.format.dropFrame === "df") : "");
  const [review, setReview] = useState<TimecodeStartPosition | null>(null);
  const id = useId();
  const parsed = parseTimecodeString(text, clock.format);
  const valid = parsed !== null;
  const held = timecodeToString(
    framesToTimecode(clock.totalFrames, clock.format),
    clock.format.dropFrame === "df",
  );
  const chosen = valid
    ? timecodeToString(parsed, clock.format.dropFrame === "df")
    : null;
  const canChoose =
    !clock.running &&
    clock.signal?.status !== "paused" &&
    !clock.incomingFormat &&
    Boolean(clock.showId);
  const problem = review ? startPositionProblem(review, clock, false) : null;
  const disabled =
    !connected || pending !== null || (custom && (!valid || !canChoose));
  return (
    <div className="space-y-2">
      <label className="flex min-h-11 items-center gap-2 text-sm text-board-text">
        <input
          type="checkbox"
          checked={custom}
          disabled={!connected || pending !== null || !canChoose}
          onChange={(event) => {
            setCustom(event.target.checked);
            if (event.target.checked && !text) setText(held);
          }}
        />
        Start at a specific timecode
      </label>
      {custom && (
        <div className="space-y-1">
          <label htmlFor={id} className="block text-xs text-board-muted">
            Internal start position
          </label>
          <input
            id={id}
            type="text"
            value={text}
            disabled={!connected || pending !== null || !canChoose}
            onChange={(event) => setText(event.target.value)}
            placeholder={held}
            aria-invalid={!valid}
            aria-describedby={`${id}-help`}
            autoComplete="off"
            spellCheck={false}
            className="min-h-11 w-full rounded-lg border border-board-border bg-board-bg px-3 py-2 font-mono text-sm text-board-text"
          />
          <p id={`${id}-help`} className="text-xs text-board-muted">
            {clock.format.dropFrame === "df" ? "HH:MM:SS;FF" : "HH:MM:SS:FF"} ·{" "}
            {clock.format.frameRate} fps. Held position: {held}.
          </p>
          {!valid && (
            <p role="alert" className="text-xs text-red-400">
              Enter a valid timecode for this frame rate, from 00:00:00:00
              through the last frame before 24 hours.
            </p>
          )}
          {!canChoose && (
            <p role="status" className="text-xs text-amber-200">
              Stop the source and confirm its format before choosing a start
              position.
            </p>
          )}
        </div>
      )}
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          if (!custom) {
            onStart();
            return;
          }
          if (parsed && valid && clock.showId)
            setReview({
              timecode: parsed,
              expectedShowId: clock.showId,
              expectedFrame: clock.totalFrames,
              expectedFormat: clock.format,
              confirmed: true,
            });
        }}
        className="flex min-h-11 w-full items-center gap-2 rounded-lg bg-fire-500/10 border border-fire-500/20 px-4 py-2.5 text-sm font-medium text-fire-500 hover:bg-fire-500/20 disabled:opacity-50 transition-colors"
      >
        <Play className="h-4 w-4 shrink-0" />
        {pending === "starting"
          ? "Starting…"
          : pending === "stopping"
            ? "Stopping…"
            : custom
              ? chosen
                ? `Start at ${chosen}`
                : "Start at timecode"
              : clock.totalFrames > 0
                ? "Resume Internal Generator"
                : "Start Internal Generator"}
      </button>
      <ConfirmDialog
        open={review !== null}
        onOpenChange={(open) => {
          if (!open) setReview(null);
        }}
        title="Start from this position?"
        confirmLabel="Start from position"
        variant="warning"
        description={
          problem ??
          `Move from ${held} to ${review ? timecodeToString(review.timecode, review.expectedFormat.dropFrame === "df") : ""} and start the internal generator? Large moves pause automation for review. Fired cues stay fired; cues at the starting position may run when automation is enabled.`
        }
        confirmDisabled={!connected || pending !== null || Boolean(problem)}
        onConfirm={() => {
          if (review && connected && pending === null && !problem)
            onStart(review);
        }}
      />
    </div>
  );
}
