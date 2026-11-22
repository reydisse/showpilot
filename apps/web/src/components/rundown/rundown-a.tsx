import type React from "react";
import { memo, useEffect, useState } from "react";
import type { NativeTimerState, RundownItem } from "@/types/rundown";
import { computeShowPlan, dayTime, hoursClock, minutesClock, type ShowPlan } from "@/components/show/show-flow-a";
import { AlertTriangle, Eye, RefreshCw } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { RundownProgress } from "./RundownClock";

/**
 * Rundown — A (Doop canvas aneicgaHqk, "Rundown" page): timer card, side panels,
 * keyboard hints and the plan/projection the runsheet shows. Colours come from
 * the `.schedule-a` palette.
 */

type Timer = Pick<NativeTimerState, "playback" | "currentItemId" | "elapsed" | "startedAt" | "mode">;

export const eyebrow = "text-xs font-medium uppercase tracking-[0.07em] text-[var(--sa-ink-3)]";

export function elapsedAt(timer: Timer, now: number) {
  return timer.elapsed + (timer.playback === "play" && timer.startedAt !== null ? Math.max(0, now - timer.startedAt) : 0);
}

// ─── Plan and projection ─────────────────────────────────────

export type RundownProjection = {
  plan: ShowPlan;
  /** Actual times for items that ran, and projected times for the rest once the show is under way. */
  projected: Map<string, { start: number; end: number }>;
  /** Positive when the show will end after its planned end. Null before anything has run. */
  behind: number | null;
  projectedEnd: number | null;
};

/**
 * Planned starts come from the show start plus durations. Once an item has run,
 * every later item is projected from where the show really is.
 */
export function projectRundown(items: RundownItem[], scheduledStart: string | null | undefined, currentId: string | null, elapsed: number, now: number): RundownProjection {
  const plan = computeShowPlan(items, scheduledStart);
  const projected = new Map<string, { start: number; end: number }>();
  let cursor: number | null = null;
  let pastCurrent = false;
  for (const item of plan.cues) {
    const actualStart = item.actualStart ? Date.parse(item.actualStart) : NaN;
    if (item.id === currentId && Number.isFinite(actualStart)) {
      const end = Math.max(actualStart + item.duration, now + Math.max(0, item.duration - elapsed));
      projected.set(item.id, { start: actualStart, end });
      cursor = end;
      pastCurrent = true;
    } else if (item.status === "complete" && Number.isFinite(actualStart)) {
      const actualEnd = item.actualEnd ? Date.parse(item.actualEnd) : NaN;
      const end = Number.isFinite(actualEnd) ? actualEnd : actualStart + item.duration;
      projected.set(item.id, { start: actualStart, end });
      // Something already run but placed after the live item does not pull the projection back.
      if (!pastCurrent) cursor = end;
    } else if (cursor !== null && currentId !== null) {
      projected.set(item.id, { start: cursor, end: cursor + item.duration });
      cursor += item.duration;
    }
  }
  // Before and after a run there is no projection, only what happened.
  const raw = currentId !== null && cursor !== null && plan.plannedEnd !== null ? cursor - plan.plannedEnd : null;
  // A show run on another day than planned (rehearsal, test) has no meaningful delta.
  const behind = raw !== null && Math.abs(raw) <= 6 * 3_600_000 ? raw : null;
  return { plan, projected, behind, projectedEnd: cursor };
}

/** "2:10 behind" / "1:05 ahead" / "on time". */
export function runningLabel(behind: number) {
  if (Math.abs(behind) < 30_000) return "on time";
  return `${hoursClock(Math.abs(behind))} ${behind > 0 ? "behind" : "ahead"}`;
}

/** Re-renders every `ms` while `active`, for projections that move with the clock. */
export function useCoarseNow(active: boolean, ms = 10_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [active, ms]);
  return now;
}

// ─── Small pieces ────────────────────────────────────────────

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-[var(--sa-border-strong)] bg-[var(--sa-surface-2)] px-1.5 font-[inherit] text-xs leading-none text-[var(--sa-ink-2)]">{children}</kbd>;
}

/** "Shift + Space" → two key caps. */
export function KeyCombo({ keys }: { keys: string }) {
  return <span className="inline-flex items-center gap-1">{keys.split(" + ").map(key => <Kbd key={key}>{key}</Kbd>)}</span>;
}

export function PlaybackPill({ playback }: { playback: Timer["playback"] }) {
  const label = playback === "play" ? "Playing" : playback === "pause" ? "Paused" : "Stopped";
  const tone = playback === "play" ? "border-[var(--sa-ok)]/35 bg-[var(--sa-ok)]/[0.08]" : playback === "pause" ? "border-[var(--sa-warn)]/35 bg-[var(--sa-warn)]/[0.08]" : "border-[var(--sa-border-strong)]";
  const dot = playback === "play" ? "bg-[var(--sa-ok)]" : playback === "pause" ? "bg-[var(--sa-warn)]" : "shadow-[inset_0_0_0_1.5px_var(--sa-ink-2)]";
  return <span className={`inline-flex h-[26px] shrink-0 items-center gap-[7px] whitespace-nowrap rounded-full border px-2.5 text-xs font-medium text-board-text ${tone}`}>
    <span aria-hidden="true" className={`h-[7px] w-[7px] shrink-0 rounded-full ${dot}`} />{label}
  </span>;
}

export function Toggle({ checked, onChange, label, disabled, tone = "ok" }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean; tone?: "ok" | "warn" }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
    className="relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full disabled:opacity-40 lg:h-6 lg:w-8">
    <span aria-hidden="true" className={`relative h-4 w-7 rounded-full transition-colors ${checked ? tone === "warn" ? "bg-[var(--sa-warn)]" : "bg-[var(--sa-ok)]" : "bg-[var(--sa-surface-3)] shadow-[inset_0_0_0_1px_var(--sa-border-strong)]"}`}>
      <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-[left] ${checked ? "left-[14px]" : "left-0.5 bg-[var(--sa-ink-2)]"}`} />
    </span>
  </button>;
}

/** A side panel: icon + eyebrow title on the left, an optional control on the right. */
export function Panel({ icon: Icon, title, aside, children, className = "", labelledBy }: { icon: React.ElementType; title: React.ReactNode; aside?: React.ReactNode; children?: React.ReactNode; className?: string; labelledBy?: string }) {
  return <section aria-labelledby={labelledBy} className={`flex flex-col gap-4 rounded-2xl border border-[var(--sa-border)] bg-[var(--sa-surface)] p-5 ${className}`}>
    <div className="flex min-h-6 items-center justify-between gap-3">
      <h2 id={labelledBy} className={`flex items-center gap-2.5 ${eyebrow} text-[var(--sa-ink-2)]`}><Icon aria-hidden="true" className="h-3.5 w-3.5 text-[var(--sa-ink-3)]" strokeWidth={1.75} />{title}</h2>
      {aside}
    </div>
    {children}
  </section>;
}

export const rundownButton = "[&_svg]:shrink-0 inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface-2)] px-3 text-[13px] font-medium text-board-text hover:bg-[var(--sa-surface-3)] disabled:opacity-40 max-lg:h-11";

// ─── Timer card ──────────────────────────────────────────────

type CardItem = Pick<RundownItem, "id" | "title" | "duration" | "assignee" | "actualStart">;

/**
 * The live timer card. Only this component ticks; the page re-renders on operator
 * and relay changes. `transport` is the play/prev/next/end row.
 */
export const RundownTimerCard = memo(function RundownTimerCard({ timer, initialNow, overtimeBehavior, current, next, first, section, firstSection, cueIndex, cueCount, startsAt, plannedStart, plannedShowEnd, timeZone, hour12, transport, hint }: {
  timer: Timer;
  initialNow: number;
  overtimeBehavior: string;
  current: CardItem | undefined;
  next: Pick<RundownItem, "title" | "duration" | "assignee"> | null | undefined;
  first: Pick<RundownItem, "title" | "duration" | "assignee"> | null | undefined;
  section: string | null;
  firstSection: string | null;
  cueIndex: number;
  cueCount: number;
  /** "9:00 AM" */
  startsAt: string | null;
  /** Planned start of the current item (ms), for "Behind plan". */
  plannedStart: number | null;
  /** Planned end of the show (ms), for the overtime note. */
  plannedShowEnd: number | null;
  timeZone: string;
  hour12: boolean;
  transport: React.ReactNode;
  hint?: React.ReactNode;
}) {
  const ticking = Boolean(current) && (timer.playback === "play" || timer.mode === "clock");
  const [now, setNow] = useState(initialNow);
  useEffect(() => {
    setNow(Date.now());
    if (!ticking) return;
    const interval = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, [ticking]);

  if (!current) {
    return <section aria-label="Rundown timer" className="flex flex-col gap-5 rounded-2xl border border-[var(--sa-border)] bg-[var(--sa-surface)] p-6">
      <div className="flex items-center justify-between gap-3">
        <PlaybackPill playback="stop" />
        {startsAt ? <span className="text-xs text-[var(--sa-ink-3)]">Starts <span className="tabular-nums text-[var(--sa-ink-2)]">{startsAt}</span></span> : null}
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <p className={eyebrow}>Up first{firstSection ? ` · ${firstSection}` : ""}</p>
        <p className="truncate text-[22px] font-semibold tracking-[-0.02em] text-board-text">{first?.title || "Nothing to run yet"}</p>
        {first?.assignee ? <p className="truncate text-[13px] text-[var(--sa-ink-3)]">{first.assignee}</p> : null}
      </div>
      <div className="flex flex-col gap-2">
        <p data-rundown-clock className="tabular-nums font-medium leading-[0.9] tracking-[-0.04em] text-[var(--sa-ink-2)]" style={{ fontSize: "clamp(3.5rem, 9vw, 5.5rem)" }}>{first ? minutesClock(first.duration) : "0:00"}</p>
        <p className="text-[13px] text-[var(--sa-ink-2)]">{first ? "Counts down when you start the show" : "Add items to the runsheet to start the show"}</p>
      </div>
      <div className="h-1.5 rounded-[3px] bg-[var(--sa-surface-3)]" />
      {transport}
      {hint}
    </section>;
  }

  const elapsed = elapsedAt(timer, now);
  const remaining = current.duration - elapsed;
  const over = remaining < 0 && overtimeBehavior !== "stop";
  const attention = !over && timer.playback === "play" && remaining <= 90_000;
  const card = over ? "border-[var(--sa-danger)]/40 bg-[var(--sa-danger)]/[0.07]" : attention ? "border-[var(--sa-warn)]/40 bg-[var(--sa-warn)]/[0.05]" : "border-[var(--sa-border)] bg-[var(--sa-surface)]";
  const numeral = timer.mode === "clock"
    ? new Date(now).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12, timeZone })
    : timer.mode === "count-up" ? hoursClock(elapsed)
    : remaining < 0 && overtimeBehavior === "stop" ? "0:00" : hoursClock(remaining);
  const started = current.actualStart ? Date.parse(current.actualStart) : NaN;
  const rawBehind = Number.isFinite(started) && plannedStart !== null ? started - plannedStart + Math.max(0, elapsed - current.duration) : null;
  const behind = rawBehind !== null && Math.abs(rawBehind) <= 6 * 3_600_000 ? rawBehind : null;
  const overBy = Math.max(0, elapsed - current.duration);
  const newEnd = plannedShowEnd !== null && behind !== null ? plannedShowEnd + behind : null;
  const stat = (k: string, v: string, tone?: "warn" | "muted") => <div className="flex min-w-0 flex-col gap-1">
    <span className={eyebrow}>{k}</span>
    <span className={`whitespace-nowrap text-lg tabular-nums ${tone === "warn" ? "text-[var(--sa-warn)]" : tone === "muted" ? "text-[var(--sa-ink-3)]" : "text-board-text"}`}>{v}</span>
  </div>;
  return <section aria-label="Rundown timer" className={`flex flex-col gap-5 rounded-2xl border p-6 ${card}`}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <PlaybackPill playback={timer.playback} />
      <span className="inline-flex items-center gap-3 text-xs text-[var(--sa-ink-3)]">
        {over ? <span className="text-xs font-semibold uppercase tracking-[0.07em] text-[var(--sa-danger)]">Overtime</span>
          : attention ? <span className="text-xs font-semibold uppercase tracking-[0.07em] text-[var(--sa-warn)]">Attention</span> : null}
        <span>Item <span className="tabular-nums text-[var(--sa-ink-2)]">{cueIndex}</span> of <span className="tabular-nums text-[var(--sa-ink-2)]">{cueCount}</span></span>
      </span>
    </div>
    <div className="flex min-w-0 flex-col gap-1">
      <p className={eyebrow}>{timer.playback === "pause" ? "Paused" : "Now"}{section ? ` · ${section}` : ""}</p>
      <p className="truncate text-[22px] font-semibold tracking-[-0.02em] text-board-text">{current.title || "Untitled"}</p>
      {current.assignee ? <p className="truncate text-[13px] text-[var(--sa-ink-3)]">{current.assignee}</p> : null}
    </div>
    <div className="flex flex-col gap-2">
      <p data-rundown-clock className={`tabular-nums font-medium leading-[0.9] tracking-[-0.04em] ${over ? "text-[var(--sa-danger)]" : "text-board-text"}`} style={{ fontSize: "clamp(3.5rem, 9vw, 5.5rem)" }}>{numeral}</p>
      <p className="text-[13px] text-[var(--sa-ink-2)]">{over ? "past the planned" : "remaining of"} <span className="tabular-nums text-board-text">{minutesClock(current.duration)}</span></p>
    </div>
    <div className="h-1.5 overflow-hidden rounded-[3px] bg-[var(--sa-surface-3)]">
      <RundownProgress timer={timer} duration={current.duration} initialNow={initialNow} overtimeBehavior={overtimeBehavior} id="rundown-progress-fill" rounded />
    </div>
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      {stat("Elapsed", hoursClock(elapsed))}
      {stat("Started", Number.isFinite(started) ? dayTime(started, timeZone, hour12) : "—")}
      {over ? stat("Planned", minutesClock(current.duration), "muted") : stat("Ends", Number.isFinite(started) ? dayTime(started + current.duration, timeZone, hour12) : "—")}
      {behind !== null && Math.abs(behind) >= 30_000 ? stat(behind > 0 ? "Behind plan" : "Ahead", hoursClock(Math.abs(behind)), behind > 0 ? "warn" : undefined) : stat("Schedule", behind === null ? "—" : "On time")}
    </div>
    {over ? <p className="rounded-lg border border-[var(--sa-danger)]/30 bg-[var(--sa-danger)]/[0.08] px-4 py-3 text-[13px] leading-[1.55] text-board-text">
      {current.title || "This item"} is running <span className="tabular-nums">{hoursClock(overBy)}</span> long.
      {newEnd !== null && plannedShowEnd !== null ? <> The show now ends around <span className="tabular-nums">{dayTime(newEnd, timeZone, hour12)}</span> instead of <span className="tabular-nums">{dayTime(plannedShowEnd, timeZone, hour12)}</span>.</> : null}
      {" "}Use Next item when {current.assignee || "they"} wrap{current.assignee ? "s" : ""}, or trim time below.
    </p> : null}
    {transport}
    {hint}
    {next ? <p className="flex min-w-0 items-center gap-2.5 border-t border-[var(--sa-border)] pt-4 text-[13px]">
      <span className={eyebrow}>Up next</span>
      <span className="truncate text-board-text">{next.title || "Untitled"}<span className="tabular-nums text-[var(--sa-ink-3)]"> · {minutesClock(next.duration)}</span></span>
    </p> : null}
  </section>;
});

// ─── Header clock and page states ────────────────────────────

/** Wall clock for the header. Renders after mount so server and client agree. */
export function WallClock({ timeZone, hour12 }: { timeZone: string; hour12: boolean }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return <span className="hidden min-w-[72px] text-right tabular-nums text-[15px] text-board-text sm:inline" aria-label="Current time">
    {now === null ? "" : new Date(now).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12, timeZone })}
  </span>;
}

/** One calm skeleton in the real two-column layout. No spinner, no copy. */
export function RundownSkeleton() {
  const bar = (className: string) => <span className={`block rounded bg-[var(--sa-surface-3)] ${className}`} />;
  return <div className="flex min-h-0 flex-1 gap-5 px-4 pt-5 sm:px-6 lg:px-7">
    <p role="status" className="sr-only">Loading rundown…</p>
    <div aria-hidden="true" className="schedule-skeleton hidden w-[420px] shrink-0 flex-col gap-4 rounded-2xl border border-[var(--sa-border)] bg-[var(--sa-surface)] p-6 md:flex">
      {bar("h-6 w-20 rounded-full")}{bar("h-3 w-32")}{bar("h-14 w-44")}{bar("h-1.5 w-full")}{bar("h-11 w-full rounded-lg")}
    </div>
    <div aria-hidden="true" className="schedule-skeleton min-w-0 flex-1 overflow-hidden rounded-2xl border border-[var(--sa-border)] bg-[var(--sa-surface)]">
      <div className="px-5 py-4">{bar("h-3 w-40")}</div>
      <div className="h-9 border-y border-[var(--sa-border)] bg-board-bg" />
      {[0, 1, 2, 3].map(row => <div key={row} className="flex items-center gap-4 border-b border-[var(--sa-border)] px-5 py-4">{bar("h-2.5 w-6")}{bar("h-2.5 w-10")}{bar("h-2.5 flex-1 max-w-[220px]")}<span className="ml-auto">{bar("h-2.5 w-10")}</span></div>)}
    </div>
  </div>;
}

// ─── Take live ───────────────────────────────────────────────

/**
 * Confirms routing venue outputs to this show. Cancel takes default focus; the
 * dialog stays open while the switch is confirmed, then closes on success.
 */
export function TakeLiveDialog({ open, onOpenChange, showName, liveName, pending, onConfirm }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  showName: string;
  /** The show driving outputs now, if another one is. */
  liveName: string | null;
  pending: boolean;
  onConfirm: () => Promise<boolean>;
}) {
  return <Dialog open={open} onOpenChange={next => { if (!pending) onOpenChange(next); }}>
    <DialogContent showCloseButton={false} className="schedule-a flex max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-[14px] border-[var(--sa-border-strong)] bg-[var(--sa-surface)] p-0 text-board-text shadow-[0_24px_64px_rgba(0,0,0,0.6)] sm:max-w-[440px]">
      <div className="flex gap-3.5 px-5 pb-4 pt-5">
        <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border border-fire-500/40 bg-fire-500/10 text-fire-400"><AlertTriangle className="h-[18px] w-[18px]" strokeWidth={1.75} /></span>
        <div className="flex min-w-0 flex-col gap-1.5">
          <DialogTitle className="text-base font-semibold tracking-[-0.01em]">Take {showName} live?</DialogTitle>
          <DialogDescription className="text-[13px] leading-[1.55] text-[var(--sa-ink-2)]">Timer, lyrics, kiosk, Show Flow, and other venue outputs will switch to this show. Browsing alone never changes them.</DialogDescription>
        </div>
      </div>
      {liveName ? <p className="mx-5 mb-4 flex gap-2.5 rounded-lg bg-[var(--sa-surface-2)] px-3.5 py-3 text-[13px] leading-[1.5] text-[var(--sa-ink-2)]">
        <Eye aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--sa-ink-3)]" /><span><span className="font-semibold text-board-text">{liveName}</span> is live now and will stop driving outputs.</span>
      </p> : null}
      <div className="flex items-center gap-2 border-t border-[var(--sa-border)] bg-board-bg px-5 py-3.5">
        <span className="mr-auto hidden items-center gap-1.5 text-xs text-[var(--sa-ink-3)] sm:inline-flex"><Kbd>Esc</Kbd> to cancel</span>
        <button type="button" autoFocus disabled={pending} onClick={() => onOpenChange(false)} className="inline-flex h-9 items-center rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface-2)] px-3.5 text-[13px] font-medium text-board-text hover:bg-[var(--sa-surface-3)] disabled:opacity-40 max-lg:h-11">Cancel</button>
        <button type="button" disabled={pending} onClick={() => { void onConfirm().then(ok => { if (ok) onOpenChange(false); }); }}
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-fire-500 px-3.5 text-[13px] font-semibold text-[#1a1300] hover:bg-fire-400 disabled:opacity-60 max-lg:h-11">
          {pending ? <><RefreshCw aria-hidden="true" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />Switching…</> : "Take live"}
        </button>
      </div>
    </DialogContent>
  </Dialog>;
}
