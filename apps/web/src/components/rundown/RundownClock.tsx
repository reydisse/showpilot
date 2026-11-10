import { memo, useEffect, useRef, useState } from "react";
import { Pause, Play, Square } from "lucide-react";
import type { NativeTimerState, RundownItem } from "@/types/rundown";

type Timer = Pick<NativeTimerState, "playback" | "currentItemId" | "elapsed" | "startedAt" | "mode">;
interface ClockProps { timer: Timer; initialNow: number; overtimeBehavior: string }

export function formatOperatorDuration(ms: number): string {
  const negative = ms < 0;
  const totalSeconds = Math.floor(Math.abs(ms) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const prefix = negative ? "-" : "";
  return hours > 0
    ? `${prefix}${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
    : `${prefix}${minutes}:${seconds.toString().padStart(2, "0")}`;
}
function formatOffset(deltaMs: number): string {
  if (Math.abs(deltaMs) < 1000) return "";
  const seconds = Math.floor(Math.abs(deltaMs) / 1000);
  const prefix = deltaMs < 0 ? "-" : "+";
  if (seconds < 60) return `${prefix}${seconds}s`;
  const minutes = Math.floor(seconds / 60), remainder = seconds % 60;
  return remainder === 0 ? `${prefix}${minutes}m` : `${prefix}${minutes}m${remainder}s`;
}
function elapsedAt(timer: Timer, now: number) {
  return timer.elapsed + (timer.playback === "play" && timer.startedAt !== null ? Math.max(0, now - timer.startedAt) : 0);
}
function toneAt(remaining: number, overtimeBehavior: string) {
  return remaining < 0 && overtimeBehavior !== "stop" ? "overtime" : remaining <= 120000 ? "warning" : "normal";
}

// Only these small display components subscribe to clock ticks. The route and rows
// update on operator/relay state changes, never on this interval.
function useClock(initialNow: number, ticking: boolean) {
  const [now, setNow] = useState(initialNow);
  useEffect(() => {
    setNow(Date.now());
    if (!ticking) return;
    const interval = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(interval);
  }, [ticking]);
  return now;
}

export const RundownProgress = memo(function RundownProgress({ timer, duration, initialNow, overtimeBehavior, id, rounded = false }: ClockProps & { duration: number; id: string; rounded?: boolean }) {
  const bar = useRef<HTMLDivElement>(null);
  const resetUntil = useRef(0);
  useEffect(() => { resetUntil.current = Date.now() + 350; }, [timer.currentItemId]);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      const element = bar.current;
      if (!element) return;
      const now = Date.now(), resetting = now < resetUntil.current;
      const elapsed = elapsedAt(timer, now);
      element.style.transition = resetting ? "width 0.3s ease-out" : "none";
      element.style.width = `${resetting || duration <= 0 ? 0 : Math.max(0, Math.min(100, elapsed / duration * 100))}%`;
      element.dataset.tone = toneAt(duration - elapsed, overtimeBehavior);
      if (resetting || timer.playback === "play") frame = requestAnimationFrame(update);
    };
    update();
    return () => cancelAnimationFrame(frame);
  }, [timer, duration, overtimeBehavior]);
  return <div ref={bar} id={id} style={{ width: "0%" }} data-tone={toneAt(duration - elapsedAt(timer, initialNow), overtimeBehavior)}
    className={`h-full bg-white data-[tone=warning]:bg-yellow-500 data-[tone=overtime]:bg-red-500 ${rounded ? "rounded-full" : ""}`} />;
});

export const RundownOffset = memo(function RundownOffset({ timer, duration, initialNow }: Omit<ClockProps, "overtimeBehavior"> & { duration: number }) {
  const now = useClock(initialNow, timer.playback === "play");
  const elapsed = elapsedAt(timer, now);
  if (elapsed <= 0) return null;
  return <span className={`rundown-row-offset text-xs font-mono font-bold px-2 py-0.5 rounded-full shrink-0 ${elapsed > duration ? "bg-red-500/20 text-red-400 animate-pulse" : "bg-green-500/15 text-green-400"}`}>
    {formatOffset(elapsed - duration)}
  </span>;
});

type CurrentItem = Pick<RundownItem, "id" | "title" | "duration" | "assignee">;
export const RundownClockCard = memo(function RundownClockCard({ timer, initialNow, overtimeBehavior, currentItem, nextItem }: ClockProps & {
  currentItem: CurrentItem | undefined; nextItem: Pick<RundownItem, "title" | "duration"> | null | undefined;
}) {
  const now = useClock(initialNow, Boolean(currentItem) && (timer.playback === "play" || timer.mode === "clock"));
  const elapsed = elapsedAt(timer, now), remaining = currentItem ? currentItem.duration - elapsed : 0;
  const overtime = remaining < 0 && overtimeBehavior !== "stop";
  const text = !currentItem ? "--:--" : timer.mode === "clock"
    ? new Date(now).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",second:"2-digit"})
    : timer.mode === "count-down" ? remaining < 0 && overtimeBehavior === "stop" ? "00:00" : formatOperatorDuration(remaining)
    : formatOperatorDuration(elapsed);
  return <div className={`p-6 rounded-xl border ${overtime ? "bg-red-500/5 border-red-500/20" : "bg-board-card border-board-border"}`}>
    <div className="flex items-center gap-2 mb-2">
      {timer.playback === "play" ? <Play className="w-3.5 h-3.5 text-green-400 fill-green-400" /> : timer.playback === "pause" ? <Pause className="w-3.5 h-3.5 text-yellow-400" /> : <Square className="w-3.5 h-3.5 text-board-muted" />}
      <span className="text-xs font-medium text-board-muted uppercase tracking-widest">{timer.playback === "stop" ? "Stopped" : timer.playback === "play" ? "Playing" : "Paused"}</span>
      {overtime && <span className="text-xs font-bold text-red-400 uppercase tracking-wider ml-auto animate-pulse">Overtime</span>}
    </div>
    <p data-rundown-clock className={`text-6xl font-semibold tabular-nums tracking-tight ${overtime ? "text-red-400" : "text-board-text"}`}>{text}</p>
    {currentItem && <>
      <div className="mt-3 h-1.5 rounded-full bg-board-border overflow-hidden">
        <RundownProgress timer={timer} duration={currentItem.duration} initialNow={initialNow} overtimeBehavior={overtimeBehavior} id="rundown-progress-fill" rounded />
      </div>
      <div className="mt-3 pt-3 border-t border-board-border/40">
        <p className="text-sm font-medium text-board-text truncate">{currentItem.title}</p>
        <p className="text-xs text-board-muted mt-0.5">Duration: {formatOperatorDuration(currentItem.duration)}{currentItem.assignee && ` · ${currentItem.assignee}`}</p>
      </div>
    </>}
    {nextItem && <p className="text-xs text-board-muted mt-2">Next: <span className="text-board-text/70">{nextItem.title}</span><span className="text-board-muted ml-1">({formatOperatorDuration(nextItem.duration)})</span></p>}
  </div>;
});
