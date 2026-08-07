/**
 * Role dashboard widget contract.
 *
 * Role dashboards (production manager, tech manager, and whatever comes
 * after) share one shell, one phase model, and one set of primitives.
 * A dashboard is a registry of widgets plus a layout — not a bespoke
 * page — so a widget written for one role can be listed by another
 * without being rebuilt.
 */

import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { ServicePhase } from "@/lib/service-phase";
import type { Health, Severity } from "@/lib/pm-dashboard-derive";

export type WidgetSpan = "full" | "half" | "two-thirds" | "third";

export interface WidgetDefinition<TModel> {
  id: string;
  title: string;
  /** Phases this widget appears in. "all" means every phase. */
  phases: ServicePhase[] | "all";
  span: WidgetSpan;
  /**
   * Suppress the widget when it has nothing to say. Broadcast rule 1:
   * no mystery states, and no cards that exist only to show a zero.
   */
  isRelevant?(model: TModel): boolean;
  render(model: TModel): ReactNode;
}

export function selectWidgets<TModel>(
  definitions: WidgetDefinition<TModel>[],
  phase: ServicePhase,
  model: TModel,
): WidgetDefinition<TModel>[] {
  return definitions.filter((widget) => {
    const phaseMatch = widget.phases === "all" || widget.phases.includes(phase);
    if (!phaseMatch) return false;
    return widget.isRelevant ? widget.isRelevant(model) : true;
  });
}

const SPAN_CLASS: Record<WidgetSpan, string> = {
  full: "lg:col-span-6",
  "two-thirds": "lg:col-span-4",
  half: "lg:col-span-3",
  third: "lg:col-span-2",
};

export function widgetSpanClass(span: WidgetSpan): string {
  return SPAN_CLASS[span];
}

// ─── Ticking clock ───────────────────────────────────────────

/**
 * A shared clock so countdowns tick without every widget owning a
 * timer. Defaults to one second; planning views can pass something
 * lazier.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

// ─── Primitives ──────────────────────────────────────────────

export function WidgetCard({
  title,
  action,
  children,
  className,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn("rounded-xl border bg-board-card border-board-border p-5", className)}
    >
      {(title || action) && (
        <div className="flex items-center justify-between mb-4">
          {title ? <WidgetLabel>{title}</WidgetLabel> : <span />}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function WidgetLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-[10px] font-medium uppercase tracking-widest text-board-muted">
      {children}
    </span>
  );
}

const HEALTH_DOT: Record<Health, string> = {
  ok: "bg-green-500",
  warn: "bg-yellow-400",
  fail: "bg-red-500",
};

const SEVERITY_DOT: Record<Severity, string> = {
  critical: "bg-red-500",
  warning: "bg-yellow-400",
  info: "bg-blue-400",
};

/**
 * State is never colour alone (UI rule 2) — the dot carries a shape
 * cue via size and every caller pairs it with a text label.
 */
export function StatusDot({ status, className }: { status: Health; className?: string }) {
  return (
    <span
      className={cn("w-2 h-2 rounded-full shrink-0", HEALTH_DOT[status], className)}
      aria-hidden="true"
    />
  );
}

export function SeverityDot({ severity }: { severity: Severity }) {
  return (
    <span
      className={cn("w-2 h-2 rounded-full shrink-0", SEVERITY_DOT[severity])}
      aria-hidden="true"
    />
  );
}

const HEALTH_TEXT: Record<Health, string> = {
  ok: "text-green-400",
  warn: "text-yellow-400",
  fail: "text-red-400",
};

export function healthTextClass(status: Health): string {
  return HEALTH_TEXT[status];
}

const HEALTH_CHIP: Record<Health, string> = {
  ok: "bg-green-500/10 text-green-400 border-green-500/20",
  warn: "bg-yellow-400/10 text-yellow-300 border-yellow-400/20",
  fail: "bg-red-500/10 text-red-400 border-red-500/20",
};

export function HealthChip({
  status,
  label,
  className,
}: {
  status: Health;
  label: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg border text-[11px] font-medium",
        HEALTH_CHIP[status],
        className,
      )}
    >
      {label}
    </span>
  );
}

/** Empty state for a widget that is relevant but has no data yet. */
export function WidgetEmpty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-board-muted/60 text-center py-6">{children}</p>;
}
