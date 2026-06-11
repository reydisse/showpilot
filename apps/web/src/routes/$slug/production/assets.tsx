import { createFileRoute } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { useState, useMemo } from "react";
import { Package, Plus, Search, X, Pencil, Trash2, ChevronDown } from "lucide-react";
import { EmptyState, EmptyStateButton } from "@/components/ui/empty-state";
import { useRouter } from "@tanstack/react-router";
import { getEquipment, addEquipment, updateEquipment, deleteEquipment } from "@/lib/data";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";

type EquipmentItem = {
  id: string;
  name: string;
  category: string;
  status: string;
  location: string;
  serialNumber: string;
  notes: string;
};

const STATUS_COLORS: Record<string, string> = {
  operational: "bg-green-500/15 text-green-400 border-green-500/25",
  maintenance: "bg-yellow-500/15 text-yellow-400 border-yellow-500/25",
  broken: "bg-red-500/15 text-red-400 border-red-500/25",
  retired: "bg-board-border text-board-muted border-board-border",
};

const CATEGORIES = ["Audio", "Video", "Lighting", "Streaming", "Network", "Power", "Cables", "Other"];

const BLANK_FORM = { name: "", category: "Audio", status: "operational", location: "", serialNumber: "", notes: "" };

export const Route = createFileRoute("/$slug/production/assets")({
  pendingComponent: () => <PageSkeleton />,
  loader: async ({ context }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, "assets:view", context.slug, context.orgId);
    const equipment = await getEquipment({ data: { orgId: context.orgId } });
    return { equipment: equipment as EquipmentItem[], orgId: context.orgId };
  },
  component: AssetsPage,
});

function AssetsPage() {
  const { equipment, orgId } = Route.useLoaderData();
  const router = useRouter();

  // Filter state
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  // Add modal state
  const [showAddModal, setShowAddModal] = useState(false);
  const [addForm, setAddForm] = useState(BLANK_FORM);
  const [adding, setAdding] = useState(false);

  // Edit inline state
  const [editingItem, setEditingItem] = useState<EquipmentItem | null>(null);
  const [editForm, setEditForm] = useState(BLANK_FORM);

  const { confirm, ConfirmDialogEl } = useConfirmDialog();

  // Dynamic category values from current equipment
  const availableCategories = useMemo(() => {
    const cats = new Set(equipment.map((e) => e.category).filter(Boolean));
    return Array.from(cats).sort();
  }, [equipment]);

  const hasFilters = search.trim() !== "" || categoryFilter !== "" || statusFilter !== "";

  const filtered = useMemo(() => {
    return equipment.filter((e) => {
      if (search.trim() && !e.name.toLowerCase().includes(search.toLowerCase())) return false;
      if (categoryFilter && e.category !== categoryFilter) return false;
      if (statusFilter && e.status !== statusFilter) return false;
      return true;
    });
  }, [equipment, search, categoryFilter, statusFilter]);

  const clearFilters = () => {
    setSearch("");
    setCategoryFilter("");
    setStatusFilter("");
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addForm.name.trim()) return;
    setAdding(true);
    try {
      await addEquipment({ data: { orgId, ...addForm } });
      setShowAddModal(false);
      setAddForm(BLANK_FORM);
      router.invalidate();
    } finally {
      setAdding(false);
    }
  };

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingItem) return;
    await updateEquipment({ data: { id: editingItem.id, updates: editForm } });
    setEditingItem(null);
    router.invalidate();
  };

  const handleDelete = async (id: string) => {
    const ok = await confirm({
      title: "Delete item",
      description: "Delete this equipment item? This action cannot be undone.",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    await deleteEquipment({ data: { id } });
    router.invalidate();
  };

  const startEdit = (item: EquipmentItem) => {
    setEditingItem(item);
    setEditForm({ name: item.name, category: item.category, status: item.status, location: item.location, serialNumber: item.serialNumber, notes: item.notes });
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold font-[family-name:var(--font-display)] text-board-text">Asset Inventory</h1>
          <p className="text-board-muted text-sm mt-0.5">Track and manage production equipment, gear, and assets</p>
        </div>
        <button
          onClick={() => { setAddForm(BLANK_FORM); setShowAddModal(true); }}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-sm text-black transition-all hover:shadow-lg hover:shadow-fire-500/20 active:scale-[0.98]"
          style={{ background: "linear-gradient(135deg, #FFC107 0%, #FF8F00 100%)" }}
        >
          <Plus className="w-4 h-4" />
          Add Item
        </button>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap gap-2 mb-5">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-board-muted pointer-events-none" />
          <input
            type="text"
            placeholder="Search by name..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-8 py-2.5 rounded-xl bg-board-card border border-board-border text-sm text-board-text placeholder:text-board-muted/50 outline-none focus:border-fire-500/50 focus:ring-1 focus:ring-fire-500/20 transition-all"
          />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-board-muted">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <div className="relative">
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="appearance-none pl-3 pr-8 py-2.5 rounded-xl bg-board-card border border-board-border text-sm text-board-text outline-none focus:border-fire-500/50 cursor-pointer"
          >
            <option value="">All Types</option>
            {availableCategories.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-board-muted pointer-events-none" />
        </div>

        <div className="relative">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="appearance-none pl-3 pr-8 py-2.5 rounded-xl bg-board-card border border-board-border text-sm text-board-text outline-none focus:border-fire-500/50 cursor-pointer"
          >
            <option value="">All Status</option>
            <option value="operational">Operational</option>
            <option value="maintenance">Maintenance</option>
            <option value="broken">Broken</option>
            <option value="retired">Retired</option>
          </select>
          <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-board-muted pointer-events-none" />
        </div>

        {hasFilters && (
          <button
            onClick={clearFilters}
            className="px-3 py-2.5 rounded-xl text-sm text-board-muted hover:text-board-text hover:bg-board-border/50 transition-colors"
          >
            Clear Filters
          </button>
        )}
      </div>

      {/* Grid */}
      {filtered.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((item) => (
            <div key={item.id} className="group p-4 rounded-xl bg-board-card border border-board-border hover:border-fire-500/20 transition-all">
              {editingItem?.id === item.id ? (
                <form onSubmit={handleUpdate} className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-board-text">Edit Item</h3>
                    <button type="button" onClick={() => setEditingItem(null)} className="text-board-muted hover:text-board-text"><X className="w-4 h-4" /></button>
                  </div>
                  <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} placeholder="Equipment name..." className="w-full px-3 py-2 rounded-xl bg-board-bg border border-board-border text-sm text-board-text placeholder:text-board-muted/50 outline-none focus:border-fire-500/50" />
                  <div className="grid grid-cols-2 gap-2">
                    <select value={editForm.category} onChange={(e) => setEditForm({ ...editForm, category: e.target.value })} className="px-2 py-2 rounded-xl bg-board-bg border border-board-border text-sm text-board-text outline-none focus:border-fire-500/50">
                      {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <select value={editForm.status} onChange={(e) => setEditForm({ ...editForm, status: e.target.value })} className="px-2 py-2 rounded-xl bg-board-bg border border-board-border text-sm text-board-text outline-none focus:border-fire-500/50">
                      <option value="operational">Operational</option>
                      <option value="maintenance">Maintenance</option>
                      <option value="broken">Broken</option>
                      <option value="retired">Retired</option>
                    </select>
                  </div>
                  <input value={editForm.location} onChange={(e) => setEditForm({ ...editForm, location: e.target.value })} placeholder="Location..." className="w-full px-3 py-2 rounded-xl bg-board-bg border border-board-border text-sm text-board-text placeholder:text-board-muted/50 outline-none focus:border-fire-500/50" />
                  <input value={editForm.serialNumber} onChange={(e) => setEditForm({ ...editForm, serialNumber: e.target.value })} placeholder="Serial number..." className="w-full px-3 py-2 rounded-xl bg-board-bg border border-board-border text-sm text-board-text placeholder:text-board-muted/50 outline-none focus:border-fire-500/50" />
                  <input value={editForm.notes} onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })} placeholder="Notes..." className="w-full px-3 py-2 rounded-xl bg-board-bg border border-board-border text-sm text-board-text placeholder:text-board-muted/50 outline-none focus:border-fire-500/50" />
                  <button type="submit" disabled={!editForm.name.trim()} className="w-full px-3 py-2 rounded-xl font-semibold text-sm text-black disabled:opacity-50 transition-all" style={{ background: "linear-gradient(135deg, #FFC107 0%, #FF8F00 100%)" }}>
                    Update
                  </button>
                </form>
              ) : (
                <>
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <Package className="w-4 h-4 text-fire-500/70" />
                      <p className="text-sm font-medium text-board-text">{item.name}</p>
                    </div>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={() => startEdit(item)} className="p-1 rounded-lg hover:bg-board-border text-board-muted hover:text-board-text"><Pencil className="w-3 h-3" /></button>
                      <button onClick={() => handleDelete(item.id)} className="p-1 rounded-lg hover:bg-red-500/20 text-board-muted hover:text-red-400"><Trash2 className="w-3 h-3" /></button>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mt-2">
                    <span className={`text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded border ${STATUS_COLORS[item.status] || STATUS_COLORS.operational}`}>{item.status}</span>
                    <span className="text-[10px] text-board-muted bg-board-bg px-1.5 py-0.5 rounded border border-board-border">{item.category}</span>
                  </div>
                  {item.location && <p className="text-[11px] text-board-muted mt-2">{item.location}</p>}
                  {item.serialNumber && <p className="text-[10px] font-mono text-board-muted/60 mt-1">S/N: {item.serialNumber}</p>}
                </>
              )}
            </div>
          ))}
        </div>
      ) : hasFilters ? (
        <div className="text-center py-16">
          <Package className="w-8 h-8 text-board-muted/30 mx-auto mb-3" />
          <p className="text-board-muted text-sm mb-3">No assets match your filters.</p>
          <button
            onClick={clearFilters}
            className="px-4 py-2 rounded-xl text-sm text-board-muted border border-board-border hover:bg-board-border/50 transition-colors"
          >
            Clear Filters
          </button>
        </div>
      ) : (
        <EmptyState
          icon={Package}
          title="No equipment yet"
          description="Track cameras, mixers, cables and the rest of your gear — status, location and serial numbers in one place."
          action={
            <EmptyStateButton onClick={() => { setAddForm(BLANK_FORM); setShowAddModal(true); }}>
              Add first item
            </EmptyStateButton>
          }
        />
      )}

      {/* Add Asset Modal */}
      {showAddModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) { setShowAddModal(false); setAddForm(BLANK_FORM); } }}
        >
          <div className="bg-board-card border border-board-border rounded-2xl p-6 w-full max-w-sm mx-4 shadow-2xl">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-semibold text-board-text">Add New Asset</h2>
              <button
                onClick={() => { setShowAddModal(false); setAddForm(BLANK_FORM); }}
                className="p-1 rounded-lg hover:bg-board-border transition-colors text-board-muted"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleAdd} className="space-y-4">
              <div>
                <label className="block text-xs text-board-muted mb-1.5">Name <span className="text-red-400">*</span></label>
                <input
                  type="text"
                  value={addForm.name}
                  onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
                  placeholder="Equipment name..."
                  autoFocus
                  className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-sm text-board-text placeholder:text-board-muted/50 outline-none focus:border-fire-500/50 focus:ring-1 focus:ring-fire-500/20 transition-colors"
                />
              </div>
              <div>
                <label className="block text-xs text-board-muted mb-1.5">Type / Category</label>
                <select
                  value={addForm.category}
                  onChange={(e) => setAddForm({ ...addForm, category: e.target.value })}
                  className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-sm text-board-text outline-none focus:border-fire-500/50 transition-colors"
                >
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-board-muted mb-1.5">Status</label>
                <div className="flex gap-2">
                  {(["operational", "broken", "retired"] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setAddForm({ ...addForm, status: s })}
                      className={`flex-1 py-2 rounded-xl text-xs font-medium capitalize border transition-colors ${
                        addForm.status === s
                          ? s === "operational"
                            ? "bg-green-500/20 text-green-400 border-green-500/40"
                            : s === "broken"
                              ? "bg-red-500/20 text-red-400 border-red-500/40"
                              : "bg-board-border text-board-muted border-board-border"
                          : "bg-board-bg text-board-muted/60 border-board-border hover:border-board-muted/40"
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs text-board-muted mb-1.5">Notes</label>
                <input
                  type="text"
                  value={addForm.notes}
                  onChange={(e) => setAddForm({ ...addForm, notes: e.target.value })}
                  placeholder="Optional notes..."
                  className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-sm text-board-text placeholder:text-board-muted/50 outline-none focus:border-fire-500/50 transition-colors"
                />
              </div>
              <div className="flex gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => { setShowAddModal(false); setAddForm(BLANK_FORM); }}
                  className="flex-1 px-4 py-2.5 rounded-xl border border-board-border text-sm text-board-muted hover:bg-board-border/50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={adding || !addForm.name.trim()}
                  className="flex-1 px-4 py-2.5 rounded-xl font-semibold text-sm text-black disabled:opacity-50 transition-all hover:shadow-lg hover:shadow-fire-500/20 active:scale-[0.98]"
                  style={{ background: "linear-gradient(135deg, #FFC107 0%, #FF8F00 100%)" }}
                >
                  {adding ? "Adding..." : "Add Asset"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {ConfirmDialogEl}
    </div>
  );
}
