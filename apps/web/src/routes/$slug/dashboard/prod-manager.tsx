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
  widgetsInRegion,
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
  const { model, serviceDates, orgId } = Route.useLoaderData();
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

  const widgetModel: PmWidgetModel = { model, slug, orgId };
  const widgets = selectWidgets(PM_WIDGETS, model.phase, widgetModel);
  const banners = widgetsInRegion(widgets, "banner");
  const main = widgetsInRegion(widgets, "main");
  const rail = widgetsInRegion(widgets, "rail");

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
      {/* One toolbar row. Identity and context on the left, live numbers
          right-aligned against the edge so the eye always lands in the
          same place regardless of how wide the window is. */}
      <header className="sticky top-0 z-10 bg-board-bg/85 backdrop-blur-xl border-b border-board-border">
        <div className="px-6 py-3 flex flex-wrap items-center gap-x-4 gap-y-3">
          <h1 className="text-[15px] font-semibold text-board-text font-[family-name:var(--font-display)]">
            Production Manager
          </h1>
          <span
            className={`text-[10px] font-medium uppercase tracking-[0.12em] px-2 py-0.5 rounded border ${PHASE_CHIP[model.phase]}`}
          >
            {phaseLabel(model.phase)}
          </span>

          <span className="w-px h-5 bg-board-border" aria-hidden="true" />

          <label htmlFor="pm-service-date" className="sr-only">
            Service date
          </label>
          <select
            id="pm-service-date"
            value={model.serviceDate}
            onChange={(event) => {
              void navigate({ search: { date: event.target.value } });
            }}
            className="text-xs bg-transparent border border-board-border/70 rounded px-2 py-1 text-board-text hover:border-board-border transition-colors"
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
            <span className="text-[11px] text-board-muted tabular-nums">
              call {formatClock(model.timing.callTimeMs)} · start{" "}
              {formatClock(model.timing.scheduledStartMs)}
            </span>
          )}

          <div className="ml-auto flex items-center gap-5">
            {/* A countdown with nothing to count toward is dead space in
                the most prominent slot on the page. Offer the fix. */}
            {displayMs === null ? (
              <Link
                to={`/${slug}/rundown` as unknown as Parameters<typeof Link>[0]["to"]}
                className="text-xs px-2.5 py-1.5 rounded border border-board-border/70 text-board-muted hover:text-board-text hover:border-board-border transition-colors"
              >
                Set a start time
              </Link>
            ) : (
              <div className="text-right leading-none">
                <p className="text-[22px] font-semibold tabular-nums text-board-text">
                  {formatCountdown(displayMs)}
                </p>
                <p className="text-[10px] text-board-muted mt-1">{model.countdown.label}</p>
              </div>
            )}
            <span className="w-px h-8 bg-board-border" aria-hidden="true" />
            <div className="text-right leading-none">
              <p
                className={`text-[22px] font-semibold tabular-nums ${healthTextClass(model.readiness.status)}`}
              >
                {model.readiness.score}%
              </p>
              <p className="text-[10px] text-board-muted mt-1">ready</p>
            </div>
          </div>
        </div>
      </header>

      {/* Banners span the width; below them a wide reading column and a
          fixed rail. No spans, so no ragged rows and no dead space. */}
      <div className="px-6 py-5 w-full max-w-[1500px] space-y-4">
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

function formatClock(ms: number | null): string {
  if (ms === null) return "--:--";
  return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
