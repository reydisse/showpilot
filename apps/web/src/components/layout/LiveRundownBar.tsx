import { Link } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Pause, Play, Radio } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useRundownSync } from "@/hooks/useRundownSync";
import { getActiveRundownTarget } from "@/lib/rundown";

export const ACTIVE_RUNDOWN_CHANGED_EVENT = "showpilot:active-rundown-changed";

interface LiveRundownBarProps {
  orgId: string;
  slug: string;
  canControl: boolean;
}

interface ActiveTarget {
  serviceDate: string;
  showId?: string;
}

function formatTimer(milliseconds: number): string {
  const sign = milliseconds < 0 ? "-" : "";
  const seconds = Math.floor(Math.abs(milliseconds) / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return hours
    ? `${sign}${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${sign}${minutes}:${String(remainder).padStart(2, "0")}`;
}

function ActiveRundownSession({ target, orgId, slug, canControl }: LiveRundownBarProps & { target: ActiveTarget }) {
  const { items, timer, serviceName, connected, hydrated, sendCommand } = useRundownSync(
    orgId,
    target.serviceDate,
    target.showId,
  );
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (timer.playback !== "play") return;
    const interval = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, [timer.playback]);

  const currentItem = useMemo(
    () => items.find((item) => item.id === timer.currentItemId) ?? null,
    [items, timer.currentItemId],
  );
  if (!hydrated || timer.playback === "stop" || !currentItem) return null;

  const elapsed = timer.elapsed + (
    timer.playback === "play" && timer.startedAt ? now - timer.startedAt : 0
  );
  const displayed = timer.mode === "count-down" ? currentItem.duration - elapsed : elapsed;
  const isPaused = timer.playback === "pause";

  return (
    <div className="relative z-30 flex min-h-12 items-center gap-2 border-b border-fire-500/25 bg-[#15130f] px-3 text-board-text shadow-[0_6px_24px_rgba(0,0,0,0.2)] sm:px-4">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-red-500/15 text-red-400">
        <Radio className="h-3.5 w-3.5" />
      </span>
      <Link
        to="/$slug/rundown"
        params={{ slug }}
        search={{ date: target.serviceDate, show: target.showId }}
        className="min-w-0 flex-1 py-1"
      >
        <p className="truncate text-[10px] font-bold uppercase tracking-[0.13em] text-fire-400">
          {isPaused ? "Rundown paused" : "Rundown live"}
        </p>
        <p className="truncate text-xs font-semibold sm:text-sm">
          {currentItem.title}<span className="hidden font-normal text-board-muted sm:inline"> · {serviceName || target.serviceDate}</span>
        </p>
      </Link>
      <span className={`shrink-0 font-mono text-base font-bold tabular-nums ${displayed < 0 ? "text-red-400" : "text-board-text"}`}>
        {formatTimer(displayed)}
      </span>
      {canControl ? (
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label="Previous rundown item"
            disabled={!connected}
            onClick={() => sendCommand("timer-prev")}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-board-muted hover:bg-white/5 hover:text-board-text disabled:opacity-35"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label={isPaused ? "Resume rundown" : "Pause rundown"}
            disabled={!connected}
            onClick={() => sendCommand(isPaused ? "timer-resume" : "timer-pause")}
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-fire-500 text-black disabled:opacity-35"
          >
            {isPaused ? <Play className="h-4 w-4 fill-current" /> : <Pause className="h-4 w-4 fill-current" />}
          </button>
          <button
            type="button"
            aria-label="Next rundown item"
            disabled={!connected}
            onClick={() => sendCommand("timer-next")}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-board-muted hover:bg-white/5 hover:text-board-text disabled:opacity-35"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function LiveRundownBar(props: LiveRundownBarProps) {
  const [target, setTarget] = useState<ActiveTarget | null>(null);

  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      void getActiveRundownTarget({ data: { orgId: props.orgId } })
        .then((next) => {
          if (!disposed) setTarget(next);
        })
        .catch(() => {});
    };
    refresh();
    const interval = window.setInterval(refresh, 15_000);
    window.addEventListener("focus", refresh);
    window.addEventListener(ACTIVE_RUNDOWN_CHANGED_EVENT, refresh);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      window.removeEventListener(ACTIVE_RUNDOWN_CHANGED_EVENT, refresh);
    };
  }, [props.orgId]);

  return target ? <ActiveRundownSession {...props} target={target} /> : null;
}
