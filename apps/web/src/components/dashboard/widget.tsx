/**
 * Role dashboard widget contract.
 *
 * Role dashboards (production manager, tech manager, and whatever comes
 * after) share one shell, one phase model, and one set of primitives.
 * A dashboard is a registry of widgets plus a layout — not a bespoke
 * page — so a widget written for one role can be listed by another
 * without being rebuilt.
 *
 * Layout is by REGION, not by column span. Spans let widgets land in
 * ragged rows with dead space beside them; regions cannot. A widget is
 * either a full-width banner, a card in the wide reading column, or a
 * compact card in the fixed right rail.
 */

import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { ServicePhase } from "@/lib/service-phase";
import type { Health, Severity } from "@/lib/pm-dashboard-derive";

export type WidgetRegion = "banner" | "main" | "rail";

export interface WidgetDefinition<TModel> {
  id: string;
  title: string;
  /** Phases this widget appears in. "all" means every phase. */
  phases: ServicePhase[] | "all";
  region: WidgetRegion;
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

export function widgetsInRegion<TModel>(
  widgets: WidgetDefinition<TModel>[],
  region: WidgetRegion,
): WidgetDefinition<TModel>[] {
  return widgets.filter((widget) => widget.region === region);
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

/**
 * One card treatment, deliberately quiet. Operators scan these under
 * pressure; the border is a container hint, not decoration, so it stays
 * out of the way and lets the numbers lead.
 */
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
      className={cn(
        "rounded-lg border border-board-border/70 bg-board-card px-4 py-3.5",
        className,
      )}
    >
      {(title || action) && (
        <div className="flex items-center justify-between gap-3 mb-3">
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
    <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-board-muted">
      {children}
    </span>
  );
}

/** The one big number a card is built around. */
export function WidgetMetric({
  value,
  unit,
  tone = "neutral",
}: {
  value: string;
  unit?: string;
  tone?: "neutral" | Health;
}) {
  const toneClass =
    tone === "neutral" ? "text-board-text" : healthTextClass(tone as Health);
  return (
    <div className="flex items-baseline gap-2">
      <span className={cn("text-[26px] leading-none font-semibold tabular-nums", toneClass)}>
        {value}
      </span>
      {unit && <span className="text-xs text-board-muted">{unit}</span>}
    </div>
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
  info: "bg-board-muted",
};

/**
 * State is never colour alone (UI rule 2) — every caller pairs the dot
 * with a text label, and criticals additionally carry a left rule.
 */
export function StatusDot({ status, className }: { status: Health; className?: string }) {
  return (
    <span
      className={cn("w-1.5 h-1.5 rounded-full shrink-0", HEALTH_DOT[status], className)}
      aria-hidden="true"
    />
  );
}

export function SeverityDot({ severity }: { severity: Severity }) {
  return (
    <span
      className={cn("w-1.5 h-1.5 rounded-full shrink-0", SEVERITY_DOT[severity])}
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
  ok: "text-green-400 bg-green-500/10",
  warn: "text-yellow-300 bg-yellow-400/10",
  fail: "text-red-400 bg-red-500/10",
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
        "inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium tabular-nums",
        HEALTH_CHIP[status],
        className,
      )}
    >
      {label}
    </span>
  );
}

/** Small bordered action, used for every in-card affordance. */
export function WidgetAction({ children }: { children: ReactNode }) {
  return (
    <span className="text-[11px] px-2 py-1 rounded border border-board-border/80 text-board-muted hover:text-board-text hover:border-board-border transition-colors">
      {children}
    </span>
  );
}

export function WidgetEmpty({ children }: { children: ReactNode }) {
  return <p className="text-xs text-board-muted/70 py-2">{children}</p>;
}
