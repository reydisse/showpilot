import type React from "react";
import { Check, LayoutTemplate, Link2, List, WifiOff } from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { RundownItem } from "@/types/rundown";

/**
 * Show — A (Doop canvas aneicgaHqk, "Show" page): header stats, timer card,
 * rundown card and page states. Colours come from the `.schedule-a` palette.
 */

export type ShowPlan = {
  cues: RundownItem[];
  /** Planned start (ms) per item id, from the show start plus prior durations. */
  starts: Map<string, number>;
  sections: Map<string, { title: string; start: number | null; duration: number }>;
  /** Section header id for each cue. */
  sectionOf: Map<string, string>;
  plannedStart: number | null;
  plannedEnd: number | null;
  runtime: number;
};

export function computeShowPlan(items: RundownItem[], scheduledStart: string | null | undefined): ShowPlan {
  const plannedStart = scheduledStart ? Date.parse(scheduledStart) : null;
  const starts = new Map<string, number>();
  const sections = new Map<string, { title: string; start: number | null; duration: number }>();
  const sectionOf = new Map<string, string>();
  const cues: RundownItem[] = [];
  let offset = 0;
  let section: string | null = null;
  for (const item of items) {
    if (item.type === "header") {
      section = item.id;
      sections.set(item.id, { title: item.title || "Section", start: plannedStart === null ? null : plannedStart + offset, duration: 0 });
      continue;
    }
    cues.push(item);
    if (plannedStart !== null) starts.set(item.id, plannedStart + offset);
    if (section) {
      sectionOf.set(item.id, section);
      sections.get(section)!.duration += item.duration;
    }
    offset += item.duration;
  }
  return { cues, starts, sections, sectionOf, plannedStart, plannedEnd: plannedStart === null ? null : plannedStart + offset, runtime: offset };
}

/** "55:00", "60:00" — minutes are not rolled into hours (cue and section lengths). */
export function minutesClock(ms: number) {
  const total = Math.round(Math.abs(ms) / 1000);
  return `${ms < 0 ? "−" : ""}${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** "2:33:00" / "12:40" — rolls into hours when needed (timers and runtime). */
export function hoursClock(ms: number) {
  const total = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const body = h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  return `${ms < 0 ? "−" : ""}${body}`;
}

/** Time of day without the AM/PM suffix, as the design writes rundown times ("9:00", "11:33"). */
export function dayTime(ms: number | null, timeZone: string, hour12: boolean) {
  if (ms === null || !Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12, timeZone }).replace(/\s?[AP]M$/i, "");
}

export function behindLabel(ms: number) {
  if (Math.abs(ms) < 30_000) return "on time";
  return `${minutesClock(Math.abs(ms))} ${ms > 0 ? "behind" : "ahead"}`;
}

// ─── Header ──────────────────────────────────────────────────

export type StatusPillState = "ready" | "live" | "paused" | "over" | "offline";

export function StatusPill({ state }: { state: StatusPillState }) {
  const label = { ready: "Ready", live: "Live", paused: "Paused", over: "Over time", offline: "Reconnecting…" }[state];
  const tone = {
    ready: "border-[var(--sa-border)]",
    live: "border-[var(--sa-ok)]/35 bg-[var(--sa-ok)]/[0.08]",
    paused: "border-[var(--sa-warn)]/35 bg-[var(--sa-warn)]/[0.08]",
    over: "border-[var(--sa-danger)]/35 bg-[var(--sa-danger)]/[0.08]",
    offline: "border-[var(--sa-border)] text-[var(--sa-ink-2)]",
  }[state];
  const dot = {
    ready: "bg-[var(--sa-ok)]",
    live: "bg-[var(--sa-ok)] shadow-[0_0_0_3px_rgba(62,207,142,0.2)]",
    paused: "bg-[var(--sa-warn)]",
    over: "bg-[var(--sa-danger)]",
    offline: "shadow-[inset_0_0_0_1.5px_var(--sa-ink-3)]",
  }[state];
  return <span role="status" className={`inline-flex h-[26px] shrink-0 items-center gap-[7px] whitespace-nowrap rounded-full border px-2.5 text-xs font-medium text-board-text ${tone}`}>
    <span aria-hidden="true" className={`h-[7px] w-[7px] shrink-0 rounded-full ${dot}`} />{label}
  </span>;
}

export type HeaderStat = { label: string; value: string; tone?: "default" | "warn" | "muted" };

export function Stat({ label, value, tone = "default" }: HeaderStat) {
  return <div className="flex min-w-0 flex-col gap-1">
    <span className="whitespace-nowrap text-[11px] font-medium uppercase tracking-[0.07em] text-[var(--sa-ink-3)]">{label}</span>
    <span className={`whitespace-nowrap tabular-nums text-base ${tone === "warn" ? "text-[var(--sa-warn)]" : tone === "muted" ? "text-[var(--sa-ink-3)]" : "text-board-text"}`}>{value}</span>
  </div>;
}

export function ShowFlowHeader({ dateLine, title, stats, layoutMenu, clock, status }: {
  dateLine: string;
  title: string;
  stats: HeaderStat[];
  layoutMenu: React.ReactNode;
  clock: string;
  status: StatusPillState;
}) {
  return <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
    <div className="flex min-w-0 flex-col gap-1.5">
      <p className="tabular-nums text-xs uppercase tracking-[0.04em] text-[var(--sa-ink-3)]">{dateLine}</p>
      <h1 className="truncate text-[22px] font-semibold leading-[1.15] tracking-[-0.02em] text-board-text">{title}</h1>
    </div>
    <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2">
      <div className="flex items-center gap-5">{stats.map(stat => <Stat key={stat.label} {...stat} />)}</div>
      {stats.length ? <span aria-hidden="true" className="hidden h-8 w-px bg-[var(--sa-border)] lg:block" /> : null}
      <div className="hidden lg:block">{layoutMenu}</div>
      <span className="tabular-nums text-sm text-board-text">{clock}</span>
      <StatusPill state={status} />
    </div>
  </header>;
}

// ─── Timer card ──────────────────────────────────────────────

export type TimerCardModel =
  | { kind: "ready"; startsAt: string | null; untilStart: number | null; first: RundownItem | null; firstLength: string }
  | {
      kind: "running";
      paused: boolean;
      section: string | null;
      cueIndex: number;
      cueCount: number;
      item: RundownItem;
      remaining: number;
      progress: number;
      elapsed: string;
      started: string;
      cueEnds: string;
      planned: string;
      schedule: string | null;
      scheduleTone: "default" | "warn";
      next: RundownItem | null;
      overtimeNote: string | null;
    };

const label = "text-[11px] font-medium uppercase tracking-[0.07em] text-[var(--sa-ink-3)]";

export function TimerCard({ model, compact = false }: { model: TimerCardModel; compact?: boolean }) {
  if (model.kind === "ready") {
    const late = model.untilStart !== null && model.untilStart < 0;
    if (compact) return <section className="flex flex-wrap items-center gap-x-8 gap-y-2 rounded-2xl border border-[var(--sa-border)] bg-[var(--sa-surface)] px-5 py-4">
      <div className="min-w-0"><p className={label}>Not started</p><p className="truncate text-base font-semibold text-board-text">{model.first?.title ?? "No cues yet"}</p></div>
      <p className="tabular-nums text-[44px] font-medium leading-none tracking-[-0.04em] text-[var(--sa-ink-2)]">{model.untilStart === null ? "—" : hoursClock(Math.abs(model.untilStart))}</p>
      <p className="text-[13px] text-[var(--sa-ink-2)]">{model.startsAt ? `${late ? "late to start at" : "until the show starts at"} ${model.startsAt}` : "Start time not set"}</p>
    </section>;
    return <section aria-label="Show timer" className="flex h-full flex-col gap-5 rounded-2xl border border-[var(--sa-border)] bg-[var(--sa-surface)] p-6 [container-type:inline-size]">
      <div className="flex items-center justify-between gap-3">
        <span className={label}>Not started</span>
        {model.startsAt ? <span className="text-xs text-[var(--sa-ink-3)]">Starts <span className="tabular-nums text-[var(--sa-ink-2)]">{model.startsAt}</span></span> : null}
      </div>
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="flex min-w-0 flex-col gap-1">
          <span className={`tabular-nums font-medium leading-[0.9] tracking-[-0.04em] ${late ? "text-[var(--sa-warn)]" : "text-[var(--sa-ink-2)]"}`} style={{ fontSize: "clamp(3rem, 14cqw, 6.5rem)" }}>{model.untilStart === null ? "—:—" : hoursClock(Math.abs(model.untilStart))}</span>
          <span className="text-[13px] text-[var(--sa-ink-2)]">{model.startsAt ? <>{late ? "past the planned start at" : "until the show starts at"} <span className="tabular-nums text-board-text">{model.startsAt}</span></> : "Set a start time on the show to count down to it."}</span>
        </div>
        {model.first ? <div className="flex min-w-0 flex-col items-end gap-1 text-right">
          <span className={label}>Up first</span>
          <span className="truncate text-base font-semibold text-board-text">{model.first.title || "Untitled"}</span>
          <span className="text-[13px] text-[var(--sa-ink-2)]">{[model.first.assignee, model.firstLength].filter(Boolean).join(" · ")}</span>
        </div> : null}
      </div>
      <div className="h-1.5 rounded-[3px] bg-[var(--sa-surface-3)]" />
      <p className="flex items-center gap-2.5 border-t border-[var(--sa-border)] pt-4 text-[13px] text-[var(--sa-ink-2)]">
        <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full shadow-[inset_0_0_0_1.5px_var(--sa-ink-3)]" />
        Waiting for the operator to start the show. This screen follows along automatically.
      </p>
    </section>;
  }

  const over = model.remaining < 0;
  const attention = !over && !model.paused && model.remaining <= 90_000;
  const tone = over ? "danger" : attention ? "warn" : "none";
  const card = tone === "danger"
    ? "border-[var(--sa-danger)]/35 bg-[var(--sa-danger)]/[0.07]"
    : tone === "warn" ? "border-[var(--sa-warn)]/35 bg-[var(--sa-warn)]/[0.06]" : "border-[var(--sa-border)] bg-[var(--sa-surface)]";
  const bar = tone === "danger" ? "bg-[var(--sa-danger)]" : tone === "warn" ? "bg-[var(--sa-warn)]" : "bg-board-text";
  const stateLabel = model.paused ? "Paused" : over ? "Overtime" : attention ? "Attention" : null;
  const lead = `${model.paused ? "Paused" : "Now"}${model.section ? ` · ${model.section}` : ""}`;
  const numeral = <span className={`tabular-nums font-medium leading-[0.9] tracking-[-0.04em] ${over ? "text-[var(--sa-danger)]" : "text-board-text"}`}>{hoursClock(model.remaining)}</span>;
  const lengthNote = <span className="text-[13px] text-[var(--sa-ink-2)]">{over ? "past the planned" : "remaining of"} <span className="tabular-nums text-board-text">{minutesClock(model.item.duration)}</span></span>;

  if (compact) return <section aria-label="Show timer" className={`flex flex-wrap items-center gap-x-8 gap-y-2 rounded-2xl border px-5 py-4 ${card}`}>
    <div className="min-w-0"><p className={label}>{lead}</p><p className="truncate text-base font-semibold text-board-text">{model.item.title || "Untitled"}</p></div>
    <p className="flex items-baseline gap-2"><span className="text-[44px]">{numeral}</span><span className="text-xs text-[var(--sa-ink-3)]">{over ? "over" : "left of"} <span className="tabular-nums">{minutesClock(model.item.duration)}</span></span></p>
    <Stat label="Elapsed" value={model.elapsed} />
    {model.schedule ? <Stat label="Schedule" value={model.schedule} tone={model.scheduleTone} /> : null}
    {model.next ? <div className="ml-auto min-w-0 text-right"><p className={label}>Up next</p><p className="truncate text-[13px] text-board-text">{model.next.title} · <span className="tabular-nums text-[var(--sa-ink-3)]">{minutesClock(model.next.duration)}</span></p></div> : null}
  </section>;

  return <section aria-label="Show timer" className={`flex h-full flex-col gap-5 rounded-2xl border p-6 [container-type:inline-size] ${card}`}>
    <div className="flex items-center justify-between gap-3">
      <span className={label}>{lead}</span>
      <span className="inline-flex items-center gap-3 text-xs text-[var(--sa-ink-3)]">
        {stateLabel ? <span className={`text-[11px] font-semibold uppercase tracking-[0.07em] ${over ? "text-[var(--sa-danger)]" : "text-[var(--sa-warn)]"}`}>{stateLabel}</span> : null}
        <span>Cue <span className="tabular-nums text-[var(--sa-ink-2)]">{model.cueIndex}</span> of <span className="tabular-nums text-[var(--sa-ink-2)]">{model.cueCount}</span></span>
      </span>
    </div>
    <div className="flex flex-wrap items-end justify-between gap-6">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate text-2xl font-semibold tracking-[-0.02em] text-board-text">{model.item.title || "Untitled"}</span>
        {model.item.assignee ? <span className="truncate text-[13px] text-[var(--sa-ink-3)]">{model.item.assignee}</span> : null}
      </div>
      <div className="flex flex-col items-end gap-1">
        <span style={{ fontSize: "clamp(3rem, 14cqw, 6.5rem)" }}>{numeral}</span>
        {lengthNote}
      </div>
    </div>
    <div className="h-1.5 overflow-hidden rounded-[3px] bg-[var(--sa-surface-3)]"><div className={`h-full rounded-[3px] transition-[width] ${bar}`} style={{ width: `${Math.round(model.progress * 100)}%` }} /></div>
    <div className="grid grid-cols-2 gap-4 @min-[480px]:grid-cols-4">
      <Stat label="Elapsed" value={model.elapsed} />
      <Stat label="Started" value={model.started} />
      {over ? <Stat label="Planned" value={model.planned} tone="muted" /> : <Stat label="Cue ends" value={model.cueEnds} />}
      {model.schedule ? <Stat label="Schedule" value={model.schedule} tone={model.scheduleTone} /> : null}
    </div>
    {over && model.overtimeNote ? <p className="rounded-lg border border-[var(--sa-danger)]/25 bg-[var(--sa-danger)]/[0.08] px-4 py-3 text-[13px] leading-[1.55] text-board-text">{model.overtimeNote}</p> : null}
    {model.next ? <p className="flex min-w-0 items-center gap-2.5 border-t border-[var(--sa-border)] pt-4 text-[13px]">
      <span className={label}>Up next</span>
      <span className="truncate text-board-text">{model.next.title || "Untitled"} · <span className="tabular-nums text-[var(--sa-ink-3)]">{minutesClock(model.next.duration)}</span></span>
    </p> : null}
  </section>;
}

// ─── Rundown card ────────────────────────────────────────────

export function RundownCard({ items, plan, currentId, nextId, timeZone, hour12, running }: {
  items: RundownItem[];
  plan: ShowPlan;
  currentId: string | null;
  nextId: string | null;
  timeZone: string;
  hour12: boolean;
  /** "running 2:10 behind" when the show is under way. */
  running: { label: string; tone: "default" | "warn" } | null;
}) {
  const range = plan.plannedStart !== null ? `${dayTime(plan.plannedStart, timeZone, hour12)} → ${dayTime(plan.plannedEnd, timeZone, hour12)}` : null;
  return <section aria-label="Rundown" className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-[var(--sa-border)] bg-[var(--sa-surface)]">
    <div className="flex shrink-0 flex-col gap-[3px] px-4 pb-3 pt-3.5">
      <div className="flex items-baseline justify-between gap-2.5">
        <h2 className="text-[13px] font-semibold text-board-text">Rundown</h2>
        <span className="tabular-nums text-xs text-[var(--sa-ink-3)]">{plan.cues.length} {plan.cues.length === 1 ? "cue" : "cues"} · {hoursClock(plan.runtime)}</span>
      </div>
      <p className="text-xs text-[var(--sa-ink-3)]">
        {running
          ? <>{range ? `Planned ${range} · ` : ""}running <span className={running.tone === "warn" ? "text-[var(--sa-warn)]" : "text-[var(--sa-ink-2)]"}>{running.label}</span></>
          : range ? `${range} · start times computed from durations` : "Set a start time on the show to see when each cue begins."}
      </p>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto">
      {items.map(item => {
        if (item.type === "header") {
          const section = plan.sections.get(item.id);
          return <div key={item.id} className="flex h-9 items-center gap-2.5 bg-board-bg px-4 shadow-[inset_0_1px_0_var(--sa-border),inset_0_-1px_0_var(--sa-border)]">
            <span className="truncate text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--sa-ink-2)]">{item.title || "Section"}</span>
            {section?.start != null && section.duration > 0 ? <span className="whitespace-nowrap tabular-nums text-[11px] text-[var(--sa-ink-3)]">{dayTime(section.start, timeZone, hour12)}–{dayTime(section.start + section.duration, timeZone, hour12)}</span> : null}
            <span className="ml-auto tabular-nums text-[11px] text-[var(--sa-ink-3)]">{minutesClock(section?.duration ?? 0)}</span>
          </div>;
        }
        const state = item.id === currentId ? "live" : item.status === "complete" ? "done" : item.id === nextId ? "next" : "upcoming";
        return <div key={item.id} aria-current={state === "live" ? "step" : undefined}
          className={`grid min-h-12 grid-cols-[14px_40px_minmax(0,1fr)_auto_48px] items-center gap-x-3 px-4 py-1.5 ${state === "live" ? "bg-fire-500/10 shadow-[inset_0_1px_0_var(--sa-border),inset_2px_0_0_var(--color-fire-500)]" : "shadow-[inset_0_1px_0_var(--sa-border)] hover:bg-[var(--sa-surface-2)]"}`}>
          <span aria-hidden="true" className="flex h-3.5 w-3.5 items-center justify-center">
            {state === "done" ? <Check className="h-3 w-3 text-[var(--sa-ink-3)]" strokeWidth={2} />
              : <span className={`h-[7px] w-[7px] rounded-full ${state === "live" ? "bg-fire-500 shadow-[0_0_0_3px_rgba(255,194,26,0.2)]" : state === "next" ? "shadow-[inset_0_0_0_1.5px_var(--board-text)]" : "bg-[var(--sa-border-strong)]"}`} />}
          </span>
          <span className={`tabular-nums text-xs ${state === "live" ? "text-board-text" : state === "done" ? "text-[var(--sa-ink-3)] opacity-80" : "text-[var(--sa-ink-2)]"}`}>{dayTime(plan.starts.get(item.id) ?? null, timeZone, hour12)}</span>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className={`truncate text-[13px] ${state === "live" ? "font-semibold text-board-text" : state === "done" ? "font-normal text-[var(--sa-ink-3)]" : "font-medium text-board-text"}`}>{item.title || "Untitled"}</span>
            {item.assignee ? <span className={`truncate text-xs text-[var(--sa-ink-3)] ${state === "done" ? "opacity-80" : ""}`}>{item.assignee}</span> : null}
          </span>
          <span className={`inline-flex h-5 items-center rounded-full border px-[7px] text-[11px] font-medium ${state === "live" ? "border-fire-500/40 text-fire-500" : state === "next" ? "border-[var(--sa-border-strong)] text-[var(--sa-ink-2)]" : "invisible border-transparent"}`}>{state === "live" ? "Now" : "Next"}</span>
          <span className={`text-right tabular-nums text-xs ${state === "live" ? "text-board-text" : state === "done" ? "text-[var(--sa-ink-3)] opacity-80" : "text-[var(--sa-ink-2)]"}`}>{minutesClock(item.duration)}</span>
        </div>;
      })}
    </div>
  </section>;
}

// ─── States ──────────────────────────────────────────────────

export function NoRundownCard({ slug }: { slug: string }) {
  return <section className="flex flex-col items-start gap-4 rounded-2xl border border-dashed border-[var(--sa-border-strong)] p-8">
    <span className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-[var(--sa-surface-2)] text-[var(--sa-ink-2)]"><List className="h-5 w-5" strokeWidth={1.5} /></span>
    <div className="flex max-w-[440px] flex-col gap-2">
      <h2 className="text-base font-semibold tracking-[-0.01em] text-board-text">No rundown on this show yet</h2>
      <p className="text-[13px] leading-[1.6] text-[var(--sa-ink-2)]">Attach a rundown to run the show from here. The timer, the cue list and the crew's view all follow it.</p>
    </div>
    <div className="flex flex-wrap gap-2 pt-1">
      <Link to="/$slug/rundown" params={{ slug }} className="flex h-8 items-center gap-1.5 rounded-lg bg-fire-500 px-3 text-[13px] font-semibold text-[#1a1300] hover:bg-fire-400"><Link2 className="h-3.5 w-3.5" strokeWidth={2} />Attach rundown</Link>
      <Link to="/$slug/rundown" params={{ slug }} className="flex h-8 items-center gap-1.5 rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface-2)] px-3 text-[13px] font-medium text-board-text hover:bg-[var(--sa-surface-3)]"><LayoutTemplate className="h-3.5 w-3.5" strokeWidth={1.5} />Create from template</Link>
    </div>
  </section>;
}

export function OfflineBanner({ onRetry }: { onRetry: () => void }) {
  return <div role="alert" className="flex items-start gap-3 rounded-xl border border-[var(--sa-border-strong)] bg-[var(--sa-surface)] px-4 py-3.5">
    <WifiOff className="mt-0.5 h-4 w-4 shrink-0 text-[var(--sa-warn)]" strokeWidth={1.75} />
    <div className="min-w-0 flex-1">
      <p className="text-[13px] font-semibold text-board-text">You're offline. Reconnecting…</p>
      <p className="mt-1 text-[13px] leading-[1.5] text-[var(--sa-ink-2)]">The timer on this screen may lag until you're back. Messages you send will go out when you reconnect.</p>
    </div>
    <button type="button" onClick={onRetry} className="inline-flex h-7 shrink-0 items-center rounded-md border border-[var(--sa-border-strong)] bg-[var(--sa-surface-2)] px-2.5 text-xs font-medium text-board-text hover:bg-[var(--sa-surface-3)]">Retry now</button>
  </div>;
}

// ─── Layout menu thumbnails ──────────────────────────────────

export function LayoutThumb({ shape, active }: { shape: "balanced" | "show-focus" | "chat-focus" | "rundown-focus" | "custom"; active?: boolean }) {
  const box = "rounded-[3px] bg-[var(--sa-surface-3)]";
  const hi = "rounded-[3px] bg-[#9a9aa6]";
  const cells = {
    balanced: <><span className={`${box} col-start-1 row-start-1`} /><span className={`${box} col-start-1 row-start-2`} /><span className={`${box} col-start-2 row-span-2`} /></>,
    custom: <><span className={`${box} col-start-1 row-start-1`} /><span className={`${box} col-start-1 row-start-2`} /><span className={`${box} col-start-2 row-span-2`} /></>,
    "show-focus": <><span className={`${hi} col-span-2 row-start-1`} /><span className={`${box} col-start-1 row-start-2`} /><span className={`${box} col-start-2 row-start-2`} /></>,
    "chat-focus": <><span className={`${box} col-start-1 row-start-1`} /><span className={`${hi} col-start-1 row-start-2`} /><span className={`${box} col-start-2 row-span-2`} /></>,
    "rundown-focus": <><span className={`${box} col-start-1 row-start-1`} /><span className={`${box} col-start-1 row-start-2`} /><span className={`${hi} col-start-2 row-span-2`} /></>,
  }[shape];
  const grid = shape === "show-focus" ? "grid-cols-2 grid-rows-[3fr_1.4fr]" : shape === "chat-focus" ? "grid-cols-[1.6fr_1fr] grid-rows-[1fr_3fr]" : shape === "rundown-focus" ? "grid-cols-[1fr_2.4fr] grid-rows-2" : "grid-cols-2 grid-rows-2";
  return <span aria-hidden="true" className={`grid h-11 w-16 shrink-0 gap-1 rounded-md border bg-board-bg p-1 ${grid} ${active ? "border-fire-500" : "border-[var(--sa-border-strong)]"}`}>{cells}</span>;
}
