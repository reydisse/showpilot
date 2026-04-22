import { createFileRoute, Link } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/ui/Skeleton";
import {
  Wrench,
  AlertTriangle,
  CheckCircle2,
  Settings,
  Monitor,
} from "lucide-react";
import {
  getEquipment,
  getDevices,
  getIncidents,
  getChecklistTemplates,
  getChecklistEntries,
} from "@/lib/data";
import { getTodayDateString } from "@/lib/utils";

type EquipmentStatus = "operational" | "needs-repair" | "in-repair" | "out-of-service";

const STATUS_CONFIG: Record<EquipmentStatus, { label: string; dot: string; badge: string }> = {
  operational: {
    label: "Operational",
    dot: "bg-green-500",
    badge: "bg-green-500/15 text-green-400 border-green-500/25",
  },
  "needs-repair": {
    label: "Needs Repair",
    dot: "bg-yellow-500",
    badge: "bg-yellow-500/15 text-yellow-400 border-yellow-500/25",
  },
  "in-repair": {
    label: "In Repair",
    dot: "bg-blue-500",
    badge: "bg-blue-500/15 text-blue-400 border-blue-500/25",
  },
  "out-of-service": {
    label: "Out of Service",
    dot: "bg-red-500",
    badge: "bg-red-500/15 text-red-400 border-red-500/25",
  },
};

const CATEGORY_LABELS: Record<string, string> = {
  audio: "Audio",
  video: "Video",
  lighting: "Lighting",
  streaming: "Streaming",
  comms: "Comms",
  other: "Other",
};

export const Route = createFileRoute("/$slug/dashboard/tech-manager")({
  pendingComponent: () => <PageSkeleton />,
  loader: async ({ context }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, "dashboard:tm", context.slug, context.orgId);
    const today = getTodayDateString();
    const [equipment, devices, incidents, templates, entries] = await Promise.all([
      getEquipment({ data: { orgId: context.orgId } }),
      getDevices({ data: { orgId: context.orgId } }),
      getIncidents({ data: { orgId: context.orgId, serviceDate: today } }),
      getChecklistTemplates({ data: { orgId: context.orgId } }),
      getChecklistEntries({ data: { orgId: context.orgId, serviceDate: today } }),
    ]);
    return { equipment, devices, incidents, templates, entries, slug: context.slug };
  },
  component: TechManagerPage,
});

function TechManagerPage() {
  const { equipment, devices, incidents, templates, entries, slug } = Route.useLoaderData();

  const operational = equipment.filter((e) => e.status === "operational");
  const needsAttention = equipment.filter(
    (e) => e.status === "needs-repair" || e.status === "out-of-service"
  );
  const inRepair = equipment.filter((e) => e.status === "in-repair");
  const highIncidents = incidents.filter((i) => i.severity === "high");
  const medIncidents = incidents.filter((i) => i.severity === "medium");
  const checkedCount = entries.filter((e) => e.checked).length;
  const totalChecklist = templates.length;
  const progress = totalChecklist > 0 ? checkedCount / totalChecklist : 0;
  const enabledDevices = devices.filter((d) => d.enabled);

  return (
    <div className="h-full overflow-auto">
      <div className="sticky top-0 z-10 bg-board-bg/80 backdrop-blur-xl border-b border-board-border px-6 py-4">
        <h1 className="text-lg font-semibold text-board-text font-[family-name:var(--font-display)]">
          Tech Manager
        </h1>
        <p className="text-xs text-board-muted mt-0.5">
          Equipment, devices, and system health
        </p>
      </div>

      <div className="p-6 max-w-4xl mx-auto space-y-6">
        {/* Alert banner */}
        {(needsAttention.length > 0 || highIncidents.length > 0) && (
          <div className="px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20">
            <div className="flex items-center gap-2 mb-1">
              <AlertTriangle className="w-4 h-4 text-red-400" />
              <span className="text-sm font-medium text-red-400">
                Attention Required
              </span>
            </div>
            <div className="space-y-0.5 text-xs text-red-300/80">
              {needsAttention.length > 0 && (
                <p>
                  {needsAttention.length} equipment item{needsAttention.length !== 1 ? "s" : ""}{" "}
                  need{needsAttention.length === 1 ? "s" : ""} repair or{" "}
                  {needsAttention.length === 1 ? "is" : "are"} out of service
                </p>
              )}
              {highIncidents.length > 0 && (
                <p>
                  {highIncidents.length} high severity incident{highIncidents.length !== 1 ? "s" : ""} today
                </p>
              )}
            </div>
          </div>
        )}

        {/* Stats cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            label="Equipment"
            value={equipment.length}
            sub={`${operational.length} operational`}
            icon={<Settings className="w-4 h-4" />}
            color="text-board-muted"
          />
          <StatCard
            label="Needs Repair"
            value={needsAttention.length}
            sub={inRepair.length > 0 ? `${inRepair.length} in repair` : "All good"}
            icon={<Wrench className="w-4 h-4" />}
            color={needsAttention.length > 0 ? "text-yellow-400" : "text-board-muted"}
          />
          <StatCard
            label="Incidents Today"
            value={incidents.length}
            sub={`${highIncidents.length} high · ${medIncidents.length} med`}
            icon={<AlertTriangle className="w-4 h-4" />}
            color={highIncidents.length > 0 ? "text-red-400" : "text-board-muted"}
          />
          <StatCard
            label="Checklist"
            value={`${Math.round(progress * 100)}%`}
            sub={`${checkedCount} / ${totalChecklist}`}
            icon={<CheckCircle2 className="w-4 h-4" />}
            color={progress >= 1 ? "text-green-400" : "text-board-muted"}
          />
        </div>

        {/* Devices summary */}
        <div className="rounded-xl border bg-board-card border-board-border p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Monitor className="w-4 h-4 text-board-muted" />
              <span className="text-[10px] font-medium uppercase tracking-widest text-board-muted">
                Devices
              </span>
            </div>
            <Link
              to="/$slug/dashboard/devices"
              params={{ slug }}
              className="text-[10px] font-medium text-fire-500 hover:text-fire-400 transition-colors"
            >
              Manage Devices →
            </Link>
          </div>
          {devices.length === 0 ? (
            <p className="text-sm text-board-muted/60 text-center py-4">
              No devices configured
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {devices.map((d) => (
                <div
                  key={d.id}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg ${
                    d.enabled ? "bg-board-bg" : "bg-board-bg/50 opacity-50"
                  }`}
                >
                  <div
                    className={`w-2 h-2 rounded-full ${
                      d.enabled ? "bg-board-muted" : "bg-red-500"
                    }`}
                  />
                  <span className="text-xs text-board-text">{d.name}</span>
                </div>
              ))}
            </div>
          )}
          <p className="text-[10px] text-board-muted/50 mt-3">
            {enabledDevices.length} enabled / {devices.length} total
          </p>
        </div>

        {/* Equipment — Needs Attention */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-board-text">
              Equipment — Needs Attention
            </h2>
            <Link
              to="/$slug/production/assets"
              params={{ slug }}
              className="text-[10px] font-medium text-fire-500 hover:text-fire-400 transition-colors"
            >
              View All Assets →
            </Link>
          </div>

          {needsAttention.length === 0 ? (
            <div className="rounded-xl border border-board-border bg-board-card/50 p-6 text-center">
              <CheckCircle2 className="w-8 h-8 text-green-500/30 mx-auto mb-2" />
              <p className="text-sm text-board-muted">
                All equipment is operational
              </p>
              <p className="text-[10px] text-board-muted/50 mt-1">
                {equipment.length} item{equipment.length !== 1 ? "s" : ""} tracked
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {needsAttention.map((item) => {
                const statusCfg = STATUS_CONFIG[item.status as EquipmentStatus] ?? STATUS_CONFIG.operational;
                return (
                  <div
                    key={item.id}
                    className="flex items-center gap-3 px-4 py-3 rounded-xl bg-board-card border border-board-border"
                  >
                    <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${statusCfg.dot}`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-board-text truncate">
                        {item.name}
                      </p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[10px] text-board-muted uppercase">
                          {CATEGORY_LABELS[item.category] ?? item.category}
                        </span>
                        {item.location && (
                          <>
                            <span className="text-board-border">·</span>
                            <span className="text-[10px] text-board-muted truncate">
                              {item.location}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    <span
                      className={`text-[9px] font-medium uppercase tracking-wider px-2 py-0.5 rounded-full border shrink-0 ${statusCfg.badge}`}
                    >
                      {statusCfg.label}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Recent Incidents */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-board-text">
              Today&apos;s Incidents
            </h2>
            <Link
              to="/$slug/production/incidents"
              params={{ slug }}
              className="text-[10px] font-medium text-fire-500 hover:text-fire-400 transition-colors"
            >
              View All →
            </Link>
          </div>
          {incidents.length === 0 ? (
            <div className="rounded-xl border border-board-border bg-board-card/50 p-6 text-center">
              <CheckCircle2 className="w-8 h-8 text-green-500/30 mx-auto mb-2" />
              <p className="text-sm text-board-muted">
                No incidents reported today
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {incidents.map((inc) => (
                <div
                  key={inc.id}
                  className="flex items-center gap-3 px-4 py-2.5 rounded-xl bg-board-card border border-board-border"
                >
                  <div
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      inc.severity === "high"
                        ? "bg-red-500"
                        : inc.severity === "medium"
                          ? "bg-yellow-400"
                          : "bg-blue-400"
                    }`}
                  />
                  <span
                    className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0 ${
                      inc.severity === "high"
                        ? "bg-red-500/15 text-red-400"
                        : inc.severity === "medium"
                          ? "bg-yellow-500/15 text-yellow-400"
                          : "bg-blue-500/15 text-blue-400"
                    }`}
                  >
                    {inc.severity}
                  </span>
                  <span className="text-[10px] text-board-muted uppercase w-14 shrink-0">
                    {inc.category}
                  </span>
                  <p className="text-xs text-board-text truncate flex-1">
                    {inc.description}
                  </p>
                  <span className="text-[10px] text-board-muted/50 shrink-0">
                    — {inc.reportedBy}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  icon,
  color,
}: {
  label: string;
  value: number | string;
  sub: string;
  icon: React.ReactNode;
  color: string;
}) {
  return (
    <div className="rounded-xl border bg-board-card border-board-border p-4">
      <div className={`flex items-center gap-1.5 mb-2 ${color}`}>
        {icon}
        <span className="text-[10px] font-medium uppercase tracking-widest">
          {label}
        </span>
      </div>
      <p className="text-2xl font-semibold tabular-nums text-board-text">
        {value}
      </p>
      {sub && (
        <p className="text-[10px] text-board-muted mt-0.5">{sub}</p>
      )}
    </div>
  );
}
