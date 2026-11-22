import type React from "react";

/**
 * Incidents — A (Doop canvas aneicgaHqk, "Incidents" page): shared pieces for
 * the log, history and detail views. Colours come from the `.schedule-a` palette.
 */

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

const severityTone: Record<Severity, { lit: number; colour: string }> = {
  low: { lit: 1, colour: "bg-[var(--sa-ink-2)]" },
  medium: { lit: 2, colour: "bg-[var(--sa-warn)]" },
  high: { lit: 3, colour: "bg-[var(--sa-danger)]" },
  critical: { lit: 3, colour: "bg-[var(--sa-danger)]" },
};

export function asSeverity(value: string): Severity {
  return (SEVERITIES as readonly string[]).includes(value) ? (value as Severity) : "medium";
}

export function severityLabel(value: string) {
  const severity = asSeverity(value);
  return severity[0].toUpperCase() + severity.slice(1);
}

/** Three rising bars; how many are lit and their colour carry the severity, the label says it in words. */
export function SeverityBars({ severity, className = "" }: { severity: string; className?: string }) {
  const tone = severityTone[asSeverity(severity)];
  return <span aria-hidden="true" className={`inline-flex h-3 items-end gap-[2px] ${className}`}>
    {[5, 8, 11].map((height, index) => <span key={height} className={`w-[3px] rounded-[1px] ${index < tone.lit ? tone.colour : "bg-[var(--sa-border-strong)]"}`} style={{ height }} />)}
  </span>;
}

export function StatusLabel({ status }: { status: string }) {
  const resolved = status === "resolved";
  return <span className="inline-flex items-center gap-2 whitespace-nowrap text-[13px] text-[var(--sa-ink-2)]">
    <span aria-hidden="true" className={`h-[7px] w-[7px] shrink-0 rounded-full ${resolved ? "bg-[var(--sa-ok)]" : "bg-[var(--sa-warn)]"}`} />
    {resolved ? "Resolved" : "Open"}
  </span>;
}

export function initialsOf(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase() ?? "").join("") || "?";
}

export function PersonAvatar({ name, size = 28 }: { name: string | null; size?: number }) {
  return name
    ? <span aria-hidden="true" style={{ width: size, height: size }} className="flex shrink-0 items-center justify-center rounded-full bg-[var(--sa-surface-3)] text-[11px] font-semibold tracking-[0.02em] text-[var(--sa-ink-2)]">{initialsOf(name)}</span>
    : <span aria-hidden="true" style={{ width: size, height: size }} className="shrink-0 rounded-full border-[1.5px] border-dashed border-[var(--sa-border-strong)]" />;
}

/** The first line of a report is its title in the log; the rest is detail. */
export function splitDescription(description: string) {
  const [first = "", ...rest] = description.trim().split("\n");
  return { title: first.trim() || "Untitled incident", body: rest.join("\n").trim() };
}

export function dayMonth(date: Date, timeZone: string) {
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone });
}

export function clockTime(date: Date, timeZone: string) {
  return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone });
}

export function longDate(date: Date, timeZone: string) {
  const part = (options: Intl.DateTimeFormatOptions) => date.toLocaleDateString("en-GB", { ...options, timeZone });
  return `${part({ weekday: "short" })} ${part({ day: "numeric" })} ${part({ month: "short" })} ${part({ year: "numeric" })}`;
}

export const card = "rounded-xl border border-[var(--sa-border)] bg-[var(--sa-surface)]";
export const secondaryButton = "inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg max-lg:h-11 border border-[var(--sa-border-strong)] bg-[var(--sa-surface-2)] px-3 text-[13px] font-medium text-board-text hover:bg-[var(--sa-surface-3)] disabled:opacity-40";
export const primaryButton = "inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg max-lg:h-11 bg-fire-500 px-3 text-[13px] font-semibold text-[#1a1300] hover:bg-fire-400 disabled:opacity-40";
export const ghostButton = "inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg max-lg:h-11 px-3 text-[13px] font-medium text-[var(--sa-ink-2)] hover:bg-[var(--sa-surface-2)] hover:text-board-text disabled:opacity-40";

export function SectionCard({ title, count, action, children, className = "" }: { title: string; count?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return <section className={`${card} ${className}`}>
    <header className="flex min-h-12 items-center justify-between gap-3 border-b border-[var(--sa-border)] px-4">
      <h2 className="text-[13px] font-semibold text-board-text">{title}{count !== undefined ? <span className="ml-2 font-normal tabular-nums text-[var(--sa-ink-3)]">{count}</span> : null}</h2>
      {action}
    </header>
    {children}
  </section>;
}

/** Severity picker: a segmented control with the same bars as the rows. */
export function SeverityPicker({ value, onChange, disabled, compact = false }: { value: string; onChange: (value: Severity) => void; disabled?: boolean; compact?: boolean }) {
  return <div role="radiogroup" aria-label="Severity" className={`grid gap-1 rounded-lg border border-[var(--sa-border)] bg-board-bg p-1 ${compact ? "grid-cols-2" : "grid-cols-4"}`}>
    {SEVERITIES.map(severity => {
      const active = asSeverity(value) === severity;
      return <button key={severity} type="button" role="radio" aria-checked={active} disabled={disabled} onClick={() => onChange(severity)}
        className={`inline-flex h-8 items-center justify-center gap-2 whitespace-nowrap rounded-md text-[13px] max-lg:h-11 disabled:opacity-50 ${active ? "bg-[var(--sa-surface-3)] font-medium text-board-text shadow-[inset_0_0_0_1px_var(--sa-border-strong)]" : "text-[var(--sa-ink-2)] hover:text-board-text"}`}>
        <SeverityBars severity={severity} />{severityLabel(severity)}
      </button>;
    })}
  </div>;
}
