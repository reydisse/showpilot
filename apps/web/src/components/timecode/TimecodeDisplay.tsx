import type { TimecodeState } from "@/types/timecode";
import { useTimecodePresentation } from "@/hooks/useTimecodePresentation";
import type { TimecodePresentationSample } from "@/lib/timecode-presentation";

/** Text-only clock for song previews and public confidence output. */
export function TimecodeText({ state, connected }: { state: TimecodePresentationSample | null; connected: boolean }) {
  const { display, stale } = useTimecodePresentation(state, connected);
  const held = !connected || stale || state?.signal?.status === "timecode-stalled" || state?.signal?.status === "timecode-lost";
  return <span data-timecode-display="text" title={held ? "Timecode held" : undefined}>{display}</span>;
}

interface TimecodeDisplayProps {
  state: TimecodeState | null;
  connected: boolean;
  /** "large" for kiosk/confidence monitor, "compact" for inline rundown */
  size?: "large" | "compact";
  showState?: boolean;
}

export function TimecodeDisplay({
  state,
  connected,
  size = "compact",
  showState = false,
}: TimecodeDisplayProps) {
  const { display, stale } = useTimecodePresentation(state, connected);
  const running = connected && !stale && (state?.running ?? false);
  const lost = stale || state?.signal?.status === "timecode-stalled" || state?.signal?.status === "timecode-lost";
  const mismatch = state?.signal?.status === "format-mismatch";
  const paused = state?.signal?.status === "paused";
  const statusLabel = !connected ? "Disconnected" : mismatch ? "Format mismatch" : lost ? "Signal lost" : paused ? "Paused" : running ? "Running" : "Stopped";

  if (size === "large") {
    return (
      <div className="flex flex-col items-center gap-2 overflow-hidden w-full">
        <div
          data-timecode-display="large"
          className={`font-mono tabular-nums sm:tracking-wider text-center w-full ${
            running ? "text-fire-500" : "text-board-muted/50"
          }`}
          style={{ fontSize: "clamp(1.2rem, 6vw, 5rem)" }}
        >
          {display}
        </div>
        <div role="status" aria-label={`Timecode ${statusLabel.toLowerCase()}`} className="flex flex-wrap justify-center items-center gap-3 text-xs text-board-muted">
          <span
            className={`w-2 h-2 rounded-full ${
              connected
                ? lost || mismatch ? "bg-amber-500" : running
                  ? "bg-green-500 animate-pulse"
                  : "bg-green-500"
                : "bg-red-500"
            }`}
          />
          <span>
            {!connected
              ? "Disconnected"
              : mismatch ? "Format mismatch · clock held" : lost ? "Signal lost · clock held" : running
                ? `Running · ${state?.format.frameRate} fps ${state?.format.dropFrame === "df" ? "DF" : "NDF"}`
                : paused ? "Paused · position held" : "Stopped · position held"}
          </span>
          {state?.source && (
            <span className="text-board-muted/50">
              {state.source === "internal-freerun"
                ? "Internal"
                : state.source === "mtc"
                  ? "MTC"
                  : state.source}
            </span>
          )}
        </div>
      </div>
    );
  }

  // Compact
  return (
    <div role="status" aria-label={`Timecode ${statusLabel.toLowerCase()}`} className="inline-flex items-center gap-2">
      <span
        className={`w-1.5 h-1.5 rounded-full ${
          connected
            ? lost || mismatch ? "bg-amber-500" : running
              ? "bg-green-500 animate-pulse"
              : "bg-green-500"
            : "bg-board-muted/30"
        }`}
      />
      <span
        data-timecode-display="compact"
        className={`font-mono text-sm tabular-nums tracking-wide ${
          running ? "text-fire-500" : "text-board-muted/50"
        }`}
      >
        {display}
      </span>
      {showState && <span className={`text-xs ${connected && !lost && !mismatch ? "text-board-text" : "text-amber-200"}`}>{statusLabel}</span>}
      {!showState && connected && (lost || mismatch) && <span className="text-xs text-amber-400">{mismatch ? "Format mismatch" : "Signal lost"}</span>}
    </div>
  );
}
