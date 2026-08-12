/**
 * The show caller's clock.
 *
 * A caller is holding a headset and reading a sheet; they are not going
 * to hunt for numbers. So there are five, in the order they get used:
 * what is on air, how long is left on it, what is next, whether the
 * service is running late, and when it will actually end.
 *
 * Time left on the current item is the largest thing on the strip and
 * the only one that changes every second, because it is the one the next
 * call hangs off. It goes red the moment it passes zero — an overrun is
 * a decision point, not a statistic.
 */

import { Radio } from "lucide-react";
import type { CallerClock } from "@/lib/cue-sheet-derive";

/** mm:ss, or h:mm:ss past an hour. Signed, because the sign is the point. */
function duration(ms: number | null): string {
  if (ms === null) return "--:--";
  const negative = ms < 0;
  const total = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  const body = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  return negative ? `-${body}` : body;
}

function clock(ms: number | null): string {
  if (ms === null) return "--:--";
  return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** Signed minutes, for the offset. Under a minute is not worth reporting. */
function offsetLabel(ms: number | null): { text: string; tone: string } {
  if (ms === null) return { text: "—", tone: "text-board-muted" };
  const minutes = Math.round(ms / 60000);
  if (minutes === 0) return { text: "on time", tone: "text-green-400" };
  if (minutes > 0) return { text: `+${minutes}m`, tone: "text-red-400" };
  return { text: `${minutes}m`, tone: "text-green-400" };
}

export function CallerClockBar({ clockState, nowMs }: { clockState: CallerClock; nowMs: number }) {
  const offset = offsetLabel(clockState.offsetMs);
  const overrunning = clockState.itemRemainingMs !== null && clockState.itemRemainingMs < 0;
  const onAir = clockState.liveTitle !== null;

  return (
    <div className="shrink-0 flex items-center gap-5 flex-wrap px-6 py-2 border-b border-board-border bg-board-card/40">
      <div className="flex items-center gap-2 min-w-0">
        <Radio
          className={`w-3.5 h-3.5 shrink-0 ${onAir ? "text-red-400" : "text-board-muted/40"}`}
          aria-hidden="true"
        />
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-[0.12em] text-board-muted leading-none">
            {onAir ? "On air" : "Standing by"}
          </p>
          <p className="text-[13px] text-board-text truncate max-w-[280px] mt-1 leading-none">
            {clockState.liveTitle ?? "Nothing running"}
          </p>
        </div>
      </div>

      {/* The number the next call hangs off. */}
      <Stat
        label={overrunning ? "Over by" : "Left on item"}
        value={duration(clockState.itemRemainingMs)}
        tone={overrunning ? "text-red-400" : "text-board-text"}
        big
      />

      <Stat label="Next" value={clockState.nextTitle ?? "End of service"} truncate />

      <div className="ml-auto flex items-center gap-5">
        <Stat label="Now" value={clock(nowMs)} />
        <Stat label="Planned end" value={clock(clockState.plannedEndMs)} />
        <Stat
          label="Expected end"
          value={clock(clockState.expectedEndMs)}
          tone={offset.tone}
        />
        <Stat label="Offset" value={offset.text} tone={offset.tone} />
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "text-board-text",
  big = false,
  truncate = false,
}: {
  label: string;
  value: string;
  tone?: string;
  big?: boolean;
  truncate?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-[0.12em] text-board-muted leading-none">
        {label}
      </p>
      <p
        className={`mt-1 leading-none tabular-nums ${tone} ${
          big ? "text-[19px] font-semibold" : "text-[13px]"
        } ${truncate ? "truncate max-w-[200px]" : ""}`}
      >
        {value}
      </p>
    </div>
  );
}
