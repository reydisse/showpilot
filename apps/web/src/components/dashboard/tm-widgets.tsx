/**
 * Tech manager widgets.
 *
 * Same registry and shell as the PM dashboard; the difference is what
 * earns a place. Faults are the main column rather than a card, because
 * this page is where a tech *works*, not where they are informed — and a
 * tech who has to navigate elsewhere to claim a fault will not do it
 * during a service.
 */

import { Link } from "@tanstack/react-router";
import { AlertTriangle, Radio, Wrench } from "lucide-react";
import {
  HealthChip,
  WidgetCard,
  WidgetEmpty,
  type WidgetDefinition,
} from "@/components/dashboard/widget";
import type { Fault, TmDashboardModel } from "@/lib/tm-dashboard-derive";

export interface TmWidgetModel {
  model: TmDashboardModel;
  slug: string;
  orgId: string;
  viewerId: string;
  members: { id: string; name: string }[];
  busyId: string | null;
  onClaim(faultId: string): void;
  onAssign(faultId: string, userId: string, name: string): void;
  onResolve(faultId: string): void;
}

export type TmWidget = WidgetDefinition<TmWidgetModel>;

// ─── Signal path ─────────────────────────────────────────────

const signalPathWidget: TmWidget = {
  id: "signal-path",
  title: "Signal path",
  phases: "all",
  region: "banner",
  // Null status means this org has never configured streaming. Not a
  // fault, not a warning — simply not their setup, so nothing renders.
  isRelevant: ({ model }) => model.signalPath.status !== null,
  render: ({ model }) => {
    const path = model.signalPath;
    return (
      <div
        className={`flex items-center gap-3 flex-wrap px-4 py-2.5 rounded-lg border-l-2 bg-board-card/60 ${
          path.status === "fail"
            ? "border-red-500"
            : path.status === "warn"
              ? "border-yellow-400"
              : "border-green-500"
        }`}
      >
        <span className="flex items-center gap-2 text-[10px] uppercase tracking-[0.12em] text-board-muted">
          <Radio className="w-3.5 h-3.5" aria-hidden="true" />
          Signal path
        </span>
        {path.inputs.map((input) => (
          <Chip key={input.id} ok={input.ok} label={`${input.name} · ${input.label}`} />
        ))}
        {path.destinations.map((destination) => (
          <Chip key={destination.id} ok={destination.ok} label={destination.name} />
        ))}
        {path.detail && (
          <span
            className={`text-[11px] ml-auto ${
              path.status === "ok" ? "text-board-muted" : "text-board-text"
            }`}
          >
            {path.detail}
          </span>
        )}
      </div>
    );
  },
};

function Chip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`text-[11px] px-2 py-0.5 rounded-full border ${
        ok
          ? "bg-green-500/15 text-green-400 border-green-500/30"
          : "bg-red-500/15 text-red-400 border-red-500/30"
      }`}
    >
      {label}
    </span>
  );
}

// ─── Faults ──────────────────────────────────────────────────

const faultQueueWidget: TmWidget = {
  id: "faults",
  title: "Faults",
  phases: "all",
  region: "main",
  render: (widget) => {
    const { model } = widget;
    if (model.faults.length === 0) {
      return (
        <WidgetCard title="Faults">
          <WidgetEmpty>Nothing open. Anything logged during the service lands here.</WidgetEmpty>
        </WidgetCard>
      );
    }
    return (
      <div>
        <div className="flex items-baseline gap-2 mb-2 px-1">
          <h2 className="text-xs font-semibold text-board-text">Faults</h2>
          <span className="text-[11px] text-board-muted">
            {model.openCount} open
            {model.unownedCount > 0 && (
              <span className="text-red-400"> · {model.unownedCount} unowned</span>
            )}
            {model.mineCount > 0 && <span> · {model.mineCount} mine</span>}
          </span>
        </div>
        <ul className="space-y-2">
          {model.faults.map((fault) => (
            <li key={fault.id}>
              <FaultRow fault={fault} widget={widget} />
            </li>
          ))}
        </ul>
      </div>
    );
  },
};

function FaultRow({ fault, widget }: { fault: Fault; widget: TmWidgetModel }) {
  const unowned = fault.ownership === "unassigned" || fault.stale;
  const busy = widget.busyId === fault.id;

  return (
    <div
      className={`border border-board-border bg-board-card/60 px-3 py-2.5 border-l-2 ${
        fault.severity === "critical"
          ? "border-l-red-500"
          : fault.severity === "warning"
            ? "border-l-yellow-400"
            : "border-l-board-muted"
      }`}
    >
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-board-border text-board-text shrink-0">
          {fault.departmentLabel}
        </span>
        <p className="text-[13px] text-board-text flex-1 min-w-[180px]">{fault.description}</p>
        {/* Ownership is the thing the eye should find first: an unowned
            fault is the one that gets dropped. */}
        <span className={`text-[11px] shrink-0 ${unowned ? "text-red-400" : "text-board-muted"}`}>
          {fault.ownership === "unassigned"
            ? "Unassigned"
            : fault.stale
              ? `${fault.assignedName} · not acknowledged`
              : `${fault.assignedName} · ${age(fault.ageMinutes)}`}
        </span>
      </div>

      <div className="flex items-center gap-2 mt-2 flex-wrap">
        {fault.ownership !== "mine" && (
          <button
            onClick={() => widget.onClaim(fault.id)}
            disabled={busy}
            className="text-[11px] px-2.5 py-1 rounded-lg bg-fire-500/15 border border-fire-500/30 text-fire-400 hover:bg-fire-500/25 disabled:opacity-50 transition-colors"
          >
            Take it
          </button>
        )}
        <button
          onClick={() => widget.onResolve(fault.id)}
          disabled={busy}
          className="text-[11px] px-2.5 py-1 rounded-lg border border-board-border text-board-muted hover:text-board-text disabled:opacity-50 transition-colors"
        >
          Resolve
        </button>
        <label className="sr-only" htmlFor={`assign-${fault.id}`}>
          Hand this fault to someone
        </label>
        <select
          id={`assign-${fault.id}`}
          value=""
          disabled={busy}
          onChange={(event) => {
            const member = widget.members.find((m) => m.id === event.target.value);
            if (member) widget.onAssign(fault.id, member.id, member.name);
          }}
          className="text-[11px] bg-transparent border border-board-border rounded-lg px-2 py-1 text-board-muted hover:text-board-text outline-none"
        >
          <option value="">Hand off…</option>
          {widget.members
            .filter((member) => member.id !== widget.viewerId)
            .map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
        </select>
        <span className="text-[11px] text-board-muted/60 ml-auto">
          {fault.carriedForward ? "carried forward" : `reported by ${fault.reportedBy}`}
        </span>
      </div>
    </div>
  );
}

// ─── Before the service ──────────────────────────────────────

/**
 * The week's work. Sits above the fault queue during planning and prep
 * because in the week these are the jobs; during a service it does not
 * render at all, since nobody is going to build a checklist mid-show.
 */
const prepWidget: TmWidget = {
  id: "prep",
  title: "Before the service",
  phases: ["planning", "prep"],
  region: "main",
  isRelevant: ({ model }) => model.prep.length > 0,
  render: ({ model, slug }) => (
    <WidgetCard title="Before the service">
      <ul className="divide-y divide-board-border/60 -my-1">
        {model.prep.map((item) => (
          <li key={item.id} className="flex items-start gap-3 py-2.5">
            <span
              className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${
                item.severity === "critical" ? "bg-red-500" : "bg-yellow-400"
              }`}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] text-board-text">{item.title}</p>
              <p className="text-[11px] text-board-muted mt-0.5">{item.detail}</p>
            </div>
            <Link
              to={`/${slug}/${item.actionPath}` as never}
              className="shrink-0 text-[11px] px-2.5 py-1 rounded-lg border border-board-border text-board-muted hover:text-board-text transition-colors"
            >
              {item.actionLabel}
            </Link>
          </li>
        ))}
      </ul>
    </WidgetCard>
  ),
};

// ─── Checks ──────────────────────────────────────────────────

const checksWidget: TmWidget = {
  id: "checks",
  title: "Checks",
  phases: ["call", "live"],
  region: "rail",
  isRelevant: ({ model }) => model.checks.length > 0,
  render: ({ model, slug }) => (
    <WidgetCard title="Checks">
      <ul className="space-y-1.5">
        {model.checks.map((check) => (
          <li key={check.key} className="flex items-center justify-between text-xs">
            <span className="text-board-text">{check.label}</span>
            <HealthChip
              status={check.status}
              label={check.outstanding === 0 ? "done" : `${check.outstanding} left`}
            />
          </li>
        ))}
      </ul>
      <Link
        to={`/${slug}/production/checklist` as never}
        className="block mt-3 text-[11px] text-board-muted hover:text-board-text transition-colors"
      >
        Open the checklist
      </Link>
    </WidgetCard>
  ),
};

// ─── Equipment ───────────────────────────────────────────────

const equipmentWidget: TmWidget = {
  id: "equipment",
  title: "Equipment",
  phases: "all",
  region: "rail",
  isRelevant: ({ model }) => model.equipmentFaults.length > 0,
  render: ({ model, slug }) => (
    <WidgetCard title="Equipment">
      <ul className="space-y-2">
        {model.equipmentFaults.map((item) => (
          <li key={item.id} className="text-xs">
            <p className="text-board-text flex items-center gap-1.5">
              <Wrench className="w-3 h-3 text-board-muted shrink-0" aria-hidden="true" />
              {item.name}
            </p>
            <p
              className={
                item.status === "out-of-service" ? "text-red-400 mt-0.5" : "text-yellow-400 mt-0.5"
              }
            >
              {item.status === "out-of-service"
                ? "Out of service"
                : item.status === "in-repair"
                  ? "In repair"
                  : "Needs repair"}
            </p>
          </li>
        ))}
      </ul>
      <Link
        to={`/${slug}/dashboard/tech-manager` as never}
        className="block mt-3 text-[11px] text-board-muted hover:text-board-text transition-colors"
      >
        Equipment register
      </Link>
    </WidgetCard>
  ),
};

// ─── Devices ─────────────────────────────────────────────────

const devicesWidget: TmWidget = {
  id: "devices",
  title: "Devices",
  phases: ["prep", "call", "live"],
  region: "rail",
  // Only devices this org has actually configured. A module that ships
  // in the codebase but was never set up is not a device that is down.
  isRelevant: ({ model }) => model.devices.length > 0,
  render: ({ model }) => (
    <WidgetCard title="Devices">
      <ul className="space-y-1.5">
        {model.devices.map((device) => (
          <li key={device.id} className="flex items-center justify-between text-xs">
            <span className="text-board-text">{device.name}</span>
            <span className="text-[11px] text-board-muted">{device.kind}</span>
          </li>
        ))}
      </ul>
    </WidgetCard>
  ),
};

// ─── On duty ─────────────────────────────────────────────────

/**
 * Who is on the rota this week. Read-only: the production manager sets
 * duty, and giving two dashboards a control over one field is how the
 * cue sheet drifted from the rundown.
 */
const dutyWidget: TmWidget = {
  id: "duty",
  title: "On duty",
  phases: "all",
  region: "rail",
  isRelevant: ({ model }) => model.duty.some((officer) => officer.name),
  render: ({ model }) => (
    <WidgetCard title="On duty">
      <ul className="space-y-2">
        {model.duty.map((officer) => (
          <li key={officer.key} className="flex items-center gap-2 text-xs">
            <span className="w-6 h-6 rounded-full bg-board-border text-board-text text-[10px] flex items-center justify-center shrink-0">
              {initials(officer.name)}
            </span>
            <span className="text-board-text truncate">{officer.name ?? "Nobody"}</span>
            <span className="ml-auto text-[11px] text-board-muted shrink-0">{officer.label}</span>
          </li>
        ))}
      </ul>
    </WidgetCard>
  ),
};

/**
 * Minutes only make sense for the current service. A fault carried over
 * from May is 8515 minutes old, which is a number nobody can read — and
 * this queue is deliberately full of old faults, so it comes up often.
 */
function age(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function initials(name: string | null): string {
  if (!name) return "—";
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

// ─── Nothing to do ───────────────────────────────────────────

const allClearWidget: TmWidget = {
  id: "all-clear",
  title: "All clear",
  phases: ["call", "live"],
  region: "main",
  // The one exception to "never report a healthy count". Mid-service,
  // an empty page is ambiguous — it could mean nothing is wrong or it
  // could mean the page is broken. Say which.
  isRelevant: ({ model }) =>
    model.faults.length === 0 &&
    model.equipmentFaults.length === 0 &&
    model.prep.length === 0,
  render: () => (
    <WidgetCard title="All clear">
      <p className="text-xs text-board-muted flex items-center gap-2">
        <AlertTriangle className="w-3.5 h-3.5 text-green-400" aria-hidden="true" />
        No open faults. Anything logged during the service appears here.
      </p>
    </WidgetCard>
  ),
};

export const TM_WIDGETS: TmWidget[] = [
  signalPathWidget,
  prepWidget,
  faultQueueWidget,
  allClearWidget,
  dutyWidget,
  checksWidget,
  equipmentWidget,
  devicesWidget,
];
