import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ChevronLeft, ChevronRight, CheckCircle2, Circle, Plus, Trash2 } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import {
  getChecklistTemplates,
  getChecklistEntries,
  addChecklistTemplate,
  addChecklistEntry,
  toggleChecklistEntry,
  deleteChecklistTemplate,
} from "@/lib/data";
import { getTodayDateString } from "@/lib/utils";

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDisplayDate(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

export const Route = createFileRoute("/$slug/production/checklist")({
  loader: async ({ context }) => {
    const today = getTodayDateString();
    const [templates, entries] = await Promise.all([
      getChecklistTemplates({ data: { orgId: context.orgId } }),
      getChecklistEntries({ data: { orgId: context.orgId, serviceDate: today } }),
    ]);
    return { templates, entries, orgId: context.orgId };
  },
  component: ChecklistPage,
});

function ChecklistPage() {
  const { templates, entries: initialEntries, orgId } = Route.useLoaderData();
  const router = useRouter();
  const [serviceDate, setServiceDate] = useState(getTodayDateString);
  const [newLabel, setNewLabel] = useState("");
  const [adding, setAdding] = useState(false);

  const entries = initialEntries as Array<{
    id: string;
    templateId: string;
    checked: boolean;
    checkedBy: string | null;
    template?: { label: string; category: string } | null;
  }>;

  const checkedCount = entries.filter((e) => e.checked).length;
  const totalCount = entries.length;
  const progress = totalCount > 0 ? Math.round((checkedCount / totalCount) * 100) : 0;

  const handleToggle = async (entryId: string, checked: boolean) => {
    await toggleChecklistEntry({ data: { id: entryId, checked: !checked, checkedBy: checked ? null : "user" } });
    router.invalidate();
  };

  const handleAddTemplate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newLabel.trim()) return;
    setAdding(true);
    try {
      const tpl = await addChecklistTemplate({ data: { orgId, label: newLabel.trim(), category: "general" } });
      if (tpl) {
        await addChecklistEntry({ data: { orgId, templateId: tpl.id, serviceDate } });
      }
      setNewLabel("");
      router.invalidate();
    } finally {
      setAdding(false);
    }
  };

  const handleDeleteTemplate = async (id: string) => {
    if (!confirm("Delete this checklist item?")) return;
    await deleteChecklistTemplate({ data: { id } });
    router.invalidate();
  };

  const handleDateChange = (days: number) => {
    setServiceDate((d) => shiftDate(d, days));
    router.invalidate();
  };

  return (
    <div className="h-full overflow-auto">
      <div className="sticky top-0 z-10 bg-board-bg/80 backdrop-blur-xl border-b border-board-border px-6 py-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-board-text">Pre-Show Checklist</h1>
          <div className="flex items-center gap-2">
            <button onClick={() => handleDateChange(-1)} className="p-1.5 rounded-lg hover:bg-board-border text-board-muted hover:text-board-text transition-colors">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button onClick={() => { setServiceDate(getTodayDateString()); router.invalidate(); }} className="px-3 py-1.5 rounded-lg text-xs font-medium text-board-text bg-board-card border border-board-border hover:border-fire-500/50 transition-colors min-w-[160px] text-center">
              {formatDisplayDate(serviceDate)}
            </button>
            <button onClick={() => handleDateChange(1)} className="p-1.5 rounded-lg hover:bg-board-border text-board-muted hover:text-board-text transition-colors">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      <div className="p-6 max-w-xl mx-auto">
        {/* Progress */}
        {totalCount > 0 && (
          <div className="mb-6">
            <div className="flex items-center justify-between text-sm mb-2">
              <span className="text-board-muted">{checkedCount} of {totalCount} complete</span>
              <span className="font-semibold text-board-text">{progress}%</span>
            </div>
            <div className="h-2 rounded-full bg-board-border overflow-hidden">
              <div className="h-full rounded-full bg-fire-500 transition-all duration-500" style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}

        {/* Entries */}
        <div className="space-y-2 mb-6">
          {entries.map((entry) => (
            <div key={entry.id} className="group flex items-center gap-3 p-3 rounded-xl bg-board-card border border-board-border hover:border-fire-500/20 transition-all">
              <button onClick={() => handleToggle(entry.id, entry.checked)} className="shrink-0">
                {entry.checked ? (
                  <CheckCircle2 className="w-5 h-5 text-green-500" />
                ) : (
                  <Circle className="w-5 h-5 text-board-muted" />
                )}
              </button>
              <span className={`flex-1 text-sm ${entry.checked ? "text-board-muted line-through" : "text-board-text"}`}>
                {entry.template?.label || "Untitled"}
              </span>
              <button onClick={() => handleDeleteTemplate(entry.templateId)} className="opacity-0 group-hover:opacity-100 p-1 rounded-lg hover:bg-red-500/20 text-board-muted hover:text-red-400 transition-all">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}

          {totalCount === 0 && (
            <p className="text-center text-sm text-board-muted py-8">No checklist items for this date. Add one below.</p>
          )}
        </div>

        {/* Add new */}
        <form onSubmit={handleAddTemplate} className="flex gap-2">
          <input
            type="text"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="Add checklist item..."
            className="flex-1 px-4 py-2.5 rounded-xl bg-board-card border border-board-border text-sm text-board-text placeholder:text-board-muted/50 outline-none focus:border-fire-500/50 focus:ring-1 focus:ring-fire-500/20 transition-all"
          />
          <button
            type="submit"
            disabled={adding || !newLabel.trim()}
            className="px-4 py-2.5 rounded-xl font-semibold text-sm text-black disabled:opacity-50 transition-all hover:shadow-lg hover:shadow-fire-500/20 active:scale-[0.98]"
            style={{ background: "linear-gradient(135deg, #FFC107 0%, #FF8F00 100%)" }}
          >
            <Plus className="w-4 h-4" />
          </button>
        </form>
      </div>
    </div>
  );
}
