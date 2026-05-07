import { createFileRoute, useRouter } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { useState } from "react";
import {
  Users,
  CheckCircle2,
  AlertTriangle,
  Clapperboard,
} from "lucide-react";
import {
  getCrewMembers,
  getChecklistTemplates,
  getChecklistEntries,
  getIncidents,
  getCueSheets,
} from "@/lib/data";
import { getTodayDateString } from "@/lib/utils";
import { getDepartment, DEPARTMENTS, type RoleDepartment } from "@/types";
import { useServiceDateRollover } from "@/hooks/useServiceDateRollover";

const DEPT_ORDER: RoleDepartment[] = [
  "leadership",
  "production",
  "camera",
  "audio",
  "visuals",
  "lighting",
  "streaming",
  "technical",
  "other",
];

export const Route = createFileRoute("/$slug/dashboard/prod-manager")({
  pendingComponent: () => <PageSkeleton />,
  loader: async ({ context }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, "dashboard:pm", context.slug, context.orgId);
    const today = getTodayDateString();
    const [members, templates, entries, incidents, cueItems] = await Promise.all([
      getCrewMembers({ data: { orgId: context.orgId } }),
      getChecklistTemplates({ data: { orgId: context.orgId } }),
      getChecklistEntries({ data: { orgId: context.orgId, serviceDate: today } }),
      getIncidents({ data: { orgId: context.orgId, serviceDate: today } }),
      getCueSheets({ data: { orgId: context.orgId, serviceDate: today } }),
    ]);
    return { members, templates, entries, incidents, cueItems, orgId: context.orgId };
  },
  component: ProdManagerPage,
});

function ProdManagerPage() {
  const { members, templates, entries, incidents, cueItems } = Route.useLoaderData();
  const router = useRouter();
  const [serviceDate, setServiceDate] = useState(getTodayDateString);

  useServiceDateRollover({
    serviceDate,
    onTodayChanged: async (nextToday) => {
      setServiceDate(nextToday);
      await router.invalidate();
    },
  });

  const servingMembers = members.filter((m) => m.isOnline);
  const checkedCount = entries.filter((e) => e.checked).length;
  const totalChecklist = templates.length;
  const progress = totalChecklist > 0 ? checkedCount / totalChecklist : 0;
  const highSeverity = incidents.filter((i) => i.severity === "high");

  // Group serving members by department
  const servingByDept: Record<RoleDepartment, typeof members> = {
    leadership: [], production: [], camera: [], audio: [],
    visuals: [], lighting: [], streaming: [], technical: [], other: [],
  };
  servingMembers.forEach((m) => {
    const dept = getDepartment(m.role);
    servingByDept[dept].push(m);
  });

  return (
    <div className="h-full overflow-auto">
      <div className="sticky top-0 z-10 bg-board-bg/80 backdrop-blur-xl border-b border-board-border px-6 py-4">
        <h1 className="text-lg font-semibold text-board-text font-[family-name:var(--font-display)]">
          Production Manager
        </h1>
        <p className="text-xs text-board-muted mt-0.5">
          High-level overview of today&apos;s production
        </p>
      </div>

      <div className="p-6 max-w-4xl mx-auto space-y-6">
        {/* Top row: Stats */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Crew card */}
          <div className="rounded-xl border bg-board-card border-board-border p-5">
            <div className="flex items-center gap-2 mb-3">
              <Users className="w-4 h-4 text-green-400" />
              <span className="text-[10px] font-medium uppercase tracking-widest text-board-muted">
                Crew Online
              </span>
            </div>
            <div className="flex items-end gap-3">
              <p className="text-3xl font-semibold tabular-nums text-board-text">
                {servingMembers.length}
              </p>
              <p className="text-xs text-board-muted pb-1">
                / {members.length} total
              </p>
            </div>
          </div>

          {/* Checklist progress */}
          <div className="rounded-xl border bg-board-card border-board-border p-5">
            <div className="flex items-center gap-2 mb-3">
              <CheckCircle2 className="w-4 h-4 text-board-muted" />
              <span className="text-[10px] font-medium uppercase tracking-widest text-board-muted">
                Pre-Show Checklist
              </span>
            </div>
            <div className="flex items-end gap-3">
              <p className="text-3xl font-semibold tabular-nums text-board-text">
                {Math.round(progress * 100)}%
              </p>
              <p className="text-xs text-board-muted pb-1">
                {checkedCount} / {totalChecklist} items
              </p>
            </div>
            <div className="w-full h-2 rounded-full bg-board-border mt-3 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  progress >= 1
                    ? "bg-green-500"
                    : progress >= 0.5
                      ? "bg-yellow-400"
                      : "bg-red-400"
                }`}
                style={{ width: `${progress * 100}%` }}
              />
            </div>
          </div>

          {/* Incidents */}
          <div className="rounded-xl border bg-board-card border-board-border p-5">
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle
                className={`w-4 h-4 ${incidents.length > 0 ? "text-red-400" : "text-board-muted"}`}
              />
              <span className="text-[10px] font-medium uppercase tracking-widest text-board-muted">
                Incidents Today
              </span>
            </div>
            <div className="flex items-end gap-3">
              <p className={`text-3xl font-semibold tabular-nums ${incidents.length > 0 ? "text-red-400" : "text-board-text"}`}>
                {incidents.length}
              </p>
              {highSeverity.length > 0 && (
                <p className="text-xs text-red-400 pb-1">
                  {highSeverity.length} high severity
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Incidents alert */}
        {highSeverity.length > 0 && (
          <div className="px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20">
            <div className="flex items-center gap-2 mb-1.5">
              <AlertTriangle className="w-4 h-4 text-red-400" />
              <span className="text-sm font-medium text-red-400">
                {highSeverity.length} high severity incident{highSeverity.length !== 1 ? "s" : ""}
              </span>
            </div>
            <div className="space-y-1">
              {highSeverity.map((inc) => (
                <p key={inc.id} className="text-xs text-red-300/80 truncate">
                  [{inc.category}] {inc.description}
                </p>
              ))}
            </div>
          </div>
        )}

        {/* Middle row: Crew + Cue Sheets */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* Crew on duty */}
          <div className="rounded-xl border bg-board-card border-board-border p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Users className="w-4 h-4 text-board-muted" />
                <span className="text-[10px] font-medium uppercase tracking-widest text-board-muted">
                  Crew On Duty
                </span>
              </div>
              <span className="text-xs tabular-nums text-board-muted">
                {servingMembers.length} / {members.length}
              </span>
            </div>

            {servingMembers.length === 0 ? (
              <p className="text-sm text-board-muted/60 text-center py-6">
                No one checked in yet
              </p>
            ) : (
              <div className="space-y-3">
                {DEPT_ORDER.map((dept) => {
                  const deptMembers = servingByDept[dept];
                  if (deptMembers.length === 0) return null;
                  const config = DEPARTMENTS[dept];
                  return (
                    <div key={dept}>
                      <span
                        className={`text-[9px] font-medium uppercase tracking-widest px-1.5 py-0.5 rounded border ${config.color}`}
                      >
                        {config.label}
                      </span>
                      <div className="flex flex-wrap gap-2 mt-1.5">
                        {deptMembers.map((m) => (
                          <div
                            key={m.id}
                            className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-board-bg"
                          >
                            <div className="w-5 h-5 rounded-full overflow-hidden bg-board-border shrink-0">
                              {m.photoUrl ? (
                                <img
                                  src={m.photoUrl}
                                  alt={m.name}
                                  className="w-full h-full object-cover"
                                />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center text-board-muted text-[8px] font-bold">
                                  {m.name.charAt(0)}
                                </div>
                              )}
                            </div>
                            <span className="text-[11px] text-board-text whitespace-nowrap">
                              {m.name}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Cue Sheet overview */}
          <div className="rounded-xl border bg-board-card border-board-border p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Clapperboard className="w-4 h-4 text-board-muted" />
                <span className="text-[10px] font-medium uppercase tracking-widest text-board-muted">
                  Cue Sheet
                </span>
              </div>
              <span className="text-xs tabular-nums text-board-muted">
                {cueItems.length} cue{cueItems.length !== 1 ? "s" : ""}
              </span>
            </div>

            {cueItems.length === 0 ? (
              <p className="text-sm text-board-muted/60 text-center py-6">
                No cues for today
              </p>
            ) : (
              <div className="space-y-1.5 max-h-[240px] overflow-auto">
                {cueItems.map((cue) => (
                  <div
                    key={cue.id}
                    className="flex items-center gap-3 px-3 py-2 rounded-lg bg-board-bg/50"
                  >
                    <span className="text-xs font-bold text-fire-500 tabular-nums w-6 text-center shrink-0">
                      {cue.cueNumber}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-board-text truncate">
                        {cue.rundownItem}
                      </p>
                      {cue.cameraAssignments && (
                        <p className="text-[10px] text-board-muted truncate">
                          Cam: {cue.cameraAssignments}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Incidents summary */}
        <div className="rounded-xl border bg-board-card border-board-border p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-board-muted" />
              <span className="text-[10px] font-medium uppercase tracking-widest text-board-muted">
                Incidents Today
              </span>
            </div>
            <span className="text-xs tabular-nums text-board-muted">
              {incidents.length} total
            </span>
          </div>
          {incidents.length === 0 ? (
            <p className="text-sm text-board-muted/60 text-center py-4">
              No incidents reported
            </p>
          ) : (
            <div className="space-y-2 max-h-[200px] overflow-auto">
              {incidents.slice(0, 8).map((inc) => (
                <div
                  key={inc.id}
                  className="flex items-center gap-3 px-3 py-2 rounded-lg bg-board-bg/50"
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
                  <span className="text-[10px] font-medium uppercase text-board-muted/60 w-12 shrink-0">
                    {inc.category}
                  </span>
                  <p className="text-xs text-board-text truncate flex-1">
                    {inc.description}
                  </p>
                  <span className="text-[10px] text-board-muted/50 shrink-0">
                    {inc.reportedBy}
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
