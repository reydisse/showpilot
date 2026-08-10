import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { getPmDashboard } from "@/lib/pm-dashboard";
import { formatCountdown } from "@/lib/pm-dashboard-derive";
import { phaseLabel, type ServicePhase } from "@/lib/service-phase";
import { PM_WIDGETS, type PmWidgetModel } from "@/components/dashboard/pm-widgets";
import {
  healthTextClass,
  selectWidgets,
  useNow,
  widgetSpanClass,
} from "@/components/dashboard/widget";

/** How often the loader re-reads. Live services need a tighter loop. */
const REFRESH_MS: Record<ServicePhase, number> = {
  planning: 300_000,
  prep: 120_000,
  call: 30_000,
  live: 20_000,
  debrief: 120_000,
};

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
  }),
  loaderDeps: ({ search }) => ({ date: search.date }),
  pendingComponent: () => <PageSkeleton />,
  loader: async ({ context, deps }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, "dashboard:pm", context.slug, context.orgId);
    return await getPmDashboard({
      data: { orgId: context.orgId, serviceDate: deps.date },
    });
  },
  component: ProdManagerPage,
});

function ProdManagerPage() {
  const { model, serviceDates } = Route.useLoaderData();
  const { slug } = Route.useParams();
  const router = useRouter();
  const navigate = useNavigate({ from: Route.fullPath });
  const now = useNow(1000);

  // Server data ages; the countdown does not. Re-read on a cadence that
  // matches the phase rather than making the operator hit reload.
  useEffect(() => {
    const interval = REFRESH_MS[model.phase];
    const id = setInterval(() => {
      void router.invalidate();
    }, interval);
    return () => clearInterval(id);
  }, [model.phase, router]);

  const widgetModel: PmWidgetModel = { model, slug };
  const widgets = selectWidgets(PM_WIDGETS, model.phase, widgetModel);

  const remaining = model.countdown.remainingMs;
  const liveRemaining =
    model.countdown.targetMs === null
      ? null
      : model.countdown.direction === "up"
        ? now - model.countdown.targetMs
        : model.countdown.targetMs - now;
  const displayMs = liveRemaining ?? remaining;

  return (
    <div className="h-full overflow-auto">
      <header className="sticky top-0 z-10 bg-board-bg/80 backdrop-blur-xl border-b border-board-border px-6 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <h1 className="text-lg font-semibold text-board-text font-[family-name:var(--font-display)]">
                Production Manager
              </h1>
              <span
                className={`text-[10px] font-medium uppercase tracking-widest px-2 py-0.5 rounded-lg border ${PHASE_CHIP[model.phase]}`}
              >
                {phaseLabel(model.phase)}
              </span>
            </div>
            <div className="flex items-center gap-2 mt-1.5">
              <label htmlFor="pm-service-date" className="sr-only">
                Service date
              </label>
              <select
                id="pm-service-date"
                value={model.serviceDate}
                onChange={(event) => {
                  void navigate({ search: { date: event.target.value } });
                }}
                className="text-xs bg-board-card border border-board-border rounded-lg px-2 py-1 text-board-text"
              >
                {(serviceDates.includes(model.serviceDate)
                  ? serviceDates
                  : [model.serviceDate, ...serviceDates]
                ).map((date) => (
                  <option key={date} value={date}>
                    {new Date(`${date}T12:00:00`).toLocaleDateString("en-US", {
                      weekday: "long",
                      month: "short",
                      day: "numeric",
                    })}
                  </option>
                ))}
              </select>
              {model.timing.scheduledStartMs !== null && (
                <span className="text-xs text-board-muted">
                  call {formatClock(model.timing.callTimeMs)} · start{" "}
                  {formatClock(model.timing.scheduledStartMs)}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-6">
            {/* A countdown with nothing to count toward is dead space in the
                most prominent slot on the page. Offer the fix instead. */}
            {displayMs === null ? (
              <Link
                to={`/${slug}/rundown` as unknown as Parameters<typeof Link>[0]["to"]}
                className="text-xs px-3 py-1.5 rounded-lg border border-board-border text-board-text hover:bg-board-bg transition-colors"
              >
                Set a start time
              </Link>
            ) : (
              <div className="text-right">
                <p className="text-xl font-semibold tabular-nums text-board-text">
                  {formatCountdown(displayMs)}
                </p>
                <p className="text-[10px] text-board-muted">{model.countdown.label}</p>
              </div>
            )}
            <div className="text-center pl-6 border-l border-board-border">
              <p
                className={`text-xl font-semibold tabular-nums ${healthTextClass(model.readiness.status)}`}
              >
                {model.readiness.score}%
              </p>
              <p className="text-[10px] text-board-muted">ready</p>
            </div>
          </div>
        </div>
      </header>

      <div className="p-6 max-w-6xl mx-auto">
        <div className="grid grid-cols-1 lg:grid-cols-6 gap-5">
          {widgets.map((widget) => (
            <div key={widget.id} className={widgetSpanClass(widget.span)}>
              {widget.render(widgetModel)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function formatClock(ms: number | null): string {
  if (ms === null) return "--:--";
  return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
