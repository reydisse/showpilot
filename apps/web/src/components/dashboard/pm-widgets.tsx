/**
 * Production manager widgets.
 *
 * Every widget here answers "what would the PM do in the next ten
 * minutes?" A widget that can only report a healthy count is not in
 * this file.
 */

import { Link } from "@tanstack/react-router";
import { Clapperboard, Radio } from "lucide-react";
import {
  HealthChip,
  SeverityDot,
  StatusDot,
  WidgetCard,
  WidgetEmpty,
  WidgetLabel,
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

// ─── Attention queue ─────────────────────────────────────────

function AttentionRow({ item, slug }: { item: AttentionItem; slug: string }) {
  return (
    <li className="flex items-start gap-3 py-2.5 border-t border-board-border first:border-t-0">
      <span className="pt-1.5">
        <SeverityDot severity={item.severity} />
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-board-text">{item.title}</p>
        <p className="text-[11px] text-board-muted mt-0.5">{item.detail}</p>
      </div>
      {item.actionPath && (
        <Link
          to={orgLink(slug, item.actionPath)}
          className="shrink-0 text-[11px] px-2.5 py-1 rounded-lg border border-board-border text-board-text hover:bg-board-bg transition-colors"
        >
          {item.actionLabel}
        </Link>
      )}
    </li>
  );
}

const attentionWidget: PmWidget = {
  id: "attention",
  title: "Needs attention",
  phases: "all",
  span: "two-thirds",
  render: ({ model, slug }) => (
    <WidgetCard
      title="Needs attention"
      action={
        <span className="text-xs tabular-nums text-board-muted">
          {model.attention.length} {model.attention.length === 1 ? "item" : "items"}
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
  title: "Rundown health",
  phases: "all",
  span: "half",
  render: ({ model, slug }) => {
    const health = model.rundownHealth;
    const over = health.deltaMs > 0;
    const ratio =
      health.windowMs > 0 ? Math.min(1, health.plannedMs / health.windowMs) : 0;

    return (
      <WidgetCard
        title="Rundown health"
        action={
          <Link
            to={orgLink(slug, "rundown")}
            className="text-[11px] text-board-muted hover:text-board-text transition-colors"
          >
            Open
          </Link>
        }
      >
        {health.itemCount === 0 ? (
          <WidgetEmpty>No rundown built for this service yet.</WidgetEmpty>
        ) : (
          <>
            <div className="flex items-baseline gap-2">
              <span
                className={`text-2xl font-semibold tabular-nums ${
                  over ? "text-red-400" : "text-green-400"
                }`}
              >
                {over ? "+" : ""}
                {formatDuration(health.deltaMs)}
              </span>
              <span className="text-xs text-board-muted">
                {over ? "over window" : "under window"}
              </span>
            </div>
            <p className="text-[11px] text-board-muted mt-1">
              Planned {formatDuration(health.plannedMs, true)} · window{" "}
              {formatDuration(health.windowMs, true)}
            </p>
            <div className="w-full h-1.5 rounded-full bg-board-bg mt-3 overflow-hidden flex">
              <span
                className={over ? "bg-yellow-400" : "bg-green-500"}
                style={{ width: `${Math.round(ratio * 100)}%` }}
              />
              {over && <span className="bg-red-500 flex-1" />}
            </div>

            <dl className="mt-4 pt-3 border-t border-board-border space-y-1.5">
              <HealthRow
                label="Missing duration"
                value={health.missingDuration}
                tone={health.missingDuration > 0 ? "fail" : "ok"}
              />
              <HealthRow
                label="Missing owner"
                value={health.missingOwner}
                tone={health.missingOwner > 0 ? "warn" : "ok"}
              />
              <HealthRow
                label="Hard-stop conflicts"
                value={health.hardStopConflicts}
                tone={health.hardStopConflicts > 0 ? "fail" : "ok"}
              />
            </dl>
          </>
        )}
      </WidgetCard>
    );
  },
};

function HealthRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "ok" | "warn" | "fail";
}) {
  return (
    <div className="flex items-center justify-between text-xs">
      <dt className="text-board-muted">{label}</dt>
      <dd className={`tabular-nums ${value > 0 ? healthTextClass(tone) : "text-board-muted"}`}>
        {value}
      </dd>
    </div>
  );
}

// ─── Readiness factors ───────────────────────────────────────

const readinessWidget: PmWidget = {
  id: "readiness",
  title: "Readiness",
  phases: "all",
  span: "half",
  render: ({ model }) => (
    <WidgetCard
      title="Readiness"
      action={
        <span className={`text-xs tabular-nums ${healthTextClass(model.readiness.status)}`}>
          {model.readiness.score}%
        </span>
      }
    >
      <ul className="space-y-2.5">
        {model.readiness.factors.map((factor) => (
          <li key={factor.id} className="flex items-center gap-3">
            <StatusDot status={factor.status} />
            <span className="text-xs text-board-text w-24 shrink-0">{factor.label}</span>
            <span className="text-[11px] text-board-muted truncate flex-1">{factor.detail}</span>
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
  span: "full",
  render: ({ model }) => (
    <div className="rounded-xl border bg-board-card border-board-border px-4 py-3">
      <div className="mb-2.5">
        <WidgetLabel>Departments</WidgetLabel>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        {model.departments.map((dept) => (
          <div
            key={dept.key}
            className="flex items-center gap-2 px-2.5 py-2 rounded-lg bg-board-bg/50 min-w-0"
          >
            <StatusDot status={dept.status} />
            <div className="min-w-0">
              <p className="text-xs text-board-text leading-tight">{dept.label}</p>
              <p className="text-[10px] text-board-muted truncate">{dept.detail}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  ),
};

// ─── Arrivals ────────────────────────────────────────────────

const arrivalsWidget: PmWidget = {
  id: "arrivals",
  title: "Arrivals",
  phases: ["call", "live"],
  span: "half",
  isRelevant: ({ model }) => model.arrivals.total > 0,
  render: ({ model, slug }) => (
    <WidgetCard
      title="Arrivals"
      action={
        <Link
          to={orgLink(slug, "checkin")}
          className="text-[11px] text-board-muted hover:text-board-text transition-colors"
        >
          Check-in
        </Link>
      }
    >
      <div className="flex items-end gap-2 mb-3">
        <span className="text-2xl font-semibold tabular-nums text-board-text">
          {model.arrivals.present}
        </span>
        <span className="text-xs text-board-muted pb-1">of {model.arrivals.total} on site</span>
      </div>
      <ul className="space-y-1.5">
        {model.arrivals.departments.map((dept) => (
          <li key={dept.key} className="flex items-center gap-2 text-xs">
            <StatusDot
              status={dept.alarm ? "fail" : dept.present < dept.total ? "warn" : "ok"}
            />
            <span className="text-board-text flex-1">{dept.label}</span>
            {dept.alarm && (
              <span className="text-[10px] text-red-400 uppercase tracking-wide">No-show</span>
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
  span: "half",
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
  span: "third",
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
              <p className="text-[10px] text-board-muted">
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
  span: "full",
  render: ({ model, slug }) => {
    const health = model.rundownHealth;
    const behind = (health.driftMs ?? 0) > 0;
    return (
      <div className="rounded-xl border bg-red-500/5 border-red-500/25 px-5 py-4">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
          <div className="flex items-center gap-2">
            <Radio className="w-4 h-4 text-red-400" />
            <WidgetLabel>On air</WidgetLabel>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-widest text-board-muted">Drift</p>
            <p
              className={`text-xl font-semibold tabular-nums ${
                behind ? "text-red-400" : "text-green-400"
              }`}
            >
              {health.driftMs === null
                ? "--:--"
                : `${behind ? "+" : ""}${formatDuration(health.driftMs)}`}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-widest text-board-muted">Projected end</p>
            <p className="text-xl font-semibold tabular-nums text-board-text">
              {timeOfDay(health.projectedEndMs)}
            </p>
          </div>
          <Link
            to={orgLink(slug, "show")}
            className="ml-auto text-xs px-3 py-1.5 rounded-lg border border-board-border text-board-text hover:bg-board-bg transition-colors"
          >
            Open show
          </Link>
        </div>
      </div>
    );
  },
};

// ─── Debrief ─────────────────────────────────────────────────

const debriefWidget: PmWidget = {
  id: "debrief",
  title: "Debrief",
  phases: ["debrief"],
  span: "two-thirds",
  isRelevant: ({ model }) => model.debrief !== null,
  render: ({ model, slug }) => {
    const debrief = model.debrief;
    if (!debrief) return null;
    const over = (debrief.deltaMs ?? 0) > 0;
    return (
      <WidgetCard
        title="Debrief"
        action={
          <Link
            to={orgLink(slug, "production/incidents")}
            className="text-[11px] text-board-muted hover:text-board-text transition-colors"
          >
            Log an incident
          </Link>
        }
      >
        <div className="flex flex-wrap gap-x-8 gap-y-3 mb-4">
          <div>
            <p className="text-[10px] uppercase tracking-widest text-board-muted">Planned</p>
            <p className="text-xl font-semibold tabular-nums text-board-text">
              {formatDuration(debrief.plannedMs, true)}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-widest text-board-muted">Actual</p>
            <p className="text-xl font-semibold tabular-nums text-board-text">
              {debrief.actualMs === null ? "--:--" : formatDuration(debrief.actualMs, true)}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-widest text-board-muted">Delta</p>
            <p
              className={`text-xl font-semibold tabular-nums ${
                over ? "text-red-400" : "text-green-400"
              }`}
            >
              {debrief.deltaMs === null
                ? "--:--"
                : `${over ? "+" : ""}${formatDuration(debrief.deltaMs)}`}
            </p>
          </div>
        </div>

        {debrief.worstOverruns.length > 0 && (
          <>
            <WidgetLabel>Ran long</WidgetLabel>
            <ul className="mt-2 space-y-1.5">
              {debrief.worstOverruns.map((item) => (
                <li key={item.id} className="flex items-center justify-between text-xs">
                  <span className="text-board-text truncate">{item.title}</span>
                  <span className="tabular-nums text-red-400 shrink-0 ml-3">
                    +{formatDuration(item.overrunMs)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </WidgetCard>
    );
  },
};

// ─── Planning prompt ─────────────────────────────────────────

/**
 * Planning days used to render an empty page. If the next service has
 * no rundown yet, that is itself the most useful thing to say.
 */
const planningWidget: PmWidget = {
  id: "planning-start",
  title: "Get started",
  phases: ["planning", "prep"],
  span: "half",
  isRelevant: ({ model }) => model.rundownHealth.itemCount === 0,
  render: ({ slug }) => (
    <WidgetCard title="Next service">
      <p className="text-sm text-board-text">This service has no rundown yet.</p>
      <p className="text-xs text-board-muted mt-1">
        Build one, or load a saved template from a previous service.
      </p>
      <Link
        to={orgLink(slug, "rundown")}
        className="inline-flex items-center gap-2 mt-4 text-xs px-3 py-1.5 rounded-lg border border-board-border text-board-text hover:bg-board-bg transition-colors"
      >
        <Clapperboard className="w-3.5 h-3.5" />
        Build the rundown
      </Link>
    </WidgetCard>
  ),
};

// ─── Registry ────────────────────────────────────────────────

export const PM_WIDGETS: PmWidget[] = [
  liveStripWidget,
  departmentsWidget,
  attentionWidget,
  rundownHealthWidget,
  readinessWidget,
  debriefWidget,
  arrivalsWidget,
  planningWidget,
  cueExceptionsWidget,
  weekAheadWidget,
];

