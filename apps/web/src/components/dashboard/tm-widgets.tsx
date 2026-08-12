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
import { AlertTriangle, ArrowRight, Check, CircleDot, Cpu, ExternalLink, Radio, UserMinus, Wrench } from "lucide-react";
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
  onAcknowledge(faultId: string): void;
  onRelease(faultId: string): void;
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
      <section
        className={`rounded-xl border bg-board-card overflow-hidden ${
          path.status === "fail"
            ? "border-red-500/40"
            : path.status === "warn"
              ? "border-yellow-400/40"
              : "border-board-border"
        }`}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-board-border">
          <span className={`w-8 h-8 rounded-lg flex items-center justify-center ${path.status === "fail" ? "bg-red-500/15 text-red-400" : path.status === "warn" ? "bg-yellow-400/15 text-yellow-400" : "bg-green-500/15 text-green-400"}`}><Radio className="w-4 h-4" /></span>
          <div><h2 className="text-xs font-semibold text-board-text">Signal path</h2><p className="text-[11px] text-board-muted mt-0.5">{path.detail || "End-to-end delivery status"}</p></div>
          <HealthChip className="ml-auto" status={path.status ?? "ok"} label={path.status === "ok" ? "healthy" : path.status === "warn" ? "degraded" : "attention"} />
        </div>
        <div className="flex items-stretch gap-2 p-3 overflow-x-auto">
          {path.inputs.map((input, index) => <SignalNode key={input.id} ok={input.ok} eyebrow={index === 0 ? "Input" : "Source"} label={input.name} detail={input.label} />)}
          {path.inputs.length > 0 && path.destinations.length > 0 ? <ArrowRight className="w-4 h-4 text-board-muted self-center shrink-0" /> : null}
          {path.destinations.map((destination) => <SignalNode key={destination.id} ok={destination.ok} eyebrow="Destination" label={destination.name} detail={destination.label} />)}
        </div>
      </section>
    );
  },
};

function SignalNode({ ok, eyebrow, label, detail }: { ok: boolean; eyebrow: string; label: string; detail: string }) {
  return (
    <div className={`min-w-40 flex-1 rounded-lg border px-3 py-2.5 ${ok ? "border-board-border bg-board-bg/50" : "border-red-500/35 bg-red-500/5"}`}>
      <div className="flex items-center gap-2"><CircleDot className={`w-3.5 h-3.5 ${ok ? "text-green-400" : "text-red-400"}`} /><span className="text-[9px] uppercase tracking-[0.12em] text-board-muted">{eyebrow}</span></div>
      <p className="text-xs font-medium text-board-text mt-2 truncate">{label}</p><p className={`text-[10px] mt-0.5 ${ok ? "text-board-muted" : "text-red-400"}`}>{detail}</p>
    </div>
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
        {fault.ownership === "mine" && !fault.acknowledged && (
          <button onClick={() => widget.onAcknowledge(fault.id)} disabled={busy} className="inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-lg bg-yellow-400/10 border border-yellow-400/25 text-yellow-300 hover:bg-yellow-400/20 disabled:opacity-50 transition-colors"><Check className="w-3 h-3" />Acknowledge</button>
        )}
        <button
          onClick={() => widget.onResolve(fault.id)}
          disabled={busy}
          className="text-[11px] px-2.5 py-1 rounded-lg border border-board-border text-board-muted hover:text-board-text disabled:opacity-50 transition-colors"
        >
          Resolve
        </button>
        {fault.ownership !== "unassigned" && (
          <button onClick={() => widget.onRelease(fault.id)} disabled={busy} title="Return fault to the unassigned queue" className="inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-lg text-board-muted hover:text-board-text disabled:opacity-50"><UserMinus className="w-3 h-3" />Release</button>
        )}
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
        to={`/${slug}/production/assets` as never}
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
  render: ({ model, slug }) => (
    <WidgetCard title="Devices">
      <ul className="space-y-1.5">
        {model.devices.map((device) => (
          <li key={device.id} className="group flex items-center gap-2.5 text-xs rounded-lg px-2 py-2 -mx-2 hover:bg-board-bg/70">
            <Cpu className="w-3.5 h-3.5 text-green-400" />
            <span className="text-board-text truncate">{device.name}</span>
            <span className="ml-auto text-[10px] text-board-muted uppercase tracking-wide">{device.kind}</span>
            <Link to={`/${slug}/dashboard/devices/${device.id}` as never} aria-label={`Open ${device.name}`} className="text-board-muted opacity-50 group-hover:opacity-100 hover:text-board-text"><ExternalLink className="w-3 h-3" /></Link>
          </li>
        ))}
      </ul>
    </WidgetCard>
  ),
};

// ─── On duty ─────────────────────────────────────────────────

/**
 * Who is on the rota this week.
 *
 * Always rendered, and both slots always shown. An unnamed slot is the
 * useful information — a Sunday with no technical manager is a problem
 * worth seeing, not an absent row — which is the same rule the PM
 * dashboard states and this widget was quietly breaking by hiding
 * itself whenever nobody was assigned.
 *
 * Read-only: the production manager sets duty. Giving two dashboards a
 * control over one field is how the cue sheet drifted from the rundown.
 */
const dutyWidget: TmWidget = {
  id: "duty",
  title: "On duty",
  phases: "all",
  region: "rail",
  render: ({ model, slug }) => (
    <WidgetCard title="On duty">
      <ul className="space-y-2.5">
        {model.duty.map((officer) => (
          <li key={officer.key} className="flex items-center gap-2.5 text-xs">
            <span
              className={`w-7 h-7 rounded-full text-[10px] flex items-center justify-center shrink-0 ${
                officer.name
                  ? "bg-board-border text-board-text"
                  : "bg-yellow-400/10 text-yellow-400 border border-dashed border-yellow-400/40"
              }`}
            >
              {officer.name ? initials(officer.name) : <UserMinus className="w-3 h-3" />}
            </span>
            <span className="min-w-0">
              <span
                className={`block truncate ${officer.name ? "text-board-text" : "text-yellow-400"}`}
              >
                {officer.name ?? "Nobody assigned"}
              </span>
              <span className="block text-[10px] text-board-muted mt-0.5">{officer.label}</span>
            </span>
          </li>
        ))}
      </ul>
      {model.duty.some((officer) => !officer.name) && (
        <Link
          to={`/${slug}/dashboard/prod-manager` as never}
          className="inline-flex items-center gap-1 mt-3 text-[11px] text-board-muted hover:text-board-text transition-colors"
        >
          Set the rota
          <ExternalLink className="w-3 h-3" />
        </Link>
      )}
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
