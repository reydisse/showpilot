import { RelaySyncNotice } from "@/components/RelaySyncNotice";
import { workspaceCopy } from "@showpilot/shared";
import { useTerms } from "@/components/workspace/WorkspaceProvider";
/**
 * Tech manager dashboard — A (Doop canvas aneicgaHqk, "Tech Manager").
 *
 * The same shell as the production manager's — widget registry, regions,
 * phase-driven selection — pointed at a different question. The PM's page
 * asks whether the service is ready and on time; this one asks whether
 * the signal path is intact and, when it isn't, what to touch first.
 *
 * Faults occupy the main column and carry their own actions, because a
 * tech who has to navigate somewhere else to claim a fault will not do it
 * during a service.
 */

import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  ClipboardList,
  CloudOff,
  Eye,
  GitBranch,
  GripVertical,
  LayoutGrid,
  NotebookPen,
  Radio,
  RefreshCw,
  Search,
  TriangleAlert,
  Unplug,
  Users,
  Wrench,
} from "lucide-react";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { getTmDashboard } from "@/lib/tm-dashboard";
import { phaseLabel, type ServicePhase } from "@/lib/service-phase";
import { ShowSwitcherMenu } from "@/components/show-switcher-menu";
import { TM_WIDGETS, type TmWidget, type TmWidgetModel } from "@/components/dashboard/tm-widgets";
import { TmOperations } from "@/components/dashboard/tm-operations";
import { selectWidgets, widgetsInRegion } from "@/components/dashboard/widget";
import {
  TM_LAYOUT_SECTION_IDS,
  TM_LAYOUT_WIDGET_IDS,
  type TmDashboardLayout,
  type TmManagementState,
  type TmManagementCommand,
} from "@/lib/tm-management-contract";
import { getTmManagementState } from "@/lib/tm-management";
import { useTmManagement, type TmManagementController } from "@/hooks/useTmManagement";
import { TmManagementRecovery } from "@/components/dashboard/TmManagementRecovery";
import { useOperatorRead } from "@/hooks/useOperatorRead";
import { ReadFailureNotice } from "@/components/layout/ReadFailureNotice";
import { useCueSheetSync } from "@/hooks/useCueSheetSync";
import { Spinner, tmEyebrow, tmIconButton, tmPrimary, tmSecondary, type Tone, toneText } from "@/components/dashboard/tm-a";

export const Route = createFileRoute("/$slug/dashboard/tech-manager")({
  validateSearch: (search: Record<string, unknown>) => ({
    date: typeof search.date === "string" ? search.date : undefined,
    show: typeof search.show === "string" ? search.show : undefined,
  }),
  loaderDeps: ({ search }) => ({ date: search.date, show: search.show }),
  pendingMs: 800,
  pendingMinMs: 100,
  pendingComponent: () => <PageSkeleton />,
  loader: async ({ context, deps, abortController }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, "dashboard:tm", context.slug, context.orgId);
    const [dashboard, management] = await Promise.all([
      getTmDashboard({ data: { orgId: context.orgId, serviceDate: deps.date, showId: deps.show }, signal: abortController.signal }),
      getTmManagementState({ data: { orgId: context.orgId, userId: context.user.id }, signal: abortController.signal }),
    ]);
    return { ...dashboard, management };
  },
  component: TechManagerPage,
});

function TechManagerPage() {
  const initial = Route.useLoaderData();
  const { user } = Route.useRouteContext();
  return <TechManagerWorkspace key={`${user.id}:${initial.orgId}:${initial.showId}`} initial={initial} />;
}

const SECTION_TITLES: Record<string, string> = {
  overview: "System overview",
  "signal-path": "Stream setup",
  workspace: "Incident workspace",
  operations: "Live operations",
};
/** Sections that sit beside the rail rather than across the page. */
const RAIL_SECTIONS = new Set(["workspace", "operations"]);

function TechManagerWorkspace({ initial }: { initial: Awaited<ReturnType<typeof getTmDashboard>> & { management: TmManagementState } }) {
  const search = Route.useSearch();
  const { management, ...snapshot } = initial;
  const load = useCallback((signal: AbortSignal) => getTmDashboard({ data: { orgId: initial.orgId, serviceDate: search.date, showId: search.show }, signal }), [initial.orgId, search.date, search.show]);
  const read = useOperatorRead({ key: JSON.stringify(snapshot), initialValue: snapshot, read: load, intervalMs: 10_000, errorMessage: "Technical dashboard could not refresh. Last confirmed values are shown. Retry before changing incidents." });
  const { model, orgId, showId, shows, orgTimezone, viewerId, members, liveInputs, streamDestinations, timing } = read.value;
  const { slug } = Route.useParams();
  const navigate = useNavigate({ from: Route.fullPath });
  const terms = useTerms();
  const [query, setQuery] = useState("");
  const [faultView, setFaultView] = useState<"all" | "unowned" | "mine" | "critical">("all");
  const [editingLayout, setEditingLayout] = useState(false);
  const { publish: publishIncident, syncError, syncErrorAt, status: syncStatus, retrySync } = useCueSheetSync({
    orgId,
    scope: showId ?? "",
    onNote: () => {},
    onRefresh: async () => { await read.refresh(); },
    onIncident: read.invalidate,
  });

  const control = useTmManagement(management, (incidentId) => {
    publishIncident({ type: "incident", showId, incidentId, action: "updated", at: Date.now() });
    read.invalidate();
  });
  const queuedAction = useRef<(() => void) | null>(null);
  const controlsFetching = control.read.isFetching;
  useEffect(() => {
    if (controlsFetching || !queuedAction.current) return;
    const run = queuedAction.current;
    queuedAction.current = null;
    if (!control.read.isError) run();
  }, [controlsFetching]); // eslint-disable-line react-hooks/exhaustive-deps
  const layout = control.layout;
  const layoutLocked = control.unresolved("layout") || control.unavailable;
  const act = (faultId: string, action: "assign" | "acknowledge" | "resolve", assignedTo: string | null = null) => {
    // A background refresh doesn't block: every write carries the incident's
    // revision, and the server refuses it if the incident changed meanwhile.
    if (read.error || editingLayout || !control.read.data.canManageIncidents) return;
    const fault = model.faults.find(item => item.id === faultId);
    if (!fault) return;
    const operation: TmManagementCommand["operation"] = action === "assign"
      ? { kind: "assign", id: faultId, assignedTo, expectedRevision: fault.revision }
      : { kind: action, id: faultId, expectedRevision: fault.revision };
    const run = () => control.send(operation, `${action === "assign" ? assignedTo ? "Assign" : "Release" : action === "resolve" ? "Resolve" : "Acknowledge"} incident: ${fault.description}`);
    // The controls read refreshes every 10s and commands wait for it, so a
    // click in that moment is held and sent when the read lands.
    if (control.read.isFetching) queuedAction.current = run;
    else run();
  };

  const filteredModel = useMemo(() => ({
    ...model,
    faults: model.faults.filter((fault) => {
      const viewMatches = faultView === "all"
        || (faultView === "unowned" && (fault.ownership === "unassigned" || fault.stale))
        || (faultView === "mine" && fault.ownership === "mine")
        || (faultView === "critical" && fault.severity === "critical");
      const needle = query.trim().toLowerCase();
      const searchable = `${fault.description} ${fault.departmentLabel} ${fault.assignedName}`;
      return viewMatches && (!needle || searchable.toLowerCase().includes(needle));
    }),
  }), [faultView, model, query]);

  const widgetModel: TmWidgetModel = {
    terms,
    model: filteredModel,
    slug,
    orgId,
    viewerId,
    canAssignPeople: control.read.data.canAssignPeople,
    canClaimFaults: control.read.data.canManageIncidents,
    members,
    busyId: null,
    // Reads refresh in the background every 10s; only a failed read or an
    // unconfirmed change locks the incident actions.
    readUnavailable: !!read.error || editingLayout || control.read.isError || control.unresolved("incident"),
    onClaim: (id) => act(id, "assign", viewerId),
    onAssign: (id, userId) => act(id, "assign", userId),
    onResolve: (id) => act(id, "resolve"),
    onAcknowledge: (id) => act(id, "acknowledge"),
    onRelease: (id) => act(id, "assign", null),
  };

  const widgets = selectWidgets(TM_WIDGETS, model.phase, widgetModel);
  const banners = widgetsInRegion(widgets, "banner");
  const main = widgetsInRegion(widgets, "main");
  const rail = widgetsInRegion(widgets, "rail");
  const orderedMain = orderMainWidgets(main, layout.main);
  const persistLayout = (next: TmDashboardLayout) => control.send({ kind: "layout", layout: next, expectedRevision: control.read.data.layoutRevision }, "Arrange dashboard");
  const layoutStatus = <LayoutStatus control={control} />;

  const workspaceContent = (
    <div className="flex flex-col gap-3">
      <FaultToolbar query={query} onQueryChange={setQuery} value={faultView} onChange={setFaultView}
        counts={{ all: model.openCount, unowned: model.unownedCount, mine: model.mineCount, critical: model.faults.filter((fault) => fault.severity === "critical").length }} />
      <ReorderableMainWidgets widgets={orderedMain} widgetModel={widgetModel} editing={editingLayout} locked={layoutLocked} status={layoutStatus}
        onReorder={(mainOrder) => void persistLayout({ ...layout, main: mainOrder as TmDashboardLayout["main"] })} />
    </div>
  );
  const railContent = rail.length ? <div className="flex min-w-0 flex-col gap-3">{rail.map((widget) => <Fragment key={widget.id}>{widget.render(widgetModel)}</Fragment>)}</div> : null;

  return (
    <div className="schedule-a h-full overflow-auto bg-board-bg">
      <RelaySyncNotice error={syncError} occurredAt={syncErrorAt} status={syncStatus} onRetry={retrySync} />
      <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-5 px-4 pb-12 pt-6 md:px-7 min-[1800px]:max-w-[1880px] min-[1800px]:px-10">
        <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div className="flex min-w-0 items-center gap-3.5">
            <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border border-[var(--sa-border-strong)] bg-[var(--sa-surface)] text-[var(--sa-ink-2)]"><Wrench className="h-4 w-4" strokeWidth={1.75} /></span>
            <div className="min-w-0">
              <h1 className="text-[22px] font-semibold leading-[1.15] tracking-[-0.02em] text-board-text">Tech Manager</h1>
              <p className="mt-0.5 text-[13px] text-[var(--sa-ink-2)]">Technical readiness: incidents, equipment and live systems</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ShowSwitcherMenu variant="a" today={serviceDateToday(orgTimezone)} selectedId={showId} shows={shows} timeZone={orgTimezone}
              onSelect={(selected) => void navigate({ search: { date: selected.serviceDate, show: selected.id } })} />
            <button type="button" aria-pressed={editingLayout} onClick={() => setEditingLayout((value) => !value)} className={`${editingLayout ? tmPrimary : tmSecondary} h-9`}>
              <LayoutGrid className="h-3.5 w-3.5" />{editingLayout ? "Done arranging" : "Arrange widgets"}
            </button>
            <button type="button" aria-label="Refresh dashboard" disabled={read.refreshing} onClick={read.retry} className={`${tmIconButton} h-9 w-9 border border-[var(--sa-border-strong)]`}>
              <RefreshCw className={`h-3.5 w-3.5 ${read.refreshing ? "animate-spin motion-reduce:animate-none" : ""}`} />
            </button>
          </div>
        </header>

        <ReadFailureNotice variant="panel" error={read.error} refreshing={read.refreshing} retry={read.retry} label="Retry dashboard" title="We couldn't refresh the dashboard." description="Last confirmed values are shown. Retry before changing incidents." />
        <TmManagementRecovery control={control} />

        {editingLayout ? (
          <ArrangeBar text="Arrange the major dashboard zones. Operational controls are locked while arranging." status={layoutStatus}
            reset={locked => locked ? null : <button type="button" onClick={() => void persistLayout({ ...layout, sections: [...TM_LAYOUT_SECTION_IDS] })} className="inline-flex min-h-8 items-center px-2 text-[13px] font-medium text-[var(--sa-ink-2)] hover:text-board-text max-lg:min-h-11">Reset layout</button>}
            locked={layoutLocked} />
        ) : null}

        <ReorderableSections
          editing={editingLayout}
          locked={layoutLocked}
          order={layout.sections}
          rail={railContent}
          onReorder={(sections) => void persistLayout({ ...layout, sections: sections as TmDashboardLayout["sections"] })}
          sections={{
            overview: <HealthOverview model={model} slug={slug} timing={timing} timeZone={orgTimezone} />,
            "signal-path": banners.length ? <>{banners.map((widget) => <Fragment key={widget.id}>{widget.render(widgetModel)}</Fragment>)}</> : null,
            workspace: workspaceContent,
            operations: <TmOperations userId={viewerId} orgId={orgId} slug={slug} inputs={liveInputs} destinations={streamDestinations} phase={model.phase} />,
          }}
        />
      </div>
    </div>
  );
}

function serviceDateToday(timeZone?: string) {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
  catch { return new Date().toISOString().slice(0, 10); }
}

// ─── System overview ─────────────────────────────────────────

const PHASES: ServicePhase[] = ["planning", "prep", "call", "live", "debrief"];
const PHASE_META: Record<ServicePhase, { icon: React.ElementType; detail: string; pill: string }> = {
  planning: { icon: CalendarDays, detail: "More than 48 hours before start", pill: "border-[var(--sa-border-strong)] text-board-text" },
  prep: { icon: ClipboardList, detail: "Within 48 hours of start", pill: "border-[var(--sa-border-strong)] text-board-text" },
  call: { icon: Users, detail: "Crew call — the team is on site", pill: "border-fire-500/40 bg-fire-500/10 text-fire-400" },
  live: { icon: Radio, detail: "Rundown running", pill: "border-[var(--sa-ok)]/40 bg-[var(--sa-ok)]/10 text-[var(--sa-ok)]" },
  debrief: { icon: NotebookPen, detail: "Show finished — notes and follow-ups", pill: "border-[var(--sa-border-strong)] text-board-text" },
};

type Timing = { scheduledStartMs: number | null; callTimeMs: number | null; expectedEndMs: number | null };

function clock(ms: number | null, timeZone?: string) {
  if (ms === null) return null;
  try { return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(ms); }
  catch { return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(ms); }
}

type Reason = { label: string; tone: "danger" | "warn"; to: string };

function readinessReasons(model: TmWidgetModel["model"]): Reason[] {
  const out: Reason[] = [];
  const critical = model.faults.filter((fault) => fault.severity === "critical").length;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (critical) out.push({ label: plural(critical, "critical incident", "critical incidents"), tone: "danger", to: "production/incidents" });
  else if (model.openCount) out.push({ label: plural(model.openCount, "open incident", "open incidents"), tone: "warn", to: "production/incidents" });
  if (model.signalPath.status === "fail") out.push({ label: "Stream setup failing", tone: "danger", to: "streaming/health" });
  else if (model.signalPath.status === "warn") out.push({ label: "Stream setup needs review", tone: "warn", to: "streaming/health" });
  if (model.equipmentFaults.length) {
    const dead = model.equipmentFaults.some((item) => item.status === "out-of-service");
    out.push({ label: `${plural(model.equipmentFaults.length, "equipment item needs", "equipment items need")} repair`, tone: dead ? "danger" : "warn", to: "production/assets" });
  }
  const prep = model.prep.filter((item) => item.id !== "prep:equipment-dead" && item.id !== "prep:lingering-faults");
  if (prep.length === 1) out.push({ label: `1 prep item: ${prep[0].title.replace(/ for this .*$/, "").replace(/^./, (c) => c.toLowerCase())}`, tone: prep[0].severity === "critical" ? "danger" : "warn", to: prep[0].actionPath });
  else if (prep.length > 1) out.push({ label: `${prep.length} prep items`, tone: prep.some((item) => item.severity === "critical") ? "danger" : "warn", to: prep[0].actionPath });
  const checksLeft = model.checks.reduce((total, check) => total + check.outstanding, 0);
  if (checksLeft && (model.phase === "call" || model.phase === "live")) out.push({ label: plural(checksLeft, "check left", "checks left"), tone: model.checks.some((check) => check.status === "fail") ? "danger" : "warn", to: "production/checklist" });
  return out;
}

function HealthOverview({ model, slug, timing, timeZone }: { model: TmWidgetModel["model"]; slug: string; timing: Timing; timeZone?: string }) {
  const meta = PHASE_META[model.phase], PhaseIcon = meta.icon;
  const critical = model.faults.filter((fault) => fault.severity === "critical").length;
  const checksLeft = model.checks.reduce((total, check) => total + check.outstanding, 0);
  const late = model.phase === "call" || model.phase === "live";
  const readiness = model.readiness === "fail"
    ? { label: "Needs attention", icon: TriangleAlert, tone: "danger" as Tone }
    : model.readiness === "warn" ? { label: "Review", icon: Eye, tone: "warn" as Tone } : { label: "Checks clear", icon: CircleCheck, tone: "ok" as Tone };
  const reasons = readinessReasons(model);
  const times: Partial<Record<ServicePhase, string | null>> = { call: clock(timing.callTimeMs, timeZone), live: clock(timing.scheduledStartMs, timeZone), debrief: clock(timing.expectedEndMs, timeZone) };
  const stats = [
    { label: model.incidentsTruncated ? "Critical incidents shown" : "Critical incidents", value: critical, caption: "Open, high or critical", tone: critical ? "danger" : "ok" },
    { label: model.incidentsTruncated ? "My incidents shown" : "My queue", value: model.mineCount, caption: "Open incidents assigned to you", tone: model.mineCount ? "warn" : "muted" },
    late
      ? { label: "Checks left", value: checksLeft, caption: `Across ${model.checks.length} ${model.checks.length === 1 ? "department" : "departments"}`, tone: checksLeft ? "warn" : "ok" }
      : { label: "To fix first", value: model.prep.length, caption: "Prep items before Call", tone: model.prep.length ? "warn" : "ok" },
  ] satisfies { label: string; value: number; caption: string; tone: Tone }[];
  const ReadyIcon = readiness.icon;
  return (
    <section aria-label="System overview" className="rounded-xl border border-[var(--sa-border)] bg-[var(--sa-surface)]">
      <div className="mx-5 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-[var(--sa-border)] py-4">
        <div className="flex items-center gap-3">
          <span className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold uppercase tracking-[0.06em] ${meta.pill}`}>
            <PhaseIcon aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={1.75} />{phaseLabel(model.phase)}
          </span>
          <span className="text-[13px] text-[var(--sa-ink-2)]">{meta.detail}</span>
        </div>
        <ol aria-label="Show phases" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
          {PHASES.map((phase, index) => (
            <li key={phase} className="flex items-center gap-2">
              {index ? <span aria-hidden="true" className="h-px w-3.5 bg-[var(--sa-border-strong)]" /> : null}
              <span aria-current={phase === model.phase ? "step" : undefined} className={phase === model.phase ? "font-semibold text-board-text" : "text-[var(--sa-ink-2)]"}>{phaseLabel(phase)}</span>
              {times[phase] ? <span className="tabular-nums text-[var(--sa-ink-3)]">{times[phase]}</span> : null}
            </li>
          ))}
        </ol>
      </div>
      <div className="grid grid-cols-1 gap-y-4 px-5 py-5 sm:grid-cols-3 xl:grid-cols-[minmax(0,1.55fr)_repeat(3,minmax(0,1fr))]">
        <div className="flex min-w-0 items-start gap-3 sm:col-span-3 xl:col-span-1 xl:pr-5">
          <ReadyIcon aria-hidden="true" className={`mt-4 h-4 w-4 shrink-0 ${toneText[readiness.tone]}`} strokeWidth={1.75} />
          <div className="min-w-0">
            <p className={tmEyebrow}>Readiness</p>
            <p className={`text-[17px] font-semibold ${toneText[readiness.tone]}`}>{readiness.label}</p>
            {reasons.length ? (
              <ul aria-label="Why" className="mt-2.5 flex flex-wrap gap-1.5">
                {reasons.map((reason) => (
                  <li key={reason.label}>
                    <Link to={`/${slug}/${reason.to}` as never} className="inline-flex min-h-7 items-center gap-1.5 rounded-full border border-[var(--sa-border-strong)] px-2.5 text-xs text-board-text hover:bg-[var(--sa-surface-2)] max-lg:min-h-11">
                      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${reason.tone === "danger" ? "bg-[var(--sa-danger)]" : "bg-[var(--sa-warn)]"}`} />
                      {reason.label}
                      <ArrowRight aria-hidden="true" className="h-3 w-3 text-[var(--sa-ink-3)]" />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
        {stats.map((stat, index) => (
          <div key={stat.label} className={`min-w-0 border-[var(--sa-border)] sm:border-l sm:px-5 ${index === 0 ? "sm:border-l-0 sm:pl-0 xl:border-l xl:pl-5" : ""}`}>
            <p className={tmEyebrow}>{stat.label}</p>
            <p className={`mt-1 text-[22px] font-semibold leading-tight tabular-nums ${toneText[stat.tone]}`}>{stat.value}</p>
            <p className="mt-0.5 text-xs text-[var(--sa-ink-2)]">{stat.caption}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── Arrange mode ────────────────────────────────────────────

/**
 * One status chip for the arrange bars: saved, saving, failed, changed
 * elsewhere or controls paused. Status only — the retry, review and compare
 * actions stay in the recovery notice above, so there is one place to act.
 */
function LayoutStatus({ control }: { control: TmManagementController }) {
  const item = control.latest("layout");
  if (control.read.isError) return <span role="status" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[var(--sa-danger)]"><Unplug aria-hidden="true" className="h-3.5 w-3.5" />{control.read.isFetching ? "Refreshing controls…" : "Controls paused: couldn't load dashboard controls"}</span>;
  if (!item?.attempt) return null;
  if (item.status === "pending") return <span role="status" className="inline-flex items-center gap-1.5 text-[13px] text-[var(--sa-ink-2)]"><Spinner />Saving layout…</span>;
  if (item.status === "error") return <span role="status" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[var(--sa-warn)]"><CloudOff aria-hidden="true" className="h-3.5 w-3.5" />Couldn't save — kept your last layout</span>;
  if (item.result?.outcome === "applied") return <span role="status" className="inline-flex items-center gap-1.5 text-[13px] text-[var(--sa-ink-2)]"><CircleCheck aria-hidden="true" className="h-3.5 w-3.5 text-[var(--sa-ok)]" />Layout saved</span>;
  return <span role="status" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[var(--sa-warn)]"><GitBranch aria-hidden="true" className="h-3.5 w-3.5" />Layout changed elsewhere</span>;
}

function ArrangeBar({ text, status, reset, locked }: { text: string; status: ReactNode; reset?: (locked: boolean) => ReactNode; locked: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-dashed border-[var(--sa-border-strong)] px-4 py-2.5">
      <GripVertical aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-[var(--sa-ink-3)]" />
      <p className="min-w-0 flex-1 text-[13px] text-[var(--sa-ink-2)]">{text}</p>
      <span className="ml-auto flex flex-wrap items-center gap-3">{status}{reset?.(locked)}</span>
    </div>
  );
}

function ReorderableSections({ order, sections, rail, editing, locked, onReorder }: {
  order: readonly string[];
  sections: Record<string, ReactNode>;
  rail: ReactNode;
  editing: boolean;
  locked: boolean;
  onReorder(order: string[]): void;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const visible = order.filter((id) => sections[id]);
  const move = (id: string, offset: number) => {
    const from = visible.indexOf(id), to = from + offset;
    if (from < 0 || to < 0 || to >= visible.length) return;
    const next = [...visible];
    [next[from], next[to]] = [next[to], next[from]];
    onReorder(next);
  };
  const dropOn = (targetId: string) => {
    setOver(null);
    if (!dragging || dragging === targetId) return;
    const next = visible.filter((id) => id !== dragging);
    next.splice(next.indexOf(targetId), 0, dragging);
    setDragging(null);
    onReorder(next);
  };
  const render = (id: string, index: number) => {
    const title = SECTION_TITLES[id] ?? id;
    return (
      <section key={id} aria-label={title}
        draggable={editing && !locked}
        onDragStart={() => setDragging(id)}
        onDragEnd={() => { setDragging(null); setOver(null); }}
        onDragOver={(event) => { if (editing && !locked) { event.preventDefault(); if (over !== id) setOver(id); } }}
        onDrop={() => dropOn(id)}
        className={`flex min-w-0 flex-col gap-2.5 ${editing && !locked ? "cursor-grab active:cursor-grabbing" : ""}`}>
        {editing && dragging && over === id && dragging !== id ? <span aria-hidden="true" className="h-1 rounded-full bg-fire-500" /> : null}
        {editing ? (
          <div className={`flex items-center gap-2.5 rounded-xl border px-3 py-1.5 ${dragging === id ? "border-board-text/60 bg-[var(--sa-surface-2)]" : "border-dashed border-[var(--sa-border-strong)]"}`}>
            <GripVertical aria-hidden="true" className="h-3.5 w-3.5 text-[var(--sa-ink-3)]" />
            <span className="text-[13px] font-semibold text-board-text">{title}</span>
            {dragging === id ? <span className="text-xs text-[var(--sa-ink-3)]">Moving</span> : null}
            <span className="ml-auto flex items-center gap-1">
              <button type="button" aria-label={`Move ${title} up`} disabled={index === 0 || locked} onClick={() => move(id, -1)} className={`${tmIconButton} border border-[var(--sa-border-strong)]`}><ChevronUp className="h-3.5 w-3.5" /></button>
              <button type="button" aria-label={`Move ${title} down`} disabled={index === visible.length - 1 || locked} onClick={() => move(id, 1)} className={`${tmIconButton} border border-[var(--sa-border-strong)]`}><ChevronDown className="h-3.5 w-3.5" /></button>
            </span>
          </div>
        ) : <p className={`${tmEyebrow} pt-1`}>{title}</p>}
        <div inert={editing && id !== "workspace"} className={editing && id !== "workspace" ? "opacity-60" : ""}>{sections[id]}</div>
      </section>
    );
  };
  // Full-width sections come first; from the first incident or operations
  // section on, the rail sits beside the rest. Arranging keeps every zone
  // in the left column so the order reads top to bottom.
  const split = editing ? 0 : Math.max(0, visible.findIndex((id) => RAIL_SECTIONS.has(id)));
  const top = visible.slice(0, split), rest = visible.slice(split);
  return (
    <div className="flex flex-col gap-5">
      {top.map((id) => render(id, visible.indexOf(id)))}
      {rest.length ? (
        <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_340px] min-[1800px]:grid-cols-[minmax(0,1fr)_380px]">
          {/* Wide screens: incidents and live operations sit side by side. */}
          <div className={`flex min-w-0 flex-col gap-5 ${editing || rest.length < 2 ? "" : "min-[1800px]:grid min-[1800px]:grid-cols-2 min-[1800px]:items-start"}`}>{rest.map((id) => render(id, visible.indexOf(id)))}</div>
          {rail ? <div className={`min-w-0 xl:sticky xl:top-6 ${editing ? "" : "xl:pt-[26px]"}`}>{rail}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function orderMainWidgets(widgets: TmWidget[], order: readonly string[]): TmWidget[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...widgets].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
}

function ReorderableMainWidgets({ widgets, widgetModel, editing, locked, status, onReorder }: {
  widgets: TmWidget[];
  widgetModel: TmWidgetModel;
  editing: boolean;
  locked: boolean;
  status: ReactNode;
  onReorder(order: string[]): void;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const ids = widgets.map((widget) => widget.id);
  const move = (id: string, offset: number) => {
    const from = ids.indexOf(id), to = from + offset;
    if (from < 0 || to < 0 || to >= ids.length) return;
    const next = [...ids];
    [next[from], next[to]] = [next[to], next[from]];
    onReorder(next);
  };
  const dropOn = (targetId: string) => {
    if (!dragging || dragging === targetId) return;
    const next = ids.filter((id) => id !== dragging);
    next.splice(next.indexOf(targetId), 0, dragging);
    setDragging(null);
    onReorder(next);
  };
  if (!widgets.length) return null;
  return (
    <div className="flex flex-col gap-3">
      {editing ? <ArrangeBar text="Drag widgets or use the arrow buttons. Changes save to your account." status={status} locked={locked}
        reset={l => l ? null : <button type="button" onClick={() => onReorder([...TM_LAYOUT_WIDGET_IDS])} className="inline-flex min-h-8 items-center px-2 text-[13px] font-medium text-[var(--sa-ink-2)] hover:text-board-text max-lg:min-h-11">Reset</button>} /> : null}
      {widgets.map((widget, index) => {
        const title = workspaceCopy(widget.title, widgetModel.terms);
        return (
          <div key={widget.id}
            draggable={editing && !locked}
            onDragStart={(event) => { event.stopPropagation(); setDragging(widget.id); }}
            onDragEnd={() => setDragging(null)}
            onDragOver={(event) => { if (editing && !locked) event.preventDefault(); }}
            onDrop={(event) => { event.stopPropagation(); dropOn(widget.id); }}
            className={`relative min-w-0 ${dragging === widget.id ? "opacity-45" : ""} ${editing && !locked ? "cursor-grab active:cursor-grabbing" : ""}`}>
            {editing ? (
              <div className="absolute right-2 top-2 z-[2] flex items-center gap-1 rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface)] pl-2">
                <GripVertical aria-hidden="true" className="h-3.5 w-3.5 text-[var(--sa-ink-3)]" />
                <span className="max-w-32 truncate text-xs text-[var(--sa-ink-2)]">{title}</span>
                <button type="button" aria-label={`Move ${title} up`} disabled={index === 0 || locked} onClick={() => move(widget.id, -1)} className={tmIconButton}><ChevronUp className="h-3.5 w-3.5" /></button>
                <button type="button" aria-label={`Move ${title} down`} disabled={index === widgets.length - 1 || locked} onClick={() => move(widget.id, 1)} className={tmIconButton}><ChevronDown className="h-3.5 w-3.5" /></button>
              </div>
            ) : null}
            <div inert={editing} className={editing ? "opacity-60" : ""}>{widget.render(widgetModel)}</div>
          </div>
        );
      })}
    </div>
  );
}

function FaultToolbar({ query, onQueryChange, value, onChange, counts }: {
  query: string;
  onQueryChange(value: string): void;
  value: "all" | "unowned" | "mine" | "critical";
  onChange(value: "all" | "unowned" | "mine" | "critical"): void;
  counts: Record<"all" | "unowned" | "mine" | "critical", number>;
}) {
  const views = ["all", "unowned", "mine", "critical"] as const;
  return (
    <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
      <div role="group" aria-label="Incident filters" className="grid grid-cols-2 gap-0.5 rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface)] p-0.5 sm:flex">
        {views.map((view) => (
          <button key={view} type="button" onClick={() => onChange(view)} aria-pressed={value === view}
            className={`inline-flex h-8 items-center justify-between gap-3 rounded-md px-3 text-[13px] capitalize sm:min-w-[84px] max-lg:h-11 ${value === view ? "bg-[var(--sa-surface-3)] font-medium text-board-text" : "text-[var(--sa-ink-2)] hover:text-board-text"}`}>
            {view}<span className="text-xs tabular-nums text-[var(--sa-ink-3)]">{counts[view]}</span>
          </button>
        ))}
      </div>
      <label className="flex h-9 items-center gap-2 rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface)] px-3 focus-within:border-board-text/60 md:w-[200px] max-lg:h-auto">
        <Search aria-hidden="true" className="h-3.5 w-3.5 text-[var(--sa-ink-3)]" />
        <input value={query} onChange={(event) => onQueryChange(event.target.value)} aria-label="Search incidents" placeholder="Search incidents"
          className="h-full w-full min-w-0 bg-transparent text-[13px] max-lg:min-h-11 text-board-text outline-none placeholder:text-[var(--sa-ink-3)]" />
      </label>
    </div>
  );
}
