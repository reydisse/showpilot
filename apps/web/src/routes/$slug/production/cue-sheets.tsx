import { createFileRoute } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Plus, Pencil, Trash2, X } from "lucide-react";
import { getCueSheets, addCueSheet, updateCueSheet, deleteCueSheet } from "@/lib/data";
import { getTodayDateString } from "@/lib/utils";
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

type CueItem = {
  id: string;
  cueNumber: number;
  rundownItem: string;
  cameraAssignments: string;
  notes: string;
};

export const Route = createFileRoute("/$slug/production/cue-sheets")({
  pendingComponent: () => <PageSkeleton />,
  loader: async ({ context }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, ["cuesheet:view", "cuesheet:edit", "cuesheet:add_notes"], context.slug, context.orgId);
    const today = getTodayDateString();
    const items = await getCueSheets({ data: { orgId: context.orgId, serviceDate: today } });
    return { items: items as CueItem[], orgId: context.orgId };
  },
  component: CueSheetsPage,
});

function CueSheetsPage() {
  const { items: initialItems, orgId } = Route.useLoaderData();
  const [serviceDate, setServiceDate] = useState(getTodayDateString);
  const [items, setItems] = useState(initialItems);
  const [loadingItems, setLoadingItems] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingItem, setEditingItem] = useState<CueItem | null>(null);
  const [form, setForm] = useState({ rundownItem: "", cameraAssignments: "", notes: "" });
  const { confirm, ConfirmDialogEl } = useConfirmDialog();

  const loadItems = useCallback(async (date: string) => {
    setLoadingItems(true);
    try {
      const latest = await getCueSheets({ data: { orgId, serviceDate: date } });
      setItems(latest as CueItem[]);
    } finally {
      setLoadingItems(false);
    }
  }, [orgId]);

  useEffect(() => {
    setItems(initialItems);
  }, [initialItems]);

  useEffect(() => {
    void loadItems(serviceDate);
  }, [loadItems, serviceDate]);

  useServiceDateRollover({
    serviceDate,
    onTodayChanged: (nextToday) => {
      setServiceDate(nextToday);
    },
  });

  const handleDateChange = (days: number) => {
    setServiceDate((d) => shiftDate(d, days));
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.rundownItem.trim()) return;
    const nextCue = items.length > 0 ? Math.max(...items.map((i) => i.cueNumber)) + 1 : 1;
    await addCueSheet({
      data: {
        orgId, cueNumber: nextCue, rundownItem: form.rundownItem, cameraAssignments: form.cameraAssignments, notes: form.notes, serviceDate,
      },
    });
    setForm({ rundownItem: "", cameraAssignments: "", notes: "" });
    setShowForm(false);
    await loadItems(serviceDate);
  };

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingItem) return;
    await updateCueSheet({ data: { id: editingItem.id, updates: { rundownItem: form.rundownItem, cameraAssignments: form.cameraAssignments, notes: form.notes } } });
    setEditingItem(null);
    setForm({ rundownItem: "", cameraAssignments: "", notes: "" });
    await loadItems(serviceDate);
  };

  const handleDelete = async (id: string) => {
    const ok = await confirm({
      title: "Delete cue",
      description: "Delete this cue? This action cannot be undone.",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    await deleteCueSheet({ data: { id } });
    await loadItems(serviceDate);
  };

  const startEdit = (item: CueItem) => {
    setEditingItem(item);
    setForm({ rundownItem: item.rundownItem, cameraAssignments: item.cameraAssignments, notes: item.notes });
    setShowForm(false);
  };

  return (
    <div className="h-full overflow-auto">
      <div className="sticky top-0 z-10 bg-board-bg/80 backdrop-blur-xl border-b border-board-border px-6 py-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-board-text">Cue Sheets</h1>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <button onClick={() => handleDateChange(-1)} className="p-1.5 rounded-lg hover:bg-board-border text-board-muted hover:text-board-text transition-colors">
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button onClick={() => setServiceDate(getTodayDateString())} className="px-3 py-1.5 rounded-lg text-xs font-medium text-board-text bg-board-card border border-board-border hover:border-fire-500/50 transition-colors min-w-[160px] text-center">
                {formatDisplayDate(serviceDate)}
              </button>
              <button onClick={() => handleDateChange(1)} className="p-1.5 rounded-lg hover:bg-board-border text-board-muted hover:text-board-text transition-colors">
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
            <button
              onClick={() => { setShowForm(true); setEditingItem(null); setForm({ rundownItem: "", cameraAssignments: "", notes: "" }); }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-black transition-all hover:shadow-lg hover:shadow-fire-500/20 active:scale-[0.98]"
              style={{ background: "linear-gradient(135deg, #FFC107 0%, #FF8F00 100%)" }}
            >
              <Plus className="w-3.5 h-3.5" />
              Add Cue
            </button>
          </div>
        </div>
      </div>

      <div className="p-6 max-w-5xl mx-auto">
        {/* Table */}
        {loadingItems ? (
          <div className="text-center py-16">
            <p className="text-board-muted text-sm">Loading cue sheets...</p>
          </div>
        ) : items.length > 0 ? (
          <div className="rounded-xl border border-board-border overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="bg-board-card border-b border-board-border">
                  <th className="px-4 py-3 text-left text-[10px] font-medium uppercase tracking-widest text-board-muted w-16">#</th>
                  <th className="px-4 py-3 text-left text-[10px] font-medium uppercase tracking-widest text-board-muted">Item</th>
                  <th className="px-4 py-3 text-left text-[10px] font-medium uppercase tracking-widest text-board-muted">Camera</th>
                  <th className="px-4 py-3 text-left text-[10px] font-medium uppercase tracking-widest text-board-muted">Notes</th>
                  <th className="px-4 py-3 w-20" />
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-b border-board-border last:border-0 hover:bg-board-card/50 group">
                    <td className="px-4 py-3 text-sm font-mono text-fire-500 font-semibold">{item.cueNumber}</td>
                    <td className="px-4 py-3 text-sm text-board-text">{item.rundownItem}</td>
                    <td className="px-4 py-3 text-sm text-board-muted">{item.cameraAssignments || "—"}</td>
                    <td className="px-4 py-3 text-sm text-board-muted">{item.notes || "—"}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => startEdit(item)} className="p-1.5 rounded-lg hover:bg-board-border text-board-muted hover:text-board-text"><Pencil className="w-3.5 h-3.5" /></button>
                        <button onClick={() => handleDelete(item.id)} className="p-1.5 rounded-lg hover:bg-red-500/20 text-board-muted hover:text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-center py-16">
            <p className="text-board-muted text-sm">No cues for this date yet.</p>
          </div>
        )}

        {/* Inline form */}
        {(showForm || editingItem) && (
          <form onSubmit={editingItem ? handleUpdate : handleAdd} className="mt-4 p-4 rounded-xl bg-board-card border border-board-border space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-board-text">{editingItem ? "Edit Cue" : "New Cue"}</h3>
              <button type="button" onClick={() => { setShowForm(false); setEditingItem(null); }} className="text-board-muted hover:text-board-text"><X className="w-4 h-4" /></button>
            </div>
            <input value={form.rundownItem} onChange={(e) => setForm({ ...form, rundownItem: e.target.value })} placeholder="Rundown item..." className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-sm text-board-text placeholder:text-board-muted/50 outline-none focus:border-fire-500/50 focus:ring-1 focus:ring-fire-500/20" />
            <div className="grid grid-cols-2 gap-3">
              <input value={form.cameraAssignments} onChange={(e) => setForm({ ...form, cameraAssignments: e.target.value })} placeholder="Camera assignments..." className="px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-sm text-board-text placeholder:text-board-muted/50 outline-none focus:border-fire-500/50 focus:ring-1 focus:ring-fire-500/20" />
              <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Notes..." className="px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-sm text-board-text placeholder:text-board-muted/50 outline-none focus:border-fire-500/50 focus:ring-1 focus:ring-fire-500/20" />
            </div>
            <button type="submit" className="px-4 py-2.5 rounded-xl font-semibold text-sm text-black transition-all hover:shadow-lg hover:shadow-fire-500/20 active:scale-[0.98]" style={{ background: "linear-gradient(135deg, #FFC107 0%, #FF8F00 100%)" }}>
              {editingItem ? "Update" : "Add Cue"}
            </button>
          </form>
        )}
      </div>
      {ConfirmDialogEl}
    </div>
  );
}
