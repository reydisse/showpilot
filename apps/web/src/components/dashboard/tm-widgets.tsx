import { workspaceCopy, type WorkspaceTerms } from "@showpilot/shared";
/**
 * Tech manager widgets — A (Doop canvas aneicgaHqk, "Tech Manager").
 *
 * Same registry and shell as the PM dashboard; the difference is what
 * earns a place. Faults are the main column rather than a card, because
 * this page is where a tech *works*, not where they are informed — and a
 * tech who has to navigate elsewhere to claim a fault will not do it
 * during a service.
 */

import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  Box,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleX,
  Cpu,
  ExternalLink,
  ListChecks,
  MoreHorizontal,
  Radio,
  TriangleAlert,
  Users,
} from "lucide-react";
import type { WidgetDefinition } from "@/components/dashboard/widget";
import type { Fault, TmDashboardModel } from "@/lib/tm-dashboard-derive";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Callout, StatusWord, TmPanel, initials, tmIconButton, tmLink, tmSecondary } from "./tm-a";

export interface TmWidgetModel {
  terms: WorkspaceTerms;
  model: TmDashboardModel;
  slug: string;
  orgId: string;
  viewerId: string;
  canAssignPeople: boolean;
  canClaimFaults: boolean;
  members: { id: string; name: string; role: string; roleLabel: string }[];
  busyId: string | null;
  readUnavailable?: boolean;
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
  title: "Stream setup",
  phases: "all",
  region: "banner",
  // Null status means this org has never configured streaming. Not a
  // fault, not a warning — simply not their setup, so nothing renders.
  isRelevant: ({ model }) => model.signalPath.status !== null,
  render: ({ model }) => {
    const path = model.signalPath;
    const word = path.status === "fail"
      ? <StatusWord tone="danger" icon={CircleX}>Failing</StatusWord>
      : path.status === "warn"
        ? <StatusWord tone="warn" icon={TriangleAlert}>Needs review</StatusWord>
        : <StatusWord tone="ok" icon={CircleCheck}>Configured</StatusWord>;
    return (
      <section aria-label="Stream setup" className="flex flex-col gap-4 rounded-xl border border-[var(--sa-border)] bg-[var(--sa-surface)] p-4 lg:flex-row lg:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--sa-border)] bg-[var(--sa-surface-2)] text-[var(--sa-ink-3)]"><Radio className="h-4 w-4" strokeWidth={1.75} /></span>
          <div className="min-w-0">
            <h2 className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] font-semibold text-board-text">Stream setup {word}</h2>
            <p className="mt-0.5 text-xs leading-[1.5] text-[var(--sa-ink-2)]">{path.detail || "Saved inputs and destination selections"}</p>
          </div>
        </div>
        {path.inputs.length || path.destinations.length ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {path.inputs.map((input, index) => (
              <SignalNode key={input.id} ok={input.ok} eyebrow={index === 0 ? "Input" : "Source"} label={input.name} detail={input.label} />
            ))}
            {path.inputs.length > 0 && path.destinations.length > 0 ? <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-[var(--sa-ink-3)]" /> : null}
            {path.destinations.map((destination) => (
              <SignalNode key={destination.id} ok={destination.ok} eyebrow="Destination" label={destination.name} detail={destination.label} />
            ))}
          </div>
        ) : null}
      </section>
    );
  },
};

function SignalNode({ ok, eyebrow, label, detail }: { ok: boolean; eyebrow: string; label: string; detail: string }) {
  const Icon = ok ? CircleCheck : CircleX;
  return (
    <div className={`min-w-0 flex-1 rounded-lg border px-3 py-2 sm:w-[180px] sm:flex-none ${ok ? "border-[var(--sa-border-strong)] bg-board-bg/40" : "border-[var(--sa-danger)]/40 bg-[var(--sa-danger)]/[0.05]"}`}>
      <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--sa-ink-3)]"><Icon aria-hidden="true" className={`h-3 w-3 ${ok ? "text-[var(--sa-ok)]" : "text-[var(--sa-danger)]"}`} />{eyebrow}</p>
      <p className="mt-0.5 truncate text-[13px] font-semibold text-board-text">{label}</p>
      <p className={`truncate text-xs ${ok ? "text-[var(--sa-ink-2)]" : "text-[var(--sa-danger)]"}`}>{detail}</p>
    </div>
  );
}

// ─── Faults ──────────────────────────────────────────────────

const SEVERITY_TAG: Record<Fault["severity"], { label: string; className: string }> = {
  critical: { label: "Critical", className: "border-[var(--sa-danger)]/40 bg-[var(--sa-danger)]/10 text-[var(--sa-danger)]" },
  warning: { label: "Warning", className: "border-[var(--sa-warn)]/35 bg-[var(--sa-warn)]/10 text-[var(--sa-warn)]" },
  info: { label: "Info", className: "border-[var(--sa-border-strong)] bg-[var(--sa-surface-2)] text-[var(--sa-ink-2)]" },
};

const faultQueueWidget: TmWidget = {
  id: "faults",
  title: "Incidents",
  phases: "all",
  region: "main",
  render: (widget) => {
    const { model } = widget;
    const listLimit = model.incidentsTruncated ? (
      <p className="mb-2 text-xs text-[var(--sa-ink-2)]">
        Showing the 25 highest-priority incidents. Filters and ownership counts apply to those shown.{" "}
        <Link to={`/${widget.slug}/production/incidents` as never} className={tmLink}>Review the full incident log</Link>
      </p>
    ) : null;
    if (model.faults.length === 0) {
      return (
        <div className="flex items-center gap-2.5 rounded-xl border border-dashed border-[var(--sa-border-strong)] px-4 py-3.5">
          <TriangleAlert aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--sa-ink-3)]" strokeWidth={1.75} />
          <p className="text-[13px] text-[var(--sa-ink-2)]">
            <span className="font-semibold text-board-text">Incidents.</span>{" "}
            {workspaceCopy(model.openCount > 0 ? "No incidents match this view. Change the filter or search." : "Nothing open. Anything logged during the service lands here.", widget.terms)}
          </p>
        </div>
      );
    }
    return (
      <TmPanel icon={TriangleAlert} title="Incidents" label="Incidents" subtitle={<>
        <span className="tabular-nums">{model.openCount}{model.incidentsTruncated ? "+" : ""}</span> open
        {model.unownedCount > 0 ? <span className="text-[var(--sa-danger)]"> · <span className="tabular-nums">{model.unownedCount}</span> unowned</span> : null}
        {model.mineCount > 0 ? <> · <span className="tabular-nums">{model.mineCount}</span> mine</> : null}
      </>}>
        {listLimit}
        <ul className="-mt-1 divide-y divide-[var(--sa-border)]">
          {model.faults.map((fault) => <li key={fault.id}><FaultRow fault={fault} widget={widget} /></li>)}
        </ul>
      </TmPanel>
    );
  },
};

function FaultRow({ fault, widget }: { fault: Fault; widget: TmWidgetModel }) {
  const unowned = fault.ownership === "unassigned" || fault.stale;
  const busy = widget.busyId === fault.id || widget.readUnavailable || !widget.canClaimFaults;
  const tag = SEVERITY_TAG[fault.severity];
  const owner = fault.ownership === "unassigned" ? "Unowned" : fault.stale ? `${fault.assignedName} · not acknowledged` : fault.ownership === "mine" ? `You · ${age(fault.ageMinutes)}` : `${fault.assignedName} · ${age(fault.ageMinutes)}`;
  const canRelease = fault.ownership !== "unassigned" && (widget.canAssignPeople || fault.ownership === "mine");
  const primary = !widget.canClaimFaults ? null
    : fault.ownership !== "mine" ? <button type="button" onClick={() => widget.onClaim(fault.id)} disabled={busy} className={tmSecondary}>Assign to me</button>
      : !fault.acknowledged ? <button type="button" onClick={() => widget.onAcknowledge(fault.id)} disabled={busy} className={tmSecondary}>Acknowledge</button>
        : <button type="button" onClick={() => widget.onResolve(fault.id)} disabled={busy} className={tmSecondary}>Resolve</button>;
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 py-3 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
      <span className={`self-start rounded-md border px-1.5 py-0.5 text-xs font-medium ${tag.className}`}>{tag.label}</span>
      <div className="min-w-0">
        <p className="break-words text-[13px] font-semibold text-board-text">{fault.description}</p>
        <p className="mt-0.5 text-xs text-[var(--sa-ink-2)]">{fault.departmentLabel} · {tag.label} · <span className="tabular-nums">{age(fault.ageMinutes)}</span> · {fault.carriedForward ? "carried forward" : `reported by ${fault.reportedBy}`}</p>
      </div>
      <div className="col-span-2 flex flex-wrap items-center justify-end gap-2 sm:col-span-1">
        <span className={`text-xs ${unowned ? "text-[var(--sa-danger)]" : "text-[var(--sa-ink-2)]"}`}>{owner}</span>
        {primary}
        {widget.canClaimFaults ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" disabled={busy} aria-label={`More actions for ${fault.description}`} className={tmIconButton}><MoreHorizontal className="h-4 w-4" /></button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="schedule-a min-w-[200px]">
              {fault.ownership === "mine" && !fault.acknowledged ? <DropdownMenuItem onSelect={() => widget.onResolve(fault.id)}>Resolve</DropdownMenuItem> : null}
              {fault.ownership !== "mine" ? <DropdownMenuItem onSelect={() => widget.onResolve(fault.id)}>Resolve</DropdownMenuItem> : null}
              {canRelease ? <DropdownMenuItem onSelect={() => widget.onRelease(fault.id)}>Release</DropdownMenuItem> : null}
              {widget.canAssignPeople ? <>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger disabled={widget.members.length === 0}>{widget.members.length ? "Assign person…" : "No eligible people"}</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="schedule-a max-h-72 overflow-y-auto">
                    <DropdownMenuLabel className="text-xs text-[var(--sa-ink-3)]">Assign an operator</DropdownMenuLabel>
                    {widget.members.map((member) => (
                      <DropdownMenuItem key={member.id} onSelect={() => widget.onAssign(fault.id, member.id, member.name)}>
                        {member.name} <span className="ml-auto pl-3 text-xs text-[var(--sa-ink-3)]">{member.roleLabel}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </> : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
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
  render: ({ terms: workspaceTerms, model, slug }) => (
    <TmPanel icon={ListChecks} title={workspaceCopy("Before the service", workspaceTerms)} label="Before the service" subtitle="Planning and Prep only">
      <ul className="flex flex-col gap-2">
        {model.prep.map((item) => (
          <li key={item.id}>
            <Callout tone={item.severity === "critical" ? "danger" : "warn"} icon={TriangleAlert} title={item.title}
              action={<Link to={`/${slug}/${item.actionPath}` as never} className={tmSecondary}>{item.actionLabel === "Open" ? "Open checklist" : item.actionLabel}</Link>}>
              {item.detail}
            </Callout>
          </li>
        ))}
      </ul>
    </TmPanel>
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
    <TmPanel icon={ListChecks} title="Checks" label="Checks" subtitle="Call and Live only"
      footer={<Link to={`/${slug}/production/checklist` as never} className={tmLink}>Open the checklist</Link>}>
      <ul className="-mt-1 divide-y divide-[var(--sa-border)]">
        {model.checks.map((check) => (
          <li key={check.key} className="flex min-h-10 items-center justify-between gap-3 text-[13px]">
            <span className="font-medium text-board-text">{check.label}</span>
            {check.outstanding === 0
              ? <StatusWord tone="ok" icon={CircleCheck}>Done</StatusWord>
              : <StatusWord tone={check.status === "fail" ? "danger" : "warn"} icon={check.status === "fail" ? CircleX : TriangleAlert}><span className="tabular-nums">{check.outstanding}</span> left</StatusWord>}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs leading-[1.5] text-[var(--sa-ink-3)]">Per department, from call time.</p>
    </TmPanel>
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
    <TmPanel icon={Box} title="Equipment" label="Equipment"
      subtitle={<><span className="tabular-nums">{model.equipmentFaults.length}</span> not operational</>}
      action={<Link to={`/${slug}/production/assets` as never} className={tmLink}>Register</Link>}>
      <EquipmentRotator items={model.equipmentFaults} />
    </TmPanel>
  ),
};

const EQUIPMENT_PAGE_SIZE = 3;
const EQUIPMENT_ROTATION_MS = 5_000;

function EquipmentRotator({ items }: { items: TmDashboardModel["equipmentFaults"] }) {
  const pageCount = Math.ceil(items.length / EQUIPMENT_PAGE_SIZE);
  const [page, setPage] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused || pageCount <= 1) return;
    const id = window.setInterval(() => setPage((current) => (current + 1) % pageCount), EQUIPMENT_ROTATION_MS);
    return () => window.clearInterval(id);
  }, [pageCount, paused]);

  useEffect(() => setPage((current) => Math.min(current, Math.max(0, pageCount - 1))), [pageCount]);

  const visible = items.slice(page * EQUIPMENT_PAGE_SIZE, (page + 1) * EQUIPMENT_PAGE_SIZE);
  return (
    <div onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocusCapture={() => setPaused(true)} onBlurCapture={() => setPaused(false)}>
      <ul key={page} className="-mt-1 divide-y divide-[var(--sa-border)] motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300">
        {visible.map((item) => (
          <li key={item.id} className="flex min-h-10 items-center justify-between gap-3">
            <span className="min-w-0 truncate text-[13px] font-medium text-board-text">{item.name}</span>
            <StatusWord tone={item.status === "out-of-service" ? "danger" : "warn"} icon={item.status === "out-of-service" ? CircleX : TriangleAlert}>
              {item.status === "out-of-service" ? "Out of service" : item.status === "in-repair" ? "In repair" : "Needs repair"}
            </StatusWord>
          </li>
        ))}
      </ul>
      {pageCount > 1 ? (
        <div className="-mx-4 -mb-4 mt-3 flex items-center justify-between border-t border-[var(--sa-border)] px-4 py-1.5">
          <span className="text-xs text-[var(--sa-ink-3)]"><span className="tabular-nums">{page * EQUIPMENT_PAGE_SIZE + 1}–{Math.min((page + 1) * EQUIPMENT_PAGE_SIZE, items.length)} of {items.length}</span> · {paused ? "Paused" : "Rotates every 5s"}</span>
          <div className="flex items-center">
            <button type="button" aria-label="Previous equipment" onClick={() => setPage((current) => (current - 1 + pageCount) % pageCount)} className={tmIconButton}><ChevronLeft className="h-3.5 w-3.5" /></button>
            <button type="button" aria-label="Next equipment" onClick={() => setPage((current) => (current + 1) % pageCount)} className={tmIconButton}><ChevronRight className="h-3.5 w-3.5" /></button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

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
    <TmPanel icon={Cpu} title="Devices" label="Devices" subtitle="Configured">
      <ul className="-mt-1 flex flex-col">
        {model.devices.map((device) => (
          <li key={device.id} className="flex min-h-10 items-center gap-2.5">
            <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full shadow-[inset_0_0_0_1.5px_var(--sa-ink-3)]" />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-board-text" title={device.name}>{device.name}</span>
            <span className="shrink-0 rounded border border-[var(--sa-border-strong)] px-1.5 text-xs text-[var(--sa-ink-2)]">{device.kind}</span>
            <Link to={`/${slug}/dashboard/devices/${device.id}` as never} aria-label={`Open ${device.name}`} className={tmIconButton}><ExternalLink className="h-3.5 w-3.5" /></Link>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs leading-[1.5] text-[var(--sa-ink-3)]">Configured only. Open a device for its live status.</p>
    </TmPanel>
  ),
};

// ─── On duty ─────────────────────────────────────────────────

/**
 * Who is on the rota this week.
 *
 * Always rendered, and both slots always shown. An unnamed slot is the
 * useful information — a Sunday with no technical manager is a problem
 * worth seeing, not an absent row.
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
    <TmPanel icon={Users} title="On duty" label="On duty" subtitle="This week's rota">
      <ul className="flex flex-col gap-3">
        {model.duty.map((officer) => (
          <li key={officer.key} className="flex items-center gap-3">
            {officer.name
              ? <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--sa-surface-3)] text-xs font-semibold text-board-text">{initials(officer.name)}</span>
              : <span aria-hidden="true" className="h-8 w-8 shrink-0 rounded-full border border-dashed border-[var(--sa-border-strong)]" />}
            <span className="min-w-0">
              {officer.name
                ? <span className="block truncate text-[13px] font-semibold text-board-text">{officer.name}</span>
                : <Link to={`/${slug}/dashboard/prod-manager` as never} className="inline-flex min-h-6 items-center text-[13px] font-semibold text-board-text underline decoration-[var(--sa-border-strong)] underline-offset-[3px] max-lg:min-h-11 max-lg:min-w-11 max-lg:items-center">Set the rota</Link>}
              <span className="block text-xs text-[var(--sa-ink-2)]">{officer.label}</span>
            </span>
          </li>
        ))}
      </ul>
    </TmPanel>
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

// "Recorded checks clear" used to be its own card. Readiness in the
// overview now says "Checks clear", and the empty incident line says the
// rest, so the card is gone; its id stays valid in saved layouts.
export const TM_WIDGETS: TmWidget[] = [
  signalPathWidget,
  prepWidget,
  faultQueueWidget,
  dutyWidget,
  checksWidget,
  equipmentWidget,
  devicesWidget,
];
