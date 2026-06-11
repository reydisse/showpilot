import { createFileRoute } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Plus, AlertTriangle, ShieldCheck, Trash2, X } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { getIncidents, addIncident, deleteIncident } from "@/lib/data";
import { hasAnyPermission, hasPermission } from "@/lib/app-permissions";
import { getTodayDateString, formatTime } from "@/lib/utils";
import { getOrgSettings } from "@/lib/settings";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { useServiceDateRollover } from "@/hooks/useServiceDateRollover";

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDisplayDate(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

type IncidentItem = {
  id: string;
  category: string;
  severity: string;
  description: string;
  reportedBy: string;
  timestamp: string;
};

function normalizeIncident(incident: {
  id: string;
  category: string;
  severity: string;
  description: string;
  reportedBy: string;
  timestamp: Date | string;
}): IncidentItem {
  return {
    id: incident.id,
    category: incident.category,
    severity: incident.severity,
    description: incident.description,
    reportedBy: incident.reportedBy,
    timestamp: incident.timestamp instanceof Date ? incident.timestamp.toISOString() : incident.timestamp,
  };
}

const SEVERITY_COLORS: Record<string, string> = {
  low: "bg-blue-500/15 text-blue-400 border-blue-500/25",
  medium: "bg-yellow-500/15 text-yellow-400 border-yellow-500/25",
  high: "bg-orange-500/15 text-orange-400 border-orange-500/25",
  critical: "bg-red-500/15 text-red-400 border-red-500/25",
};

const CATEGORIES = ["Audio", "Video", "Lighting", "Network", "Power", "Software", "Hardware", "Other"];

export const Route = createFileRoute("/$slug/production/incidents")({
  pendingComponent: () => <PageSkeleton />,
  loader: async ({ context }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, ["incidents:report", "incidents:access"], context.slug, context.orgId);
    const settings = await getOrgSettings({ data: { orgId: context.orgId } });
    const today = getTodayDateString(settings["org-timezone"]);
    const incidents = await getIncidents({ data: { orgId: context.orgId, serviceDate: today } });
    return {
      incidents: incidents.map(normalizeIncident),
      orgId: context.orgId,
      role: context.role,
      orgTimezone: settings["org-timezone"],
    };
  },
  component: IncidentsPage,
});

function IncidentsPage() {
  const { incidents: initialIncidents, orgId, role, orgTimezone } = Route.useLoaderData();
  const [serviceDate, setServiceDate] = useState(() => getTodayDateString(orgTimezone));
  const [incidents, setIncidents] = useState(initialIncidents);
  const [loadingIncidents, setLoadingIncidents] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ category: "Audio", severity: "medium", description: "", reportedBy: "" });
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  const canReportIncidents = hasAnyPermission(role, ["incidents:report", "incidents:access"]);
  const canManageIncidents = hasPermission(role, "incidents:access");

  const loadIncidents = useCallback(async (date: string) => {
    setLoadingIncidents(true);
    try {
      const latest = await getIncidents({ data: { orgId, serviceDate: date } });
      setIncidents(latest.map(normalizeIncident));
    } finally {
      setLoadingIncidents(false);
    }
  }, [orgId]);

  useEffect(() => {
    setIncidents(initialIncidents);
  }, [initialIncidents]);

  useEffect(() => {
    void loadIncidents(serviceDate);
  }, [loadIncidents, serviceDate]);

  useServiceDateRollover({
    serviceDate,
    timeZone: orgTimezone,
    onTodayChanged: (nextToday) => {
      setServiceDate(nextToday);
    },
  });

  const handleDateChange = (days: number) => {
    setServiceDate((d) => shiftDate(d, days));
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canReportIncidents) return;
    if (!form.description.trim()) return;
    await addIncident({ data: { orgId, ...form, serviceDate } });
    setForm({ category: "Audio", severity: "medium", description: "", reportedBy: "" });
    setShowForm(false);
    await loadIncidents(serviceDate);
  };

  const handleDelete = async (id: string) => {
    if (!canManageIncidents) return;
    const ok = await confirm({
      title: "Delete incident",
      description: "Delete this incident? This action cannot be undone.",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    await deleteIncident({ data: { orgId, id } });
    await loadIncidents(serviceDate);
  };

  return (
    <div className="h-full overflow-auto">
      <div className="sticky top-0 z-10 bg-board-bg/80 backdrop-blur-xl border-b border-board-border px-6 py-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-board-text">Incident Log</h1>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <button onClick={() => handleDateChange(-1)} className="p-1.5 rounded-lg hover:bg-board-border text-board-muted hover:text-board-text transition-colors"><ChevronLeft className="w-4 h-4" /></button>
              <button
                onClick={() => setServiceDate(getTodayDateString(orgTimezone))}
                className="px-3 py-1.5 rounded-lg text-xs font-medium text-board-text bg-board-card border border-board-border hover:border-fire-500/50 transition-colors min-w-[160px] text-center"
              >
                {formatDisplayDate(serviceDate)}
              </button>
              <button onClick={() => handleDateChange(1)} className="p-1.5 rounded-lg hover:bg-board-border text-board-muted hover:text-board-text transition-colors"><ChevronRight className="w-4 h-4" /></button>
            </div>
            {canReportIncidents && (
              <button
                onClick={() => setShowForm(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-black transition-all hover:shadow-lg hover:shadow-fire-500/20 active:scale-[0.98]"
                style={{ background: "linear-gradient(135deg, #FFC107 0%, #FF8F00 100%)" }}
              >
                <Plus className="w-3.5 h-3.5" />
                Report
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="p-6 max-w-2xl mx-auto">
        {loadingIncidents && (
          <p className="mb-3 text-xs text-board-muted">Loading incidents for {formatDisplayDate(serviceDate)}...</p>
        )}
        {incidents.length > 0 ? (
          <div className="space-y-3">
            {incidents.map((incident) => (
              <div key={incident.id} className="group p-4 rounded-xl bg-board-card border border-board-border hover:border-fire-500/20 transition-all">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className={`w-4 h-4 mt-0.5 shrink-0 ${incident.severity === "critical" ? "text-red-400" : incident.severity === "high" ? "text-orange-400" : "text-yellow-400"}`} />
                    <div>
                      <p className="text-sm text-board-text">{incident.description}</p>
                      <div className="flex items-center gap-2 mt-2">
                        <span className={`text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded border ${SEVERITY_COLORS[incident.severity] || SEVERITY_COLORS.medium}`}>{incident.severity}</span>
                        <span className="text-[10px] text-board-muted bg-board-bg px-1.5 py-0.5 rounded border border-board-border">{incident.category}</span>
                        {incident.reportedBy && <span className="text-[10px] text-board-muted">by {incident.reportedBy}</span>}
                        {incident.timestamp && <span className="text-[10px] text-board-muted">{formatTime(new Date(incident.timestamp))}</span>}
                      </div>
                    </div>
                  </div>
                  {canManageIncidents && (
                    <button onClick={() => handleDelete(incident.id)} className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-red-500/20 text-board-muted hover:text-red-400 transition-all"><Trash2 className="w-3.5 h-3.5" /></button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={ShieldCheck}
            title="No incidents for this date"
            description={
              canReportIncidents
                ? "All clear. Use Report above to log anything that goes wrong during the show — audio dropouts, camera faults, stream issues."
                : "All clear. Issues reported during the show will appear here."
            }
          />
        )}

        {showForm && canReportIncidents && (
          <form onSubmit={handleAdd} className="mt-4 p-4 rounded-xl bg-board-card border border-board-border space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-board-text">Report Incident</h3>
              <button type="button" onClick={() => setShowForm(false)} className="text-board-muted hover:text-board-text"><X className="w-4 h-4" /></button>
            </div>
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="What happened?"
              rows={3}
              className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-sm text-board-text placeholder:text-board-muted/50 outline-none focus:border-fire-500/50 focus:ring-1 focus:ring-fire-500/20 resize-none"
            />
            <div className="grid grid-cols-3 gap-3">
              <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="px-3 py-2.5 rounded-xl bg-board-bg border border-board-border text-sm text-board-text outline-none focus:border-fire-500/50">
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })} className="px-3 py-2.5 rounded-xl bg-board-bg border border-board-border text-sm text-board-text outline-none focus:border-fire-500/50">
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
              <input value={form.reportedBy} onChange={(e) => setForm({ ...form, reportedBy: e.target.value })} placeholder="Reported by..." className="px-3 py-2.5 rounded-xl bg-board-bg border border-board-border text-sm text-board-text placeholder:text-board-muted/50 outline-none focus:border-fire-500/50" />
            </div>
            <button type="submit" disabled={!form.description.trim()} className="px-4 py-2.5 rounded-xl font-semibold text-sm text-black disabled:opacity-50 transition-all hover:shadow-lg hover:shadow-fire-500/20 active:scale-[0.98]" style={{ background: "linear-gradient(135deg, #FFC107 0%, #FF8F00 100%)" }}>
              Submit
            </button>
          </form>
        )}
      </div>
      {ConfirmDialogEl}
    </div>
  );
}
