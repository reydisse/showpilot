import type { TimecodeState } from "@/types/timecode";

interface TimecodeDisplayProps {
  state: TimecodeState | null;
  connected: boolean;
  /** "large" for kiosk/confidence monitor, "compact" for inline rundown */
  size?: "large" | "compact";
}

export function TimecodeDisplay({
  state,
  connected,
  size = "compact",
}: TimecodeDisplayProps) {
  const display = state?.display ?? "00:00:00:00";
  const running = state?.running ?? false;

  if (size === "large") {
    return (
      <div className="flex flex-col items-center gap-2">
        <div
          className={`font-mono tabular-nums tracking-wider ${
            running ? "text-fire-500" : "text-board-muted/50"
          }`}
          style={{ fontSize: "clamp(3rem, 10vw, 8rem)" }}
        >
          {display}
        </div>
        <div className="flex items-center gap-3 text-xs text-board-muted">
          <span
            className={`w-2 h-2 rounded-full ${
              connected
                ? running
                  ? "bg-green-500 animate-pulse"
                  : "bg-green-500"
                : "bg-red-500"
            }`}
          />
          <span>
            {!connected
              ? "Disconnected"
              : running
                ? `${state?.format.frameRate}fps ${state?.format.dropFrame === "df" ? "DF" : "NDF"}`
                : "Stopped"}
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
    <div className="inline-flex items-center gap-2">
      <span
        className={`w-1.5 h-1.5 rounded-full ${
          connected
            ? running
              ? "bg-green-500 animate-pulse"
              : "bg-green-500"
            : "bg-board-muted/30"
        }`}
      />
      <span
        className={`font-mono text-sm tabular-nums tracking-wide ${
          running ? "text-fire-500" : "text-board-muted/50"
        }`}
      >
        {display}
      </span>
    </div>
  );
}
