import { createFileRoute } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { useState, useMemo } from "react";
import { Package, Plus, Search, X, Pencil, Trash2 } from "lucide-react";
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
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingItem, setEditingItem] = useState<EquipmentItem | null>(null);
  const [form, setForm] = useState({ name: "", category: "Audio", status: "operational", location: "", serialNumber: "", notes: "" });
  const { confirm, ConfirmDialogEl } = useConfirmDialog();

  const filtered = useMemo(() => {
    if (!search.trim()) return equipment;
    const q = search.toLowerCase();
    return equipment.filter(
      (e) => e.name.toLowerCase().includes(q) || e.category.toLowerCase().includes(q) || e.location?.toLowerCase().includes(q)
    );
  }, [equipment, search]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    await addEquipment({ data: { orgId, ...form } });
    resetForm();
    router.invalidate();
  };

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingItem) return;
    await updateEquipment({ data: { id: editingItem.id, updates: form } });
    resetForm();
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
    setForm({ name: item.name, category: item.category, status: item.status, location: item.location, serialNumber: item.serialNumber, notes: item.notes });
    setShowForm(false);
  };

  const resetForm = () => {
    setShowForm(false);
    setEditingItem(null);
    setForm({ name: "", category: "Audio", status: "operational", location: "", serialNumber: "", notes: "" });
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold font-[family-name:var(--font-display)] text-board-text">Asset Inventory</h1>
          <p className="text-board-muted text-sm mt-0.5">Track and manage production equipment, gear, and assets</p>
        </div>
        <button
          onClick={() => { setShowForm(true); setEditingItem(null); setForm({ name: "", category: "Audio", status: "operational", location: "", serialNumber: "", notes: "" }); }}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-sm text-black transition-all hover:shadow-lg hover:shadow-fire-500/20 active:scale-[0.98]"
          style={{ background: "linear-gradient(135deg, #FFC107 0%, #FF8F00 100%)" }}
        >
          <Plus className="w-4 h-4" />
          Add Item
        </button>
      </div>

      {/* Search */}
      <div className="relative mb-5">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-board-muted pointer-events-none" />
        <input type="text" placeholder="Search equipment..." value={search} onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-10 pr-10 py-2.5 rounded-xl bg-board-card border border-board-border text-sm text-board-text placeholder:text-board-muted/50 outline-none focus:border-fire-500/50 focus:ring-1 focus:ring-fire-500/20 transition-all" />
        {search && <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-board-muted"><X className="w-3.5 h-3.5" /></button>}
      </div>

      {/* Grid */}
      {filtered.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((item) => (
            <div key={item.id} className="group p-4 rounded-xl bg-board-card border border-board-border hover:border-fire-500/20 transition-all">
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
            </div>
          ))}
        </div>
      ) : (
        <div className="text-center py-16">
          <Package className="w-8 h-8 text-board-muted/30 mx-auto mb-3" />
          <p className="text-board-muted text-sm">{search ? "No matching equipment" : "No equipment added yet."}</p>
        </div>
      )}

      {/* Form */}
      {(showForm || editingItem) && (
        <form onSubmit={editingItem ? handleUpdate : handleAdd} className="mt-4 p-4 rounded-xl bg-board-card border border-board-border space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-board-text">{editingItem ? "Edit Item" : "New Item"}</h3>
            <button type="button" onClick={resetForm} className="text-board-muted hover:text-board-text"><X className="w-4 h-4" /></button>
          </div>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Equipment name..." className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-sm text-board-text placeholder:text-board-muted/50 outline-none focus:border-fire-500/50 focus:ring-1 focus:ring-fire-500/20" />
          <div className="grid grid-cols-2 gap-3">
            <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="px-3 py-2.5 rounded-xl bg-board-bg border border-board-border text-sm text-board-text outline-none focus:border-fire-500/50">
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className="px-3 py-2.5 rounded-xl bg-board-bg border border-board-border text-sm text-board-text outline-none focus:border-fire-500/50">
              <option value="operational">Operational</option>
              <option value="maintenance">Maintenance</option>
              <option value="broken">Broken</option>
              <option value="retired">Retired</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="Location..." className="px-3 py-2.5 rounded-xl bg-board-bg border border-board-border text-sm text-board-text placeholder:text-board-muted/50 outline-none focus:border-fire-500/50" />
            <input value={form.serialNumber} onChange={(e) => setForm({ ...form, serialNumber: e.target.value })} placeholder="Serial number..." className="px-3 py-2.5 rounded-xl bg-board-bg border border-board-border text-sm text-board-text placeholder:text-board-muted/50 outline-none focus:border-fire-500/50" />
          </div>
          <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Notes..." className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-sm text-board-text placeholder:text-board-muted/50 outline-none focus:border-fire-500/50 focus:ring-1 focus:ring-fire-500/20" />
          <button type="submit" disabled={!form.name.trim()} className="px-4 py-2.5 rounded-xl font-semibold text-sm text-black disabled:opacity-50 transition-all hover:shadow-lg hover:shadow-fire-500/20 active:scale-[0.98]" style={{ background: "linear-gradient(135deg, #FFC107 0%, #FF8F00 100%)" }}>
            {editingItem ? "Update" : "Add Item"}
          </button>
        </form>
      )}
      {ConfirmDialogEl}
    </div>
  );
}
