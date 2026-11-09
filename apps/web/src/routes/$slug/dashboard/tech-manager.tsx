import { RelaySyncNotice } from "@/components/RelaySyncNotice";
import { workspaceCopy } from "@showpilot/shared";
import { useTerms } from "@/components/workspace/WorkspaceProvider";
/**
 * Tech manager dashboard.
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

import {
  createFileRoute,
  useNavigate,
} from "@tanstack/react-router";
import {
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Clock3,
  GripVertical,
  LayoutDashboard,
  Radio,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  UserRoundCheck,
} from "lucide-react";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { getTmDashboard } from "@/lib/tm-dashboard";
import { phaseLabel, type ServicePhase } from "@/lib/service-phase";
import { ShowSwitcherMenu } from "@/components/show-switcher-menu";
import {
  TM_WIDGETS,
  type TmWidget,
  type TmWidgetModel,
} from "@/components/dashboard/tm-widgets";
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
import { useTmManagement } from "@/hooks/useTmManagement";
import { TmManagementRecovery } from "@/components/dashboard/TmManagementRecovery";
import { useOperatorRead } from "@/hooks/useOperatorRead";
import { ReadFailureNotice } from "@/components/layout/ReadFailureNotice";
import { useNow } from "@/components/dashboard/widget";
import { useCueSheetSync } from "@/hooks/useCueSheetSync";

const PHASE_CHIP: Record<ServicePhase, string> = {
  planning: "bg-board-bg text-board-muted border-board-border",
  prep: "bg-yellow-400/10 text-yellow-300 border-yellow-400/25",
  call: "bg-fire-500/15 text-fire-400 border-fire-500/30",
  live: "bg-red-500/15 text-red-400 border-red-500/30",
  debrief: "bg-blue-500/10 text-blue-300 border-blue-500/25",
};

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
    await withPermission(
      context.role,
      "dashboard:tm",
      context.slug,
      context.orgId,
    );
    const [dashboard, management] = await Promise.all([
      getTmDashboard({
        data: { orgId: context.orgId, serviceDate: deps.date, showId: deps.show }, signal: abortController.signal,
      }),
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
function TechManagerWorkspace({ initial }: { initial: Awaited<ReturnType<typeof getTmDashboard>> & { management: TmManagementState } }) {
  const search = Route.useSearch();
  const { management, ...snapshot } = initial;
  const load = useCallback((signal: AbortSignal) => getTmDashboard({ data: { orgId: initial.orgId, serviceDate: search.date, showId: search.show }, signal }), [initial.orgId, search.date, search.show]);
  const read = useOperatorRead({ key: JSON.stringify(snapshot), initialValue: snapshot, read: load, intervalMs: 10_000, errorMessage: "Technical dashboard could not refresh. Last confirmed values are shown. Retry before changing incidents." });
  const now = useNow(1_000);
  const {
    model,
    orgId,
    showId,
    shows,
    orgTimezone,
    viewerId,
    members,
    liveInputs,
    streamDestinations,
  } = read.value;
  const { slug } = Route.useParams();
  const navigate = useNavigate({ from: Route.fullPath });
  const [query, setQuery] = useState("");
  const [faultView, setFaultView] = useState<
    "all" | "unowned" | "mine" | "critical"
  >("all");
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
  const layout = control.layout;
  const layoutLocked = control.unresolved("layout") || control.unavailable;
  const act = (faultId: string, action: "assign" | "acknowledge" | "resolve", assignedTo: string | null = null) => {
    if (read.refreshing || read.error || editingLayout || !control.read.data.canManageIncidents) return;
    const fault = model.faults.find(item => item.id === faultId);
    if (!fault) return;
    const operation: TmManagementCommand["operation"] = action === "assign"
      ? { kind: "assign", id: faultId, assignedTo, expectedRevision: fault.revision }
      : { kind: action, id: faultId, expectedRevision: fault.revision };
    control.send(operation, `${action === "assign" ? assignedTo ? "Assign" : "Release" : action === "resolve" ? "Resolve" : "Acknowledge"} incident: ${fault.description}`);
  };

  const filteredModel = useMemo(
    () => ({
      ...model,
      faults: model.faults.filter((fault) => {
        const viewMatches =
          faultView === "all" ||
          (faultView === "unowned" &&
            (fault.ownership === "unassigned" || fault.stale)) ||
          (faultView === "mine" && fault.ownership === "mine") ||
          (faultView === "critical" && fault.severity === "critical");
        const needle = query.trim().toLowerCase();
        const searchable = `${fault.description} ${fault.departmentLabel} ${fault.assignedName}`;
        return (
          viewMatches && (!needle || searchable.toLowerCase().includes(needle))
        );
      }),
    }),
    [faultView, model, query],
  );

  const widgetModel: TmWidgetModel = {
    terms: useTerms(),
    model: filteredModel,
    slug,
    orgId,
    viewerId,
    canAssignPeople: control.read.data.canAssignPeople,
    canClaimFaults: control.read.data.canManageIncidents,
    members,
    busyId: null,
    readUnavailable: read.refreshing || !!read.error || editingLayout || control.unavailable || control.unresolved("incident"),
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

  const workspaceContent = (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_300px] gap-4 items-start">
      <div className="space-y-4 min-w-0">
        <FaultToolbar
          query={query}
          onQueryChange={setQuery}
          value={faultView}
          onChange={setFaultView}
          counts={{
            all: model.openCount,
            unowned: model.unownedCount,
            mine: model.mineCount,
            critical: model.faults.filter(
              (fault) => fault.severity === "critical",
            ).length,
          }}
        />
        <ReorderableMainWidgets
          widgets={orderedMain}
          widgetModel={widgetModel}
          editing={editingLayout}
          locked={layoutLocked}
          onReorder={(mainOrder) =>
            void persistLayout({
              ...layout,
              main: mainOrder as TmDashboardLayout["main"],
            })
          }
        />
      </div>
      <div className="space-y-4 min-w-0">
        {rail.map((widget) => (
          <div key={widget.id}>{widget.render(widgetModel)}</div>
        ))}
      </div>
    </div>
  );
  return (
    <div className="h-full overflow-auto">
      <RelaySyncNotice error={syncError} occurredAt={syncErrorAt} status={syncStatus} onRetry={retrySync} />
      <header className="lg:sticky lg:top-0 z-10 bg-board-bg/85 backdrop-blur-xl border-b border-board-border">
        <div className="flex items-center gap-3 flex-wrap px-3 sm:px-6 py-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-8 h-8 rounded-lg bg-fire-500/10 border border-fire-500/20 flex items-center justify-center">
              <Radio className="w-4 h-4 text-fire-400" aria-hidden="true" />
            </span>
            <div>
              <h1 className="text-[15px] leading-none font-semibold text-board-text font-[family-name:var(--font-display)]">
                Tech Manager
              </h1>
              <p className="text-xs text-board-muted mt-1">
                Technical readiness: incidents, equipment and live systems
              </p>
            </div>
          </div>
          <span
            className={`text-xs font-medium uppercase tracking-[0.12em] px-2 py-0.5 rounded border ${PHASE_CHIP[model.phase]}`}
          >
            {phaseLabel(model.phase)}
          </span>
          <ShowSwitcherMenu
            selectedId={showId}
            shows={shows}
            timeZone={orgTimezone}
            onSelect={(selected) => void navigate({ search: { date: selected.serviceDate, show: selected.id } })}
          />

          <div className="ml-auto flex flex-wrap items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setEditingLayout((value) => !value)}
              className={`inline-flex items-center gap-1.5 min-h-11 px-2.5 rounded-lg border text-xs transition-colors ${editingLayout ? "border-fire-500/40 bg-fire-500/10 text-fire-400" : "border-board-border text-board-muted hover:text-board-text"}`}
            >
              <LayoutDashboard className="w-3.5 h-3.5" />
              {editingLayout ? "Done arranging" : "Arrange widgets"}
            </button>
            <div className="hidden md:flex items-center gap-1.5 text-xs text-board-muted">
              <Clock3 className="w-3 h-3" />
              {read.confirmedAt === null ? "Loaded dashboard" : `Confirmed ${formatFreshness(read.confirmedAt, now)}`}
            </div>
            <button
              type="button"
              aria-label="Refresh dashboard"
              disabled={read.refreshing}
              onClick={read.retry}
              className="min-w-11 min-h-11 shrink-0 rounded-lg border border-board-border text-board-muted hover:text-board-text hover:bg-board-card flex items-center justify-center focus-visible:outline-2 disabled:opacity-50"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${read.refreshing ? "animate-spin" : ""}`}
              />
            </button>
            <div className="text-right leading-none">
              <p
                className={`text-[22px] font-semibold tabular-nums ${
                  model.unownedCount > 0
                    ? "text-red-400"
                    : model.openCount > 0
                      ? "text-yellow-400"
                      : "text-green-400"
                }`}
              >
                {model.openCount}{model.incidentsTruncated ? "+" : ""}
              </p>
              <p className="text-xs text-board-muted mt-1">
                {model.unownedCount > 0
                  ? `${model.unownedCount} unowned`
                  : "open incidents"}
              </p>
            </div>
            {model.prep.length > 0 && (
              <div className="text-right leading-none">
                <p className="text-[22px] font-semibold tabular-nums text-yellow-400">
                  {model.prep.length}
                </p>
                <p className="text-xs text-board-muted mt-1">
                  to fix first
                </p>
              </div>
            )}
          </div>
        </div>
      </header>

      <ReadFailureNotice error={read.error} refreshing={read.refreshing} retry={read.retry} label="Retry dashboard" />
      {read.refreshing && !read.error ? <p role="status" className="px-3 sm:px-6 py-2 text-sm text-board-muted">Refreshing dashboard… Last confirmed values remain visible.</p> : null}
      <TmManagementRecovery control={control} />

      <div className="px-3 sm:px-6 py-5 w-full max-w-[1500px] space-y-4">
        <ReorderableSections
          editing={editingLayout}
          locked={layoutLocked}
          order={layout.sections}
          onReorder={(sections) =>
            void persistLayout({
              ...layout,
              sections: sections as TmDashboardLayout["sections"],
            })
          }
          sections={{
            overview: {
              title: "System overview",
              content: <HealthOverview model={model} />,
            },
            operations: {
              title: "Live operations",
              content: (
                <TmOperations
                  userId={viewerId}
                  orgId={orgId}
                  slug={slug}
                  inputs={liveInputs}
                  destinations={streamDestinations}
                />
              ),
            },
            "signal-path": {
              title: "Stream setup",
              content: (
                <>
                  {banners.map((widget) => (
                    <div key={widget.id}>{widget.render(widgetModel)}</div>
                  ))}
                </>
              ),
            },
            workspace: { title: "Incident workspace", content: workspaceContent },
          }}
        />
      </div>
    </div>
  );
}

function HealthOverview({ model }: { model: TmWidgetModel["model"] }) {
  const critical = model.faults.filter(
    (fault) => fault.severity === "critical",
  ).length;
  const checksLeft = model.checks.reduce(
    (total, check) => total + check.outstanding,
    0,
  );
  const overall = model.readiness === "fail" ? "Needs attention" : model.readiness === "warn" ? "Review" : "Checks clear";
  const tone = model.readiness === "fail" ? "text-red-400" : model.readiness === "warn" ? "text-yellow-400" : "text-green-400";
  const metrics = [
    { label: "Readiness", value: overall, icon: ShieldCheck, tone },
    {
      label: model.incidentsTruncated ? "Critical incidents shown" : "Critical incidents",
      value: String(critical),
      icon: AlertTriangle,
      tone: critical ? "text-red-400" : "text-board-text",
    },
    {
      label: model.incidentsTruncated ? "My incidents shown" : "My queue",
      value: String(model.mineCount),
      icon: UserRoundCheck,
      tone: model.mineCount ? "text-fire-400" : "text-board-text",
    },
    {
      label: "Checks left",
      value: String(checksLeft),
      icon: Clock3,
      tone: checksLeft ? "text-yellow-400" : "text-board-text",
    },
  ];
  return (
    <section className="grid grid-cols-2 lg:grid-cols-4 rounded-xl border border-board-border bg-board-card overflow-hidden">
      {metrics.map((metric, index) => (
        <div
          key={metric.label}
          className={`px-4 py-3.5 flex items-center gap-3 ${index ? "border-l border-board-border" : ""} ${index > 1 ? "border-t lg:border-t-0" : ""}`}
        >
          <metric.icon className={`w-4 h-4 shrink-0 ${metric.tone}`} />
          <div className="min-w-0">
            <p
              className={`text-lg leading-none font-semibold tabular-nums ${metric.tone}`}
            >
              {metric.value}
            </p>
            <p className="text-xs uppercase tracking-[0.1em] text-board-muted mt-1.5">
              {metric.label}
            </p>
          </div>
        </div>
      ))}
    </section>
  );
}

function orderMainWidgets(
  widgets: TmWidget[],
  order: readonly string[],
): TmWidget[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...widgets].sort(
    (a, b) =>
      (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
}

function ReorderableSections({
  order,
  sections,
  editing,
  locked,
  onReorder,
}: {
  order: readonly string[];
  sections: Record<string, { title: string; content: ReactNode }>;
  editing: boolean;
  locked: boolean;
  onReorder(order: string[]): void;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const visible = order.filter((id) => sections[id]);
  const move = (id: string, offset: number) => {
    const from = visible.indexOf(id);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= visible.length) return;
    const next = [...visible];
    [next[from], next[to]] = [next[to], next[from]];
    onReorder(next);
  };
  const dropOn = (targetId: string) => {
    if (!dragging || dragging === targetId) return;
    const next = visible.filter((id) => id !== dragging);
    next.splice(next.indexOf(targetId), 0, dragging);
    setDragging(null);
    onReorder(next);
  };
  return (
    <div className="space-y-4">
      {editing ? (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-fire-500/35 bg-fire-500/5 text-xs text-board-muted">
          <GripVertical className="w-3.5 h-3.5 text-fire-400" />
          <span>
            Arrange the major dashboard zones. Operational controls are locked
            while arranging.
          </span>
          {locked ? (
            <span className="ml-auto text-fire-400">Changes paused</span>
          ) : (
            <button
              type="button"
              onClick={() => onReorder([...TM_LAYOUT_SECTION_IDS])}
              className="ml-auto min-h-11 inline-flex items-center gap-1 hover:text-board-text"
            >
              <RotateCcw className="w-3 h-3" />
              Reset all
            </button>
          )}
        </div>
      ) : null}
      {visible.map((id, index) => {
        const section = sections[id];
        return (
          <div
            key={id}
            draggable={editing && !locked}
            onDragStart={() => setDragging(id)}
            onDragEnd={() => setDragging(null)}
            onDragOver={(event) => {
              if (editing && !locked) event.preventDefault();
            }}
            onDrop={() => dropOn(id)}
            className={`relative transition-all ${editing ? "rounded-xl ring-1 ring-board-border hover:ring-fire-500/40 cursor-grab active:cursor-grabbing" : ""} ${dragging === id ? "opacity-45 scale-[.99]" : ""}`}
          >
            {editing ? (
              <div className="relative z-20 mb-2 flex flex-wrap items-center rounded-lg border border-board-border bg-board-bg/95 shadow-lg">
                <span className="px-2 text-xs text-board-muted">
                  {section.title}
                </span>
                <button
                  type="button"
                  aria-label={`Move ${section.title} up`}
                  disabled={index === 0 || locked}
                  onClick={() => move(id, -1)}
                  className="min-w-11 min-h-11 flex items-center justify-center text-board-muted hover:text-board-text disabled:opacity-25"
                >
                  <ChevronUp className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={`Move ${section.title} down`}
                  disabled={index === visible.length - 1 || locked}
                  onClick={() => move(id, 1)}
                  className="min-w-11 min-h-11 flex items-center justify-center text-board-muted hover:text-board-text disabled:opacity-25"
                >
                  <ChevronDown className="w-3.5 h-3.5" />
                </button>
                <GripVertical className="w-3.5 h-3.5 mr-2 text-fire-400" />
              </div>
            ) : null}
            <div inert={editing && id !== "workspace"}>
              {section.content}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ReorderableMainWidgets({
  widgets,
  widgetModel,
  editing,
  locked,
  onReorder,
}: {
  widgets: TmWidget[];
  widgetModel: TmWidgetModel;
  editing: boolean;
  locked: boolean;
  onReorder(order: string[]): void;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const ids = widgets.map((widget) => widget.id);
  const move = (id: string, offset: number) => {
    const from = ids.indexOf(id);
    const to = from + offset;
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
    <div className="space-y-4">
      {editing ? (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-fire-500/35 bg-fire-500/5 text-xs text-board-muted">
          <GripVertical className="w-3.5 h-3.5 text-fire-400" />
          <span>
            Drag widgets or use the arrow buttons. Changes save to your account.
          </span>
          {locked ? (
            <span className="ml-auto text-fire-400">Changes paused</span>
          ) : (
            <button
              type="button"
              onClick={() => onReorder([...TM_LAYOUT_WIDGET_IDS])}
              className="ml-auto min-h-11 inline-flex items-center gap-1 text-board-muted hover:text-board-text"
            >
              <RotateCcw className="w-3 h-3" />
              Reset
            </button>
          )}
        </div>
      ) : null}
      {widgets.map((widget, index) => (
        <div
          key={widget.id}
          draggable={editing && !locked}
          onDragStart={(event) => { event.stopPropagation(); setDragging(widget.id); }}
          onDragEnd={() => setDragging(null)}
          onDragOver={(event) => {
            if (editing && !locked) event.preventDefault();
          }}
          onDrop={(event) => { event.stopPropagation(); dropOn(widget.id); }}
          className={`relative transition-all ${editing ? "rounded-xl ring-1 ring-board-border hover:ring-fire-500/40 cursor-grab active:cursor-grabbing" : ""} ${dragging === widget.id ? "opacity-45 scale-[.99]" : ""}`}
        >
          {editing ? (
            <div className="relative z-[2] mb-2 flex flex-wrap items-center rounded-lg border border-board-border bg-board-bg/95 shadow-lg">
              <span className="px-2 text-xs text-board-muted max-w-28 truncate">
                {workspaceCopy(widget.title, widgetModel.terms)}
              </span>
              <button
                type="button"
                aria-label={`Move ${workspaceCopy(widget.title, widgetModel.terms)} up`}
                disabled={index === 0 || locked}
                onClick={() => move(widget.id, -1)}
                className="min-w-11 min-h-11 flex items-center justify-center text-board-muted hover:text-board-text disabled:opacity-25"
              >
                <ChevronUp className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                aria-label={`Move ${workspaceCopy(widget.title, widgetModel.terms)} down`}
                disabled={index === widgets.length - 1 || locked}
                onClick={() => move(widget.id, 1)}
                className="min-w-11 min-h-11 flex items-center justify-center text-board-muted hover:text-board-text disabled:opacity-25"
              >
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
              <GripVertical className="w-3.5 h-3.5 mr-2 text-fire-400" />
            </div>
          ) : null}
          <div inert={editing}>
            {widget.render(widgetModel)}
          </div>
        </div>
      ))}
    </div>
  );
}

function FaultToolbar({
  query,
  onQueryChange,
  value,
  onChange,
  counts,
}: {
  query: string;
  onQueryChange(value: string): void;
  value: "all" | "unowned" | "mine" | "critical";
  onChange(value: "all" | "unowned" | "mine" | "critical"): void;
  counts: Record<"all" | "unowned" | "mine" | "critical", number>;
}) {
  const views = ["all", "unowned", "mine", "critical"] as const;
  return (
    <div className="flex flex-col md:flex-row md:items-center gap-2 p-1.5 rounded-xl border border-board-border bg-board-card/70">
      <div className="flex items-center gap-1 overflow-x-auto">
        {views.map((view) => (
          <button
            key={view}
            onClick={() => onChange(view)}
            aria-pressed={value === view}
            className={`min-h-11 shrink-0 px-3 py-1.5 rounded-lg text-xs capitalize transition-colors ${value === view ? "bg-board-text text-board-bg font-medium" : "text-board-muted hover:text-board-text"}`}
          >
            {view}
            <span className="ml-1.5 opacity-60 tabular-nums">
              {counts[view]}
            </span>
          </button>
        ))}
      </div>
      <label className="md:ml-auto flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-board-bg border border-board-border focus-within:border-fire-500/50">
        <Search className="w-3.5 h-3.5 text-board-muted" />
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          aria-label="Search incidents"
          placeholder="Search incidents"
          className="min-h-11 w-full md:w-44 bg-transparent text-xs text-board-text placeholder:text-board-muted outline-none"
        />
      </label>
    </div>
  );
}

function formatFreshness(timestamp: number, now: number | null): string {
  const seconds = Math.max(0, Math.round(((now ?? timestamp) - timestamp) / 1000));
  return seconds < 5 ? "just now" : `${seconds}s ago`;
}
