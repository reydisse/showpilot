/**
 * Production manager widgets.
 *
 * Every widget here answers "what would the PM do in the next ten
 * minutes?" A widget that can only report a healthy count is not in
 * this file.
 *
 * Region assignment is deliberate: the wide column carries the things
 * you read and act on, the rail carries the things you glance at.
 */

import { Link } from "@tanstack/react-router";
import { Clapperboard, Radio } from "lucide-react";
import {
  HealthChip,
  SeverityDot,
  StatusDot,
  WidgetAction,
  WidgetCard,
  WidgetEmpty,
  WidgetLabel,
  WidgetMetric,
  healthTextClass,
  type WidgetDefinition,
} from "./widget";
import { formatDuration } from "@/lib/rundown-timing";
import type { AttentionItem, PmDashboardModel } from "@/lib/pm-dashboard-derive";

export interface PmWidgetModel {
  model: PmDashboardModel;
  slug: string;
}

type PmWidget = WidgetDefinition<PmWidgetModel>;

/** Sidebar's pattern for building an org-relative typed link target. */
function orgLink(slug: string, path: string) {
  return `/${slug}/${path}` as unknown as Parameters<typeof Link>[0]["to"];
}

function timeOfDay(ms: number | null): string {
  if (ms === null) return "--:--";
  return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function longDate(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

// ─── Attention queue ─────────────────────────────────────────

function AttentionRow({ item, slug }: { item: AttentionItem; slug: string }) {
  return (
    <li
      className={`flex items-center gap-3 py-2 border-t border-board-border/60 first:border-t-0 ${
        item.severity === "critical" ? "-ml-4 pl-[13px] border-l-2 border-l-red-500/70" : ""
      }`}
    >
      <SeverityDot severity={item.severity} />
      <div className="flex-1 min-w-0">
        <p className="text-[13px] leading-snug text-board-text truncate">{item.title}</p>
        <p className="text-[11px] leading-snug text-board-muted truncate">{item.detail}</p>
      </div>
      {item.actionPath && (
        <Link to={orgLink(slug, item.actionPath)} className="shrink-0">
          <WidgetAction>{item.actionLabel}</WidgetAction>
        </Link>
      )}
    </li>
  );
}

const attentionWidget: PmWidget = {
  id: "attention",
  title: "Needs attention",
  phases: "all",
  region: "main",
  render: ({ model, slug }) => (
    <WidgetCard
      title="Needs attention"
      action={
        <span className="text-[11px] tabular-nums text-board-muted">
          {model.attention.length}
        </span>
      }
    >
      {model.attention.length === 0 ? (
        <WidgetEmpty>Nothing outstanding. This service is clear.</WidgetEmpty>
      ) : (
        <ul>
          {model.attention.slice(0, 8).map((item) => (
            <AttentionRow key={item.id} item={item} slug={slug} />
          ))}
        </ul>
      )}
    </WidgetCard>
  ),
};

// ─── Rundown health ──────────────────────────────────────────

const rundownHealthWidget: PmWidget = {
  id: "rundown-health",
  title: "Rundown",
  phases: "all",
  region: "main",
  // With no rundown there is no health to report, and the plan-next
  // widget already makes the ask. One message, one place.
  isRelevant: ({ model }) => model.rundownHealth.itemCount > 0,
  render: ({ model, slug }) => {
    const health = model.rundownHealth;
    // No configured window means no verdict. Show the runtime and let
    // the PM judge it; inventing a target and grading against it is
    // worse than saying nothing.
    const judged = health.windowMs !== null && health.deltaMs !== null;
    const delta = health.deltaMs ?? 0;
    const over = judged && delta > 0;

    return (
      <WidgetCard
        title="Rundown"
        action={
          <Link to={orgLink(slug, "rundown")}>
            <WidgetAction>Open</WidgetAction>
          </Link>
        }
      >
        <div className="flex flex-wrap items-start gap-x-10 gap-y-4">
          <div>
            {judged ? (
              <WidgetMetric
                value={`${over ? "+" : ""}${formatDuration(delta)}`}
                unit={over ? "over window" : "under window"}
                tone={over ? "fail" : "ok"}
              />
            ) : (
              <WidgetMetric
                value={formatDuration(health.plannedMs, true)}
                unit="planned runtime"
              />
            )}
            <p className="text-[11px] text-board-muted mt-1.5">
              {judged
                ? `Planned ${formatDuration(health.plannedMs, true)} · window ${formatDuration(health.windowMs as number, true)}`
                : "No service length set, so nothing to compare against"}
            </p>
          </div>

          <dl className="flex items-start gap-8">
            <HealthStat label="No duration" value={health.missingDuration} tone="fail" />
            <HealthStat label="No owner" value={health.missingOwner} tone="warn" />
            <HealthStat label="Hard stops" value={health.hardStopConflicts} tone="fail" />
            <HealthStat label="Items" value={health.itemCount} tone="ok" neutral />
          </dl>
        </div>
      </WidgetCard>
    );
  },
};

function HealthStat({
  label,
  value,
  tone,
  neutral = false,
}: {
  label: string;
  value: number;
  tone: "ok" | "warn" | "fail";
  neutral?: boolean;
}) {
  const highlight = !neutral && value > 0;
  return (
    <div>
      <dd
        className={`text-lg leading-none font-semibold tabular-nums ${
          highlight ? healthTextClass(tone) : "text-board-text"
        }`}
      >
        {value}
      </dd>
      <dt className="text-[10px] uppercase tracking-[0.12em] text-board-muted mt-1.5">{label}</dt>
    </div>
  );
}

// ─── Readiness ───────────────────────────────────────────────

const readinessWidget: PmWidget = {
  id: "readiness",
  title: "Readiness",
  phases: "all",
  region: "rail",
  render: ({ model }) => (
    <WidgetCard
      title="Readiness"
      action={
        <span className={`text-[11px] tabular-nums ${healthTextClass(model.readiness.status)}`}>
          {model.readiness.score}%
        </span>
      }
    >
      <ul className="space-y-2">
        {model.readiness.factors.map((factor) => (
          <li key={factor.id} className="flex items-baseline gap-2.5">
            <StatusDot status={factor.status} className="translate-y-[-1px]" />
            <span className="text-xs text-board-text w-[70px] shrink-0">{factor.label}</span>
            <span className="text-[11px] text-board-muted truncate">{factor.detail}</span>
          </li>
        ))}
      </ul>
    </WidgetCard>
  ),
};

// ─── Department strip ────────────────────────────────────────

const departmentsWidget: PmWidget = {
  id: "departments",
  title: "Departments",
  phases: "all",
  region: "banner",
  render: ({ model }) => (
    <div className="rounded-lg border border-board-border/70 bg-board-card px-4 py-2.5 flex items-center flex-wrap gap-x-7 gap-y-2">
      <WidgetLabel>Departments</WidgetLabel>
      {model.departments.map((dept) => (
        <span key={dept.key} className="flex items-baseline gap-2 min-w-0">
          <StatusDot status={dept.status} className="translate-y-[-1px]" />
          <span className="text-xs text-board-text">{dept.label}</span>
          <span className="text-[11px] text-board-muted truncate max-w-[190px]">
            {dept.detail}
          </span>
        </span>
      ))}
    </div>
  ),
};

// ─── Arrivals ────────────────────────────────────────────────

const arrivalsWidget: PmWidget = {
  id: "arrivals",
  title: "Arrivals",
  phases: ["call", "live"],
  region: "rail",
  isRelevant: ({ model }) => model.arrivals.total > 0,
  render: ({ model, slug }) => (
    <WidgetCard
      title="Arrivals"
      action={
        <Link to={orgLink(slug, "checkin")}>
          <WidgetAction>Check-in</WidgetAction>
        </Link>
      }
    >
      <WidgetMetric
        value={`${model.arrivals.present}`}
        unit={`of ${model.arrivals.total} on site`}
      />
      <ul className="space-y-1.5 mt-3">
        {model.arrivals.departments.map((dept) => (
          <li key={dept.key} className="flex items-center gap-2 text-xs">
            <StatusDot
              status={dept.alarm ? "fail" : dept.present < dept.total ? "warn" : "ok"}
            />
            <span className="text-board-text flex-1 truncate">{dept.label}</span>
            {dept.alarm && (
              <span className="text-[10px] uppercase tracking-wide text-red-400">No-show</span>
            )}
            <span className="tabular-nums text-board-muted">
              {dept.present}/{dept.total}
            </span>
          </li>
        ))}
      </ul>
    </WidgetCard>
  ),
};

// ─── Cue exceptions ──────────────────────────────────────────

const cueExceptionsWidget: PmWidget = {
  id: "cue-exceptions",
  title: "Cue sheet",
  phases: ["planning", "prep", "call"],
  region: "main",
  isRelevant: ({ model }) => model.cueExceptions.length > 0,
  render: ({ model, slug }) => (
    <WidgetCard title="Cue sheet">
      <ul>
        {model.cueExceptions.map((item) => (
          <AttentionRow key={item.id} item={item} slug={slug} />
        ))}
      </ul>
    </WidgetCard>
  ),
};

// ─── Week ahead ──────────────────────────────────────────────

const weekAheadWidget: PmWidget = {
  id: "week-ahead",
  title: "Week ahead",
  phases: ["planning", "prep", "debrief"],
  region: "rail",
  isRelevant: ({ model }) => model.upcoming.length > 0,
  render: ({ model }) => (
    <WidgetCard title="Week ahead">
      <ul className="space-y-2">
        {model.upcoming.map((service) => (
          <li key={service.serviceDate} className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs text-board-text">
                {new Date(`${service.serviceDate}T12:00:00`).toLocaleDateString("en-US", {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                })}
              </p>
              <p className="text-[10px] text-board-muted truncate">
                {service.itemCount} {service.itemCount === 1 ? "item" : "items"}
                {service.scheduledStartTime ? "" : " · no start time"}
              </p>
            </div>
            <HealthChip status={service.status} label={`${service.readiness}%`} />
          </li>
        ))}
      </ul>
    </WidgetCard>
  ),
};

// ─── Live strip ──────────────────────────────────────────────

const liveStripWidget: PmWidget = {
  id: "live-strip",
  title: "On air",
  phases: ["live"],
  region: "banner",
  render: ({ model, slug }) => {
    const health = model.rundownHealth;
    const behind = (health.driftMs ?? 0) > 0;
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 flex flex-wrap items-center gap-x-10 gap-y-3">
        <span className="flex items-center gap-2">
          <Radio className="w-3.5 h-3.5 text-red-400" />
          <WidgetLabel>On air</WidgetLabel>
        </span>
        <div>
          <p className="text-[10px] uppercase tracking-[0.12em] text-board-muted">Drift</p>
          <p
            className={`text-lg leading-none font-semibold tabular-nums mt-1 ${
              behind ? "text-red-400" : "text-green-400"
            }`}
          >
            {health.driftMs === null
              ? "--:--"
              : `${behind ? "+" : ""}${formatDuration(health.driftMs)}`}
          </p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-[0.12em] text-board-muted">Projected end</p>
          <p className="text-lg leading-none font-semibold tabular-nums text-board-text mt-1">
            {timeOfDay(health.projectedEndMs)}
          </p>
        </div>
        <Link to={orgLink(slug, "show")} className="ml-auto">
          <WidgetAction>Open show</WidgetAction>
        </Link>
      </div>
    );
  },
};

// ─── Debrief ─────────────────────────────────────────────────

const debriefWidget: PmWidget = {
  id: "debrief",
  title: "Debrief",
  phases: ["debrief"],
  region: "main",
  isRelevant: ({ model }) => model.debrief !== null,
  render: ({ model, slug }) => {
    const debrief = model.debrief;
    if (!debrief) return null;
    const over = (debrief.deltaMs ?? 0) > 0;
    return (
      <WidgetCard
        title="Debrief"
        action={
          <Link to={orgLink(slug, "production/incidents")}>
            <WidgetAction>Log an incident</WidgetAction>
          </Link>
        }
      >
        <div className="flex flex-wrap gap-x-10 gap-y-3">
          <DebriefStat label="Planned" value={formatDuration(debrief.plannedMs, true)} />
          <DebriefStat
            label="Actual"
            value={debrief.actualMs === null ? "--:--" : formatDuration(debrief.actualMs, true)}
          />
          <DebriefStat
            label="Delta"
            value={
              debrief.deltaMs === null
                ? "--:--"
                : `${over ? "+" : ""}${formatDuration(debrief.deltaMs)}`
            }
            tone={over ? "fail" : "ok"}
          />
          <DebriefStat label="Incidents" value={`${debrief.incidentCount}`} />
        </div>

        {debrief.worstOverruns.length > 0 && (
          <ul className="mt-4 pt-3 border-t border-board-border/60 space-y-1.5">
            {debrief.worstOverruns.map((item) => (
              <li key={item.id} className="flex items-center justify-between text-xs">
                <span className="text-board-text truncate">{item.title}</span>
                <span className="tabular-nums text-red-400 shrink-0 ml-3">
                  +{formatDuration(item.overrunMs)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </WidgetCard>
    );
  },
};

function DebriefStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "ok" | "fail";
}) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-[0.12em] text-board-muted">{label}</p>
      <p
        className={`text-lg leading-none font-semibold tabular-nums mt-1 ${
          tone ? healthTextClass(tone) : "text-board-text"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

// ─── Plan next ───────────────────────────────────────────────

const planNextWidget: PmWidget = {
  id: "plan-next",
  title: "Plan the next service",
  phases: ["planning", "prep"],
  region: "main",
  isRelevant: ({ model }) => model.planNext,
  render: ({ model, slug }) => (
    <WidgetCard title="Plan the next service">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[15px] text-board-text">
            Nothing scheduled for {longDate(model.serviceDate)}
          </p>
          <p className="text-xs text-board-muted mt-1">
            {model.lastServiceDate
              ? `Last service was ${longDate(model.lastServiceDate)} — open it from the date picker to copy its rundown.`
              : "Build a rundown to get the dashboard working for you."}
          </p>
        </div>
        <Link
          to={orgLink(slug, "rundown")}
          className="inline-flex items-center gap-2 shrink-0 text-xs px-3 py-2 rounded-lg bg-fire-500/15 border border-fire-500/30 text-fire-400 hover:bg-fire-500/25 transition-colors"
        >
          <Clapperboard className="w-3.5 h-3.5" />
          Build the rundown
        </Link>
      </div>
    </WidgetCard>
  ),
};

// ─── Registry ────────────────────────────────────────────────

export const PM_WIDGETS: PmWidget[] = [
  liveStripWidget,
  departmentsWidget,
  planNextWidget,
  attentionWidget,
  rundownHealthWidget,
  debriefWidget,
  cueExceptionsWidget,
  readinessWidget,
  arrivalsWidget,
  weekAheadWidget,
];
