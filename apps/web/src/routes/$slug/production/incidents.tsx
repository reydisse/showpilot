import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ChevronLeft, ChevronRight, Plus, AlertTriangle, Trash2, X } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { getIncidents, addIncident, deleteIncident } from "@/lib/data";
import { getTodayDateString, formatTime } from "@/lib/utils";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";

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

const SEVERITY_COLORS: Record<string, string> = {
  low: "bg-blue-500/15 text-blue-400 border-blue-500/25",
  medium: "bg-yellow-500/15 text-yellow-400 border-yellow-500/25",
  high: "bg-orange-500/15 text-orange-400 border-orange-500/25",
  critical: "bg-red-500/15 text-red-400 border-red-500/25",
};

const CATEGORIES = ["Audio", "Video", "Lighting", "Network", "Power", "Software", "Hardware", "Other"];

export const Route = createFileRoute("/$slug/production/incidents")({
  loader: async ({ context }) => {
    const today = getTodayDateString();
    const incidents = await getIncidents({ data: { orgId: context.orgId, serviceDate: today } });
    return { incidents: incidents as IncidentItem[], orgId: context.orgId };
  },
  component: IncidentsPage,
});

function IncidentsPage() {
  const { incidents, orgId } = Route.useLoaderData();
  const router = useRouter();
  const [serviceDate, setServiceDate] = useState(getTodayDateString);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ category: "Audio", severity: "medium", description: "", reportedBy: "" });
  const { confirm, ConfirmDialogEl } = useConfirmDialog();

  const handleDateChange = (days: number) => {
    setServiceDate((d) => shiftDate(d, days));
    router.invalidate();
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.description.trim()) return;
    await addIncident({ data: { orgId, ...form, serviceDate } });
    setForm({ category: "Audio", severity: "medium", description: "", reportedBy: "" });
    setShowForm(false);
    router.invalidate();
  };

  const handleDelete = async (id: string) => {
    const ok = await confirm({
      title: "Delete incident",
      description: "Delete this incident? This action cannot be undone.",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    await deleteIncident({ data: { id } });
    router.invalidate();
  };

  return (
    <div className="h-full overflow-auto">
      <div className="sticky top-0 z-10 bg-board-bg/80 backdrop-blur-xl border-b border-board-border px-6 py-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-board-text">Incident Log</h1>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <button onClick={() => handleDateChange(-1)} className="p-1.5 rounded-lg hover:bg-board-border text-board-muted hover:text-board-text transition-colors"><ChevronLeft className="w-4 h-4" /></button>
              <button onClick={() => { setServiceDate(getTodayDateString()); router.invalidate(); }} className="px-3 py-1.5 rounded-lg text-xs font-medium text-board-text bg-board-card border border-board-border hover:border-fire-500/50 transition-colors min-w-[160px] text-center">{formatDisplayDate(serviceDate)}</button>
              <button onClick={() => handleDateChange(1)} className="p-1.5 rounded-lg hover:bg-board-border text-board-muted hover:text-board-text transition-colors"><ChevronRight className="w-4 h-4" /></button>
            </div>
            <button
              onClick={() => setShowForm(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-black transition-all hover:shadow-lg hover:shadow-fire-500/20 active:scale-[0.98]"
              style={{ background: "linear-gradient(135deg, #FFC107 0%, #FF8F00 100%)" }}
            >
              <Plus className="w-3.5 h-3.5" />
              Report
            </button>
          </div>
        </div>
      </div>

      <div className="p-6 max-w-2xl mx-auto">
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
                  <button onClick={() => handleDelete(incident.id)} className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-red-500/20 text-board-muted hover:text-red-400 transition-all"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-16">
            <AlertTriangle className="w-8 h-8 text-board-muted/30 mx-auto mb-3" />
            <p className="text-board-muted text-sm">No incidents for this date.</p>
          </div>
        )}

        {showForm && (
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
