import { memo, useEffect, useState } from "react";
import { deriveCallerClock, liveElapsedMs, type CueRow } from "@/lib/cue-sheet-derive";
import { useDeviceTimeZone } from "@/hooks/useDeviceTimeZone";
import type { NativeTimerState } from "@/types/rundown";

type Timer = Pick<NativeTimerState, "playback" | "elapsed" | "startedAt">;
function duration(ms: number | null) {
  if (ms === null) return "--:--";
  const total = Math.floor(Math.abs(ms) / 1000), hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60), seconds = String(total % 60).padStart(2, "0");
  return `${ms < 0 ? "+" : ""}${hours ? `${hours}:${String(minutes).padStart(2, "0")}` : minutes}:${seconds}`;
}
function offset(ms: number | null) {
  if (ms === null) return "—";
  const seconds = Math.round(Math.abs(ms) / 1000);
  if (seconds < 30) return "On time";
  return `${ms > 0 ? "+" : "−"}${Math.floor(seconds / 60)}m${seconds % 60 ? `${seconds % 60}s` : ""}`;
}
export const CallerClockBar = memo(function CallerClockBar({ rows, currentItemId, timer, initialNow }: { rows: CueRow[]; currentItemId: string | null; timer: Timer | null; initialNow: number }) {
  const [now, setNow] = useState(initialNow), timeZone = useDeviceTimeZone();
  useEffect(() => { setNow(Date.now()); const id = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const state = deriveCallerClock({ rows, currentItemId, elapsedMs: timer ? liveElapsedMs({ ...timer, nowMs: now }) : 0, nowMs: now });
  const remaining = state.itemRemainingMs;
  const over = remaining !== null && remaining < 0;
  const attention = remaining !== null && remaining >= 0 && remaining <= 90_000;
  const current = rows.find(row => row.itemId === currentItemId);
  const total = current?.durationMs ?? 0;
  const progress = over ? 100 : total && remaining !== null ? Math.min(100, Math.max(0, remaining / total * 100)) : 0;
  const clock = (ms: number | null) => ms === null ? "--:--" : new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
  const active = state.liveTitle !== null;
  return <section aria-label="Show timing" className="cue-clock" data-tone={over ? "over" : attention ? "attention" : "normal"}>
    <span className="cue-clock-status" data-playing={active}>{active ? timer?.playback === "pause" ? "Paused" : "Playing" : "Standing by"}</span>
    <Stat label="Now running" value={state.liveTitle ?? "Nothing running"} className="cue-clock-current" />
    <div className="cue-clock-stat"><span>Left on item</span><span className="cue-mono cue-clock-remaining">{duration(remaining)}</span>{active && <span className="cue-clock-progress"><i style={{ width: `${progress}%` }} /></span>}</div>
    <Stat label="Next" value={state.nextTitle ?? "End of rundown"} className="cue-clock-current" />
    {(over || attention) && <span className="cue-clock-alert">{over ? "Overtime" : "Attention"}</span>}
    <div className="cue-clock-right"><Stat label="Now" value={clock(now)} mono /><Stat label="Planned end" value={clock(state.plannedEndMs)} mono className="cue-clock-planned" /><Stat label="Expected end" value={clock(state.expectedEndMs)} mono /><Stat label="Offset" value={offset(state.offsetMs)} mono /></div>
  </section>;
});
function Stat({ label, value, mono, className = "" }: { label: string; value: string; mono?: boolean; className?: string }) {
  return <div className={`cue-clock-stat ${className}`}><span>{label}</span><span className={`cue-clock-value ${mono ? "cue-mono" : ""}`} title={value}>{value}</span></div>;
}
