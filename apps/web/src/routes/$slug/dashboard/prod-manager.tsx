import { hasPermission } from "@/lib/app-permissions";
import { RelaySyncNotice } from "@/components/RelaySyncNotice";
import { useTerms } from "@/components/workspace/WorkspaceProvider";
import {
  createFileRoute,
  Link,
  useNavigate,
} from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { getPmDashboard } from "@/lib/pm-dashboard";
import { formatCountdown } from "@/lib/pm-dashboard-derive";
import { phaseLabel, type ServicePhase } from "@/lib/service-phase";
import { ShowSwitcherMenu } from "@/components/show-switcher-menu";
import { useDeviceTimeZone } from "@/hooks/useDeviceTimeZone";
import {
  PM_WIDGETS,
  type PmWidgetModel,
} from "@/components/dashboard/pm-widgets";
import {
  PlanServiceButton,
  PlanServicePanel,
} from "@/components/dashboard/plan-service";
import { useOperatorRead } from "@/hooks/useOperatorRead";
import { ReadFailureNotice } from "@/components/layout/ReadFailureNotice";
import { runRouteLoad } from "@/lib/route-load-deadlines";
import {
  healthTextClass,
  selectWidgets,
  useNow,
  widgetsInRegion,
} from "@/components/dashboard/widget";
import { useCueSheetSync } from "@/hooks/useCueSheetSync";
import { Download, RefreshCw } from "lucide-react";

const PHASE_CHIP: Record<ServicePhase, string> = {
  planning: "bg-board-bg text-board-muted border-board-border",
  prep: "bg-yellow-400/10 text-yellow-300 border-yellow-400/25",
  call: "bg-fire-500/15 text-fire-400 border-fire-500/30",
  live: "bg-red-500/15 text-red-400 border-red-500/30",
  debrief: "bg-blue-500/10 text-blue-300 border-blue-500/25",
};

export const Route = createFileRoute("/$slug/dashboard/prod-manager")({
  validateSearch: (search: Record<string, unknown>) => ({
    date: typeof search.date === "string" ? search.date : undefined,
    show: typeof search.show === "string" ? search.show : undefined,
  }),
  loaderDeps: ({ search }) => ({ date: search.date, showId: search.show }),
  pendingMs: 800,
  pendingMinMs: 100,
  pendingComponent: () => <PageSkeleton />,
  loader: async ({ context, deps, abortController }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(
      context.role,
      "dashboard:pm",
      context.slug,
      context.orgId,
    );
    return await getPmDashboard({
      data: { orgId: context.orgId, serviceDate: deps.date, showId: deps.showId }, signal: abortController.signal,
    });
  },
  component: ProdManagerPage,
});

function ProdManagerPage() {
  const initial = Route.useLoaderData();
  const { user } = Route.useRouteContext();
  return <ProdManagerWorkspace key={`${user.id}:${initial.orgId}:${initial.showId}`} initial={initial} />;
}
function ProdManagerWorkspace({ initial }: { initial: Awaited<ReturnType<typeof getPmDashboard>> }) {
  const search = Route.useSearch();
  const load = useCallback((signal: AbortSignal) => getPmDashboard({ data: { orgId: initial.orgId, serviceDate: search.date, showId: search.show }, signal }), [initial.orgId, search.date, search.show]);
  const read = useOperatorRead({ key: JSON.stringify(initial), initialValue: initial, read: load, intervalMs: 20_000, errorMessage: "Production dashboard could not refresh. Last confirmed values are shown. Retry to check readiness." });
  const { model, rundownState, shows, showId, orgId, orgTimezone } = read.value;
  const deviceTimeZone = useDeviceTimeZone();
  const timeZone = orgTimezone || deviceTimeZone;
  const { slug } = Route.useParams();
  const navigate = useNavigate({ from: Route.fullPath });
  const [planOpen, setPlanOpen] = useState(false);
  const { syncError, syncErrorAt, status: syncStatus, retrySync } = useCueSheetSync({
    orgId,
    scope: showId ?? "",
    onNote: () => {},
    onRefresh: async () => { await read.refresh(); },
    onIncident: read.invalidate,
  });

  const {user,role} = Route.useRouteContext();
  const widgetModel: PmWidgetModel = {
    userId: user.id,
    canManageDuty: hasPermission(role,"settings:members"),
    terms: useTerms(),
    model,
    rundownState,
    slug,
    orgId,
    showId,
  };
  const widgets = selectWidgets(PM_WIDGETS, model.phase, widgetModel);
  const banners = widgetsInRegion(widgets, "banner");
  const main = widgetsInRegion(widgets, "main");
  const rail = widgetsInRegion(widgets, "rail");

  return (
    <div className="h-full overflow-auto overscroll-y-none bg-board-bg">
      <RelaySyncNotice error={syncError} occurredAt={syncErrorAt} status={syncStatus} onRetry={retrySync} />
      {/* Wrap on narrow screens so controls remain reachable without horizontal scrolling. */}
      <header className="lg:sticky lg:top-0 z-10 bg-board-bg/85 backdrop-blur-xl border-b border-board-border">
        <div className="relative">
          <div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-3 min-w-0 px-3 sm:px-6 py-3">
              <h1 className="text-[15px] font-semibold text-board-text font-[family-name:var(--font-display)] shrink-0 whitespace-nowrap">
                Production Manager
              </h1>
              <span
                className={`shrink-0 text-xs font-medium uppercase tracking-[0.12em] px-2 py-0.5 rounded border ${PHASE_CHIP[model.phase]}`}
              >
                {phaseLabel(model.phase)}
              </span>

              <ShowSwitcherMenu
                selectedId={showId}
                shows={shows}
                timeZone={timeZone}
                onSelect={(selected) => void navigate({ search: { date: selected.serviceDate, show: selected.id } })}
              />

              {model.timing.scheduledStartMs !== null && (
                <span className="text-xs text-board-muted tabular-nums shrink-0 whitespace-nowrap">
                  call {formatClock(model.timing.callTimeMs, timeZone)} · start{" "}
                  {formatClock(model.timing.scheduledStartMs, timeZone)}
                </span>
              )}

              <PlanServiceButton
                open={planOpen}
                onToggle={() => setPlanOpen((v) => !v)}
              />
              <ShowReportButton key={showId ?? model.serviceDate} orgId={orgId} serviceDate={model.serviceDate} showId={showId} />
              <button type="button" aria-label="Refresh dashboard" disabled={read.refreshing} onClick={read.retry} className="min-h-11 min-w-11 inline-flex items-center justify-center rounded-lg border border-board-border text-board-muted focus-visible:outline-2 disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${read.refreshing ? "animate-spin" : ""}`} /></button>

              <div className="ml-auto flex items-center gap-5 shrink-0 pl-4">
                {/* A countdown with nothing to count toward is dead space in
                the most prominent slot on the page. Offer the fix. */}
                {model.countdown.targetMs === null && model.countdown.remainingMs === null ? (
                  <Link
                    to={
                      `/${slug}/rundown` as unknown as Parameters<
                        typeof Link
                      >[0]["to"]
                    }
                    className="inline-flex items-center min-h-11 shrink-0 whitespace-nowrap text-xs px-2.5 py-1.5 rounded border border-board-border/70 text-board-muted hover:text-board-text hover:border-board-border transition-colors"
                  >
                    Set a start time
                  </Link>
                ) : (
                  <LiveCountdown countdown={model.countdown} />
                )}
                <span className="w-px h-8 bg-board-border" aria-hidden="true" />
                <div className="text-right leading-none">
                  <p
                    className={`text-[22px] font-semibold tabular-nums ${healthTextClass(model.readiness.status)}`}
                  >
                    {model.readiness.score}%
                  </p>
                  <p className="text-xs text-board-muted mt-1">ready</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {planOpen && (
          <div className="px-6 pb-3">
            <PlanServicePanel
              orgId={orgId}
              userId={user.id}
              shows={shows}
              onClose={() => setPlanOpen(false)}
              onPlanned={(plannedShowId, plannedDate) => navigate({ search: { date: plannedDate, show: plannedShowId } })}
            />
          </div>
        )}
      </header>

      <ReadFailureNotice error={read.error} refreshing={read.refreshing} retry={read.retry} label="Retry dashboard" />
      {read.refreshing && !read.error ? <p role="status" className="px-3 sm:px-6 py-2 text-sm text-board-muted">Refreshing dashboard… Last confirmed values remain visible.</p> : null}
      {/* Banners span the width; below them a wide reading column and a
          fixed rail. No spans, so no ragged rows and no dead space. */}
      <div className="px-3 sm:px-6 py-5 w-full max-w-[1500px] space-y-4">
        {banners.map((widget) => (
          <div key={widget.id}>{widget.render(widgetModel)}</div>
        ))}

        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-4 items-start">
          <div className="space-y-4 min-w-0">
            {main.map((widget) => (
              <div key={widget.id}>{widget.render(widgetModel)}</div>
            ))}
          </div>
          <div className="space-y-4 min-w-0">
            {rail.map((widget) => (
              <div key={widget.id}>{widget.render(widgetModel)}</div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function LiveCountdown({
  countdown,
}: {
  countdown: PmWidgetModel["model"]["countdown"];
}) {
  const now = useNow(1000);
  const displayMs = now === null || countdown.targetMs === null
    ? countdown.remainingMs
    : countdown.direction === "up"
      ? now - countdown.targetMs
      : countdown.targetMs - now;
  return (
    <div className="text-right leading-none">
      <p className="text-[22px] font-semibold tabular-nums text-board-text">{formatCountdown(displayMs ?? 0)}</p>
      <p className="mt-1 text-xs text-board-muted">{countdown.label}</p>
    </div>
  );
}

function ShowReportButton({
  orgId,
  serviceDate,
  showId,
}: {
  orgId: string;
  serviceDate: string;
  showId: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { active.current?.abort(); active.current = null; }, []);
  async function generate() {
    if (active.current) return;
    const owner = new AbortController(); active.current = owner;
    setBusy(true); setError(null);
    try {
      await runRouteLoad(async controller => {
        const [{ exportShowReport }, { exportRundownPdf }] = await Promise.all([import("@/lib/report"), import("@/lib/rundown-export")]);
        controller.signal.throwIfAborted();
        const report = await exportShowReport({ data: { orgId, serviceDate, showId: showId ?? undefined }, signal: controller.signal });
        controller.signal.throwIfAborted();
        await exportRundownPdf(report, controller.signal);
      }, owner.signal, 15_000);
    } catch {
      if (active.current === owner) setError("Report could not be generated. Retry to download the current show report.");
    } finally {
      owner.abort();
      if (active.current === owner) { active.current = null; setBusy(false); }
    }
  }
  return (
    <div className="flex flex-wrap min-w-0 items-center gap-2">
      <button
        type="button"
        onClick={() => void generate()}
        disabled={busy}
        className="inline-flex min-h-11 items-center gap-1.5 rounded border border-board-border/70 px-2.5 py-1.5 text-xs text-board-muted transition-colors hover:border-board-border hover:text-board-text disabled:opacity-50"
      >
        <Download className="h-3.5 w-3.5" />
        {busy ? "Generating…" : error ? "Retry report" : "Show report"}
      </button>
      {error ? (
        <span
          role="alert"
          className="max-w-sm text-sm text-red-400"
        >
          {error}
        </span>
      ) : null}
    </div>
  );
}

function formatClock(ms: number | null, timeZone: string): string {
  if (ms === null) return "--:--";
  return new Date(ms).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });
}
