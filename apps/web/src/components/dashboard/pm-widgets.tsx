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

import { Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Clapperboard, Copy, Radio } from "lucide-react";
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
import { initialsFor } from "@/lib/pm-dashboard-derive";
import type {
  AttentionItem,
  CrewPosition,
  Health,
  PmDashboardModel,
} from "@/lib/pm-dashboard-derive";

export interface PmWidgetModel {
  model: PmDashboardModel;
  slug: string;
  orgId: string;
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

// Only ever appears during call and live, and at call time it is the
// thing a PM watches hardest — the wide column, not the narrow rail.
const arrivalsWidget: PmWidget = {
  id: "arrivals",
  title: "Arrivals",
  phases: ["call", "live"],
  region: "main",
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
        unit={model.arrivals.expectedKnown ? `of ${model.arrivals.total} expected` : "on site"}
      />
      {!model.arrivals.expectedKnown && (
        <p className="text-[11px] text-board-muted mt-1.5">
          Nobody is scheduled for this service, so there is no expected list to
          compare against — this is just who has checked in.
        </p>
      )}
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1.5 mt-3">
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
                {service.name ? `${service.name} · ` : ""}
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
  render: (widgetModel) => <PlanNextCard {...widgetModel} />,
};

/**
 * The planning-day job is "make Sunday exist". A link to an empty
 * rundown editor is not that — cloning last service is, because church
 * rotas repeat and nobody wants to retype the same nine items weekly.
 */
function PlanNextCard({ model, slug, orgId }: PmWidgetModel) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canClone = model.lastServiceDate !== null;

  async function clone() {
    if (!model.lastServiceDate) return;
    setBusy(true);
    setError(null);
    try {
      // Imported lazily so the widget module does not pull the server
      // graph (and cloudflare:workers) into the client bundle.
      const { createNextService } = await import("@/lib/pm-actions");
      await createNextService({
        data: {
          orgId,
          serviceDate: model.serviceDate,
          copyFrom: model.lastServiceDate,
        },
      });
      await router.invalidate();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the service");
      setBusy(false);
    }
  }

  return (
    <WidgetCard title="Plan the next service">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[15px] text-board-text">
            Nothing scheduled for {longDate(model.serviceDate)}
          </p>
          <p className="text-xs text-board-muted mt-1">
            {canClone
              ? `Last service was ${longDate(model.lastServiceDate as string)}. Copy its rundown to start from where you left off.`
              : "Build a rundown to get the dashboard working for you."}
          </p>
          {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {canClone && (
            <button
              type="button"
              onClick={() => void clone()}
              disabled={busy}
              className="inline-flex items-center gap-2 text-xs px-3 py-2 rounded-lg bg-fire-500/15 border border-fire-500/30 text-fire-400 hover:bg-fire-500/25 disabled:opacity-50 transition-colors"
            >
              <Copy className="w-3.5 h-3.5" />
              {busy ? "Copying…" : "Copy last service"}
            </button>
          )}
          <Link
            to={orgLink(slug, "rundown")}
            className="inline-flex items-center gap-2 text-xs px-3 py-2 rounded-lg border border-board-border/80 text-board-muted hover:text-board-text transition-colors"
          >
            <Clapperboard className="w-3.5 h-3.5" />
            Start blank
          </Link>
        </div>
      </div>
    </WidgetCard>
  );
}

// ─── On the floor ────────────────────────────────────────────

/**
 * Who is physically in the building. A PM glancing up mid-prep wants
 * faces, not a number — recognising that audio has arrived is faster
 * than reading "7 of 12". Most recent arrival sits at the front, so the
 * strip visibly changes as people trickle in.
 */
const onFloorWidget: PmWidget = {
  id: "on-floor",
  title: "On the floor",
  phases: "all",
  region: "banner",
  isRelevant: ({ model }) => model.onFloor.total > 0,
  render: ({ model, slug }) => {
    const { members, total, overflow } = model.onFloor;
    return (
      <div className="rounded-lg border border-board-border/70 bg-board-card px-4 py-2.5 flex items-center gap-4">
        <WidgetLabel>On the floor</WidgetLabel>

        <div className="flex items-center -space-x-2">
          {members.map((member) => (
            <span
              key={member.id}
              title={`${member.name} — ${member.role}${
                member.sinceMinutes === null ? "" : ` · in ${member.sinceMinutes}m`
              }`}
              className="relative w-7 h-7 rounded-full overflow-hidden bg-board-bg ring-2 ring-board-card shrink-0"
            >
              {member.photoUrl ? (
                <img
                  src={member.photoUrl}
                  alt={member.name}
                  loading="lazy"
                  decoding="async"
                  className="w-full h-full object-cover"
                />
              ) : (
                <span className="w-full h-full flex items-center justify-center text-[9px] font-medium text-board-muted">
                  {member.initials}
                </span>
              )}
            </span>
          ))}
          {overflow > 0 && (
            <span className="relative w-7 h-7 rounded-full bg-board-bg ring-2 ring-board-card shrink-0 flex items-center justify-center text-[9px] font-medium text-board-muted tabular-nums">
              +{overflow}
            </span>
          )}
        </div>

        <span className="text-xs text-board-muted tabular-nums">
          {total} checked in
        </span>

        <Link to={orgLink(slug, "checkin")} className="ml-auto shrink-0">
          <WidgetAction>Check-in</WidgetAction>
        </Link>
      </div>
    );
  },
};

// ─── Crew board ──────────────────────────────────────────────

const CREW_STATUS: Record<
  CrewPosition["status"],
  { label: string; dot: Health; className: string }
> = {
  confirmed: { label: "Confirmed", dot: "ok", className: "text-green-400" },
  assigned: { label: "Not confirmed", dot: "warn", className: "text-yellow-300" },
  declined: { label: "Declined", dot: "fail", className: "text-red-400" },
  open: { label: "Open", dot: "fail", className: "text-red-400" },
};

const crewWidget: PmWidget = {
  id: "crew",
  title: "Crew",
  phases: ["planning", "prep", "call", "live"],
  region: "main",
  isRelevant: ({ model }) => model.crew.scheduled,
  render: ({ model, slug }) => {
    const crew = model.crew;
    return (
      <WidgetCard
        title="Crew"
        action={
          <Link to={orgLink(slug, "team")}>
            <WidgetAction>Manage</WidgetAction>
          </Link>
        }
      >
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3 mb-4">
          <WidgetMetric
            value={`${crew.confirmed}/${crew.total}`}
            unit="confirmed"
            tone={crew.open > 0 || crew.declined > 0 ? "fail" : crew.unconfirmed > 0 ? "warn" : "ok"}
          />
          {crew.open > 0 && (
            <CrewCount label="Open" value={crew.open} className="text-red-400" />
          )}
          {crew.unconfirmed > 0 && (
            <CrewCount label="Awaiting" value={crew.unconfirmed} className="text-yellow-300" />
          )}
          {crew.declined > 0 && (
            <CrewCount label="Declined" value={crew.declined} className="text-red-400" />
          )}
        </div>

        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1.5">
          {crew.positions.map((position) => {
            const config = CREW_STATUS[position.status];
            return (
              <li key={position.id} className="flex items-center gap-2 text-xs min-w-0">
                <StatusDot status={config.dot} />
                <span className="text-board-muted w-[92px] shrink-0 truncate">
                  {position.role}
                </span>
                <span className="text-board-text truncate flex-1">
                  {position.name ?? <span className={config.className}>Unfilled</span>}
                </span>
                {position.status !== "confirmed" && position.name && (
                  <span className={`text-[10px] shrink-0 ${config.className}`}>
                    {config.label}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </WidgetCard>
    );
  },
};

function CrewCount({
  label,
  value,
  className,
}: {
  label: string;
  value: number;
  className: string;
}) {
  return (
    <div>
      <p className={`text-lg leading-none font-semibold tabular-nums ${className}`}>{value}</p>
      <p className="text-[10px] uppercase tracking-[0.12em] text-board-muted mt-1.5">{label}</p>
    </div>
  );
}

// ─── Open items carried forward ──────────────────────────────

const openItemsWidget: PmWidget = {
  id: "open-items",
  title: "Still open",
  phases: ["planning", "prep", "debrief"],
  region: "main",
  isRelevant: ({ model }) => model.openItems.length > 0,
  render: ({ model, slug }) => (
    <WidgetCard
      title="Still open from earlier services"
      action={
        <Link to={orgLink(slug, "production/incidents")}>
          <WidgetAction>All incidents</WidgetAction>
        </Link>
      }
    >
      <ul>
        {model.openItems.map((entry) => (
          <li
            key={entry.id}
            className="flex items-center gap-3 py-2 border-t border-board-border/60 first:border-t-0"
          >
            <StatusDot
              status={entry.severity === "high" ? "fail" : entry.severity === "medium" ? "warn" : "ok"}
            />
            <div className="flex-1 min-w-0">
              <p className="text-[13px] leading-snug text-board-text truncate">
                {entry.description}
              </p>
              <p className="text-[11px] leading-snug text-board-muted">
                {entry.category} · {entry.ageDays === 0 ? "today" : `${entry.ageDays}d ago`}
              </p>
            </div>
            <Link to={orgLink(slug, "production/incidents")} className="shrink-0">
              <WidgetAction>Resolve</WidgetAction>
            </Link>
          </li>
        ))}
      </ul>
    </WidgetCard>
  ),
};

// ─── Recent services ─────────────────────────────────────────

const recentWidget: PmWidget = {
  id: "recent",
  title: "Recent services",
  phases: ["planning", "prep", "debrief"],
  region: "rail",
  isRelevant: ({ model }) => model.recent.length > 0,
  render: ({ model }) => {
    // Actuals only exist once a service has been run with the timer.
    // Printing "not timed" against every row is four repetitions of the
    // same fact; say it once, at the bottom.
    const anyTimed = model.recent.some((s) => s.deltaMs !== null);
    return (
      <WidgetCard title="Recent services">
        <ul className="space-y-2">
          {model.recent.map((service) => {
            const over = (service.deltaMs ?? 0) > 0;
            const facts = [
              service.plannedMs > 0 ? `${formatDuration(service.plannedMs, true)} planned` : null,
              service.incidentCount > 0
                ? `${service.incidentCount} incident${service.incidentCount === 1 ? "" : "s"}`
                : null,
            ].filter(Boolean);
            return (
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
                    {facts.length > 0 ? facts.join(" · ") : "No rundown"}
                  </p>
                </div>
                {service.deltaMs !== null && (
                  <span
                    className={`text-[11px] tabular-nums shrink-0 ${
                      over ? "text-red-400" : "text-green-400"
                    }`}
                  >
                    {over ? "+" : ""}
                    {formatDuration(service.deltaMs)}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        {!anyTimed && (
          <p className="text-[10px] text-board-muted/70 mt-3 pt-2.5 border-t border-board-border/60">
            Actual runtimes appear once you run a service with the timer.
          </p>
        )}
      </WidgetCard>
    );
  },
};

// ─── Duty officers ───────────────────────────────────────────

/**
 * Who is running the show this week. Both slots always render — an
 * unnamed technical manager on a Sunday is the useful signal, and a
 * missing row would hide it.
 */
const dutyWidget: PmWidget = {
  id: "duty",
  title: "On duty",
  phases: "all",
  region: "rail",
  render: (widgetModel) => <DutyCard {...widgetModel} />,
};

function DutyCard({ model, orgId }: PmWidgetModel) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);

  async function assign(duty: "pm" | "tm", userId: string) {
    setBusy(duty);
    setError(null);
    try {
      const { setDutyOfficer } = await import("@/lib/pm-actions");
      await setDutyOfficer({
        data: {
          orgId,
          weekStart: model.dutyWeekStart,
          duty,
          userId: userId || null,
        },
      });
      await router.invalidate();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save");
    } finally {
      setBusy(null);
    }
  }

  return (
    <WidgetCard title="On duty">
      <ul className="space-y-3">
        {model.duty.map((officer) => {
          const config = CREW_STATUS[officer.status];
          const selected = officer.userId ?? "";
          return (
            <li key={officer.key}>
              <div className="flex items-center gap-2.5">
                <span
                  className={`w-7 h-7 rounded-full shrink-0 flex items-center justify-center text-[9px] font-medium ${
                    officer.name
                      ? "bg-board-bg text-board-muted"
                      : "border border-dashed border-board-border text-board-muted/60"
                  }`}
                  aria-hidden="true"
                >
                  {officer.name ? initialsFor(officer.name) : "—"}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] uppercase tracking-[0.12em] text-board-muted">
                    {officer.label}
                  </p>
                  <label className="sr-only" htmlFor={`duty-${officer.key}`}>
                    {officer.label}
                  </label>
                  <select
                    id={`duty-${officer.key}`}
                    value={selected}
                    disabled={busy !== null}
                    onChange={(event) => void assign(officer.key, event.target.value)}
                    className="mt-0.5 w-full text-xs bg-transparent border border-board-border/60 rounded px-1.5 py-1 text-board-text hover:border-board-border disabled:opacity-50 transition-colors"
                  >
                    <option value="">Not assigned</option>
                    {model.orgMembers.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name}
                      </option>
                    ))}
                  </select>
                </div>
                {officer.name && officer.status !== "confirmed" && (
                  <span className={`text-[10px] shrink-0 self-end pb-1.5 ${config.className}`}>
                    {config.label}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {error && <p className="text-[10px] text-red-400 mt-2">{error}</p>}
      <p className="text-[10px] text-board-muted/70 mt-3 pt-2.5 border-t border-board-border/60">
        Week of{" "}
        {new Date(`${model.dutyWeekStart}T12:00:00`).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        })}
        , from the org roster.
      </p>
    </WidgetCard>
  );
}

// ─── Registry ────────────────────────────────────────────────

export const PM_WIDGETS: PmWidget[] = [
  liveStripWidget,
  onFloorWidget,
  departmentsWidget,
  planNextWidget,
  attentionWidget,
  rundownHealthWidget,
  crewWidget,
  openItemsWidget,
  debriefWidget,
  cueExceptionsWidget,
  readinessWidget,
  recentWidget,
  dutyWidget,
  arrivalsWidget,
  weekAheadWidget,
];
