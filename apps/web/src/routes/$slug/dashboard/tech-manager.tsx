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

import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { getTmDashboard } from "@/lib/tm-dashboard";
import { phaseLabel, type ServicePhase } from "@/lib/service-phase";
import { TM_WIDGETS, type TmWidgetModel } from "@/components/dashboard/tm-widgets";
import { selectWidgets, widgetsInRegion } from "@/components/dashboard/widget";

/** How often the page re-reads. A live service needs a tighter loop. */
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

export const Route = createFileRoute("/$slug/dashboard/tech-manager")({
  pendingComponent: () => <PageSkeleton />,
  loader: async ({ context }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, "dashboard:tm", context.slug, context.orgId);
    return await getTmDashboard({ data: { orgId: context.orgId } });
  },
  component: TechManagerPage,
});

function TechManagerPage() {
  const { model, orgId, serviceDate, viewerId, members } = Route.useLoaderData();
  const { slug } = Route.useParams();
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Faults arrive from other people — someone reporting from the floor,
  // a colleague claiming one. Without a refresh the page is a snapshot of
  // whenever it was opened, which during a service is worse than useless.
  useEffect(() => {
    const id = setInterval(() => {
      void router.invalidate();
    }, REFRESH_MS[model.phase]);
    return () => clearInterval(id);
  }, [model.phase, router]);

  const act = useCallback(
    async (faultId: string, run: () => Promise<unknown>) => {
      setBusyId(faultId);
      setError(null);
      try {
        await run();
        await router.invalidate();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "That did not save");
      } finally {
        setBusyId(null);
      }
    },
    [router],
  );

  const widgetModel: TmWidgetModel = {
    model,
    slug,
    orgId,
    viewerId,
    members,
    busyId,
    onClaim: (faultId) =>
      void act(faultId, async () => {
        const { assignFault } = await import("@/lib/tm-dashboard");
        return assignFault({ data: { orgId, id: faultId, assignedTo: viewerId } });
      }),
    onAssign: (faultId, userId, name) =>
      void act(faultId, async () => {
        const { assignFault } = await import("@/lib/tm-dashboard");
        return assignFault({
          data: { orgId, id: faultId, assignedTo: userId, assignedName: name },
        });
      }),
    onResolve: (faultId) =>
      void act(faultId, async () => {
        const { resolveFault } = await import("@/lib/tm-dashboard");
        return resolveFault({ data: { orgId, id: faultId } });
      }),
  };

  const widgets = selectWidgets(TM_WIDGETS, model.phase, widgetModel);
  const banners = widgetsInRegion(widgets, "banner");
  const main = widgetsInRegion(widgets, "main");
  const rail = widgetsInRegion(widgets, "rail");

  return (
    <div className="h-full overflow-auto">
      <header className="sticky top-0 z-10 bg-board-bg/85 backdrop-blur-xl border-b border-board-border">
        <div className="flex items-center gap-3 flex-wrap px-6 py-3">
          <h1 className="text-[15px] font-semibold text-board-text font-[family-name:var(--font-display)]">
            Tech manager
          </h1>
          <span
            className={`text-[10px] font-medium uppercase tracking-[0.12em] px-2 py-0.5 rounded border ${PHASE_CHIP[model.phase]}`}
          >
            {phaseLabel(model.phase)}
          </span>
          <span className="text-xs text-board-muted">
            {new Date(`${serviceDate}T12:00:00`).toLocaleDateString("en-US", {
              weekday: "short",
              month: "short",
              day: "numeric",
            })}
          </span>

          <div className="ml-auto flex items-center gap-5">
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
                {model.openCount}
              </p>
              <p className="text-[10px] text-board-muted mt-1">
                {model.unownedCount > 0 ? `${model.unownedCount} unowned` : "open faults"}
              </p>
            </div>
            {model.prep.length > 0 && (
              <div className="text-right leading-none">
                <p className="text-[22px] font-semibold tabular-nums text-yellow-400">
                  {model.prep.length}
                </p>
                <p className="text-[10px] text-board-muted mt-1">to fix first</p>
              </div>
            )}
          </div>
        </div>
      </header>

      {error && (
        <div role="alert" className="px-6 py-2 bg-red-500/15 border-b border-red-500/30 text-[12px] text-red-300">
          {error}
        </div>
      )}

      <div className="px-6 py-5 w-full max-w-[1500px] space-y-4">
        {banners.map((widget) => (
          <div key={widget.id}>{widget.render(widgetModel)}</div>
        ))}

        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_300px] gap-4 items-start">
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
