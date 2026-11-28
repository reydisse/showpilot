import { plainFailure } from "@showpilot/shared/ui-feedback";
import { createFileRoute } from "@tanstack/react-router";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Archive, ChevronRight, CircleAlert, MoreHorizontal, Package, Pencil, Plus, RotateCw, Search, Trash2, TriangleAlert, X } from "lucide-react";
import {
  EQUIPMENT_CATEGORIES,
  EQUIPMENT_CATEGORY_LABELS,
  EQUIPMENT_STATUSES,
  isEquipmentCategory,
  isEquipmentStatus,
  type EquipmentCategory,
  type EquipmentStatus,
} from "@showpilot/shared";
import { getEquipmentState } from "@/lib/equipment-commands";
import { useEquipmentCommands } from "@/hooks/useEquipmentCommands";
import { EquipmentRecovery } from "@/components/EquipmentRecovery";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ModalA, modalCancel, modalPrimary } from "@/components/schedule/modal-a";
import {
  ATTENTION,
  Checkbox,
  GroupControl,
  MultiFilter,
  SortMenu,
  StatusBar,
  StatusMark,
  StatusPicker,
  StatusSummary,
  SummaryStrip,
  TypeIcon,
  statusLabel,
  statusMeta,
  typeLabel,
  unitNumber,
  chip,
  type GroupBy,
  type SortKey,
  type Unit,
} from "@/components/assets/assets-a";

export const Route = createFileRoute("/$slug/production/assets")({
  pendingComponent: () => <AssetsSkeleton />,
  loader: async ({ context }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, "assets:view", context.slug, context.orgId);
    return await getEquipmentState({ data: { orgId: context.orgId } });
  },
  component: AssetsPage,
});

type Item = { key: string; name: string; category: string; units: Unit[] };
type UnitFields = Pick<Unit, "status" | "location" | "serialNumber" | "notes">;
type DrawerDraft = { key: string; name: string; category: string; base: Unit[]; units: Record<string, UnitFields> };

const SORT_STORAGE = "showpilot:assets-sort";
const itemKey = (unit: Pick<Unit, "name" | "category">) => `${unit.name.trim().toLowerCase()}::${unit.category.trim().toLowerCase()}`;
const sharedLocation = (units: Unit[]) => {
  const values = new Set(units.map(unit => unit.location.trim()));
  return values.size === 1 ? [...values][0] || "—" : `${values.size} locations`;
};
const worst = (units: Unit[]) => Math.min(...units.map(unit => statusMeta(unit.status).rank));
const iconButton = "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-[var(--sa-ink-3)] hover:bg-[var(--sa-surface-3)] hover:text-board-text lg:h-8 lg:w-8";
const reveal = "lg:[@media(hover:hover)_and_(pointer:fine)]:opacity-0 lg:[@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 lg:[@media(hover:hover)_and_(pointer:fine)]:focus-within:opacity-100 lg:[@media(hover:hover)_and_(pointer:fine)]:has-[[data-state=open]]:opacity-100";

function AssetsPage() {
  const control = useEquipmentCommands(Route.useLoaderData());
  const { equipment, canManage } = control.read.data;
  const locked = control.unavailable || control.unresolved;
  const { addForm } = control.draft;
  const setAddForm = (value: typeof addForm) => control.setDrafts({ addForm: value });

  const [search, setSearch] = useState("");
  const [types, setTypes] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "name", dir: "asc" });
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showAdd, setShowAdd] = useState(false);
  const [addTried, setAddTried] = useState(false);
  const [drawer, setDrawer] = useState<DrawerDraft | null>(null);
  const [drawerError, setDrawerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [discardAsk, setDiscardAsk] = useState(false);
  const [removeAsk, setRemoveAsk] = useState<{ unit: Unit; item: Item } | { item: Item } | null>(null);
  const [pageError, setPageError] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  // Dialogs here unmount on close, so focus is handed back to whatever opened them.
  const returnFocus = useRef<HTMLElement | null>(null);
  const rememberFocus = () => { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; };
  const restoreFocus = () => { const target = returnFocus.current; returnFocus.current = null; requestAnimationFrame(() => { if (target?.isConnected) target.focus(); }); };
  const openAdd = () => { rememberFocus(); setAddTried(false); setShowAdd(true); };
  // Dismissing clears the draft, unless a save is still unresolved (its draft is the retry evidence).
  const closeAdd = () => {
    setShowAdd(false);
    if (!control.unresolved) setAddForm({ name: "", category: "audio", status: "operational", location: "", serialNumber: "", notes: "", quantity: 1 });
    restoreFocus();
  };

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SORT_STORAGE) ?? "null");
      if (saved && ["name", "type", "status", "location"].includes(saved.key) && ["asc", "desc"].includes(saved.dir)) setSort(saved);
    } catch { /* Sorting still works without saved preferences. */ }
  }, []);
  const changeSort = (key: SortKey, dir: "asc" | "desc") => {
    setSort({ key, dir });
    try { localStorage.setItem(SORT_STORAGE, JSON.stringify({ key, dir })); } catch { /* Not saved; still applied. */ }
  };

  const items = useMemo(() => {
    const groups = new Map<string, Item>();
    for (const unit of equipment) {
      const key = itemKey(unit);
      const group = groups.get(key) ?? { key, name: unit.name, category: unit.category, units: [] };
      group.units.push(unit);
      groups.set(key, group);
    }
    // Stable unit numbers: by serial number (natural order), then location, then id.
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    for (const group of groups.values()) group.units.sort((a, b) => collator.compare(a.serialNumber || "\uffff", b.serialNumber || "\uffff") || collator.compare(a.location, b.location) || a.id.localeCompare(b.id));
    return [...groups.values()];
  }, [equipment]);

  const query = search.trim().toLowerCase();
  const visible = useMemo(() => {
    const list = items.filter(item =>
      (!query || item.name.toLowerCase().includes(query)) &&
      (!types.length || types.includes(item.category)) &&
      (!statuses.length || item.units.some(unit => statuses.includes(unit.status))));
    const by = (item: Item) => sort.key === "name" ? item.name.toLowerCase() : sort.key === "type" ? typeLabel(item.category) : sort.key === "location" ? sharedLocation(item.units).toLowerCase() : "";
    list.sort((a, b) => {
      const order = sort.key === "status" ? worst(a.units) - worst(b.units) : by(a).localeCompare(by(b)) || a.name.localeCompare(b.name);
      return sort.dir === "asc" ? order : -order;
    });
    return list;
  }, [items, query, types, statuses, sort]);

  const sections = useMemo(() => {
    if (groupBy === "none") return [{ key: "all", label: null as string | null, category: null as string | null, items: visible }];
    const map = new Map<string, Item[]>();
    for (const item of visible) {
      const label = groupBy === "type" ? typeLabel(item.category) : sharedLocation(item.units);
      map.set(label, [...(map.get(label) ?? []), item]);
    }
    return [...map].sort((a, b) => a[0].localeCompare(b[0])).map(([label, list]) => ({ key: label, label, category: groupBy === "type" ? list[0].category : null, items: list }));
  }, [visible, groupBy]);

  const filtered = !!query || types.length > 0 || statuses.length > 0;
  const visibleUnits = visible.flatMap(item => item.units);
  const allVisibleSelected = visibleUnits.length > 0 && visibleUnits.every(unit => selected.has(unit.id));
  const selectedUnits = equipment.filter(unit => selected.has(unit.id));
  useEffect(() => {
    // Units that disappeared (deleted elsewhere) leave the selection.
    setSelected(current => { const next = new Set([...current].filter(id => equipment.some(unit => unit.id === id))); return next.size === current.size ? current : next; });
  }, [equipment]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key === "/" && !target?.closest("input, textarea, select, [contenteditable=true]")) { event.preventDefault(); searchRef.current?.focus(); }
      if (event.key === "Escape" && selected.size && !document.querySelector('[role="dialog"], [role="menu"]')) setSelected(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected.size]);

  const toggle = (set: Set<string>, ids: string[], on: boolean) => { const next = new Set(set); for (const id of ids) on ? next.add(id) : next.delete(id); return next; };
  const toggleExpanded = (key: string) => setExpanded(current => toggle(current, [key], !current.has(key)));
  const clearFilters = () => { setSearch(""); setTypes([]); setStatuses([]); };

  const send = async (operation: unknown, label: string) => {
    setPageError("");
    const result = await control.send(operation, label);
    if (result?.outcome === "conflict") setPageError("This changed on another device first. The inventory now shows the latest version; try again.");
    return result;
  };
  const setStatusFor = (units: Unit[], status: EquipmentStatus) => {
    const changes = units.filter(unit => unit.status !== status).map(unit => ({ id: unit.id, expectedRevision: unit.revision, updates: { status } }));
    if (!changes.length) return Promise.resolve(null);
    return send({ kind: "batch", changes }, `Set ${changes.length} ${changes.length === 1 ? "unit" : "units"} to ${statusLabel(status)}`);
  };
  const addUnit = (item: Item) => {
    const first = item.units[0];
    if (!isEquipmentCategory(first.category)) { setPageError("Choose a supported type for this item before adding units."); return; }
    void send({ kind: "create", quantity: 1, fields: { name: first.name, category: first.category, status: "operational", location: first.location, serialNumber: "", notes: "" } }, `Add a unit to ${first.name}`);
  };

  // ─── Detail drawer ──
  const openDrawer = (item: Item) => {
    rememberFocus();
    setDrawerError(null);
    setDrawer({ key: item.key, name: item.name, category: item.category, base: item.units, units: Object.fromEntries(item.units.map(unit => [unit.id, { status: unit.status, location: unit.location, serialNumber: unit.serialNumber, notes: unit.notes }])) });
  };
  const drawerItem = drawer ? items.find(item => item.key === drawer.key) ?? null : null;
  const unitChanged = (unit: Unit) => {
    const edit = drawer?.units[unit.id];
    return !!edit && (["status", "location", "serialNumber", "notes"] as const).filter(field => edit[field] !== unit[field]);
  };
  const changeCount = drawer ? (drawer.name.trim() !== drawer.base[0]?.name ? 1 : 0) + (drawer.category !== drawer.base[0]?.category ? 1 : 0) + drawer.base.reduce((sum, unit) => sum + (unitChanged(unit) || []).length, 0) : 0;
  const closeDrawer = (force = false) => { if (!force && changeCount) { setDiscardAsk(true); return; } setDrawer(null); setDiscardAsk(false); restoreFocus(); };
  const saveDrawer = async () => {
    if (!drawer || !changeCount || saving) return;
    const name = drawer.name.trim();
    if (!name) { setDrawerError("Give this item a name before saving."); return; }
    if (!isEquipmentCategory(drawer.category)) { setDrawerError("Choose a supported type before saving."); return; }
    const changes = [];
    for (const unit of drawer.base) {
      const edit = drawer.units[unit.id];
      const updates: Partial<{ name: string; category: EquipmentCategory; status: EquipmentStatus; location: string; serialNumber: string; notes: string }> = {};
      if (name !== unit.name) updates.name = name;
      if (drawer.category !== unit.category) updates.category = drawer.category;
      if (edit.status !== unit.status) {
        if (!isEquipmentStatus(edit.status)) { setDrawerError("Choose a supported status before saving."); return; }
        updates.status = edit.status;
      }
      if (edit.location !== unit.location) updates.location = edit.location;
      if (edit.serialNumber !== unit.serialNumber) updates.serialNumber = edit.serialNumber;
      if (edit.notes !== unit.notes) updates.notes = edit.notes;
      if (Object.keys(updates).length) changes.push({ id: unit.id, expectedRevision: unit.revision, updates });
    }
    setSaving(true); setDrawerError(null);
    const result = await control.send({ kind: "batch", changes }, `Save ${name}`);
    setSaving(false);
    if (result?.outcome === "applied") { setDrawer(null); restoreFocus(); return; }
    // A lost response is recovered with the exact same request (Retry below), never a fresh save.
    if (result?.outcome === "conflict") setDrawerError("Someone changed this item first. Your edits are still here — review the latest values, then save again.");
    else if (!control.unresolved) setDrawerError("Couldn't save your changes. They're still here. Check your connection and save again.");
  };
  // A recovered save (Retry) lands while the drawer is open: once the saved values match, close it.
  useEffect(() => {
    if (!drawer || !drawerItem || control.unresolved) return;
    const matches = drawerItem.units.length === drawer.base.length && drawerItem.units.every(unit => {
      const edit = drawer.units[unit.id];
      return edit && unit.name === drawer.name.trim() && unit.category === drawer.category && edit.status === unit.status && edit.location === unit.location && edit.serialNumber === unit.serialNumber && edit.notes === unit.notes;
    });
    if (matches && drawerItem.units.some(unit => unit.revision !== drawer.base.find(base => base.id === unit.id)?.revision)) setDrawer(null);
  }, [equipment]); // eslint-disable-line react-hooks/exhaustive-deps
  // After a conflict, keep every edit but compare against the latest saved revisions.
  const rebaseDrawer = () => {
    if (!drawer || !drawerItem) return;
    const units = { ...drawer.units };
    for (const unit of drawerItem.units) units[unit.id] ??= { status: unit.status, location: unit.location, serialNumber: unit.serialNumber, notes: unit.notes };
    setDrawer({ ...drawer, key: drawerItem.key, base: drawerItem.units, units });
    setDrawerError(null);
    control.dismiss(); // The operator has reviewed the conflict; the next Save is a fresh, informed change.
  };

  const removeUnit = async (unit: Unit, retire: boolean) => {
    setRemoveAsk(null);
    if (retire) await setStatusFor([unit], "retired");
    else await send({ kind: "delete", id: unit.id, expectedRevision: unit.revision }, `Delete ${unit.name}`);
  };
  const removeItem = async (item: Item, retire: boolean) => {
    setRemoveAsk(null);
    if (retire) await setStatusFor(item.units, "retired");
    else await send({ kind: "batch", changes: item.units.map(unit => ({ id: unit.id, expectedRevision: unit.revision, remove: true as const })) }, `Delete ${item.name}`);
  };

  const handleAdd = async (event: React.FormEvent) => {
    event.preventDefault();
    setAddTried(true);
    if (!addForm.name.trim()) return;
    const result = await control.send({ kind: "create", fields: { ...addForm, name: addForm.name.trim() }, quantity: addForm.quantity }, `Add ${addForm.quantity} × ${addForm.name.trim()}`);
    if (result?.outcome === "applied") { closeAdd(); setAddTried(false); }
  };

  const typeCounts = (category: string) => items.filter(item => item.category === category).length;
  const statusCounts = (status: string) => equipment.filter(unit => unit.status === status).length;
  const unitMenu = (unit: Unit, item: Item) => <DropdownMenu>
    <DropdownMenuTrigger asChild><button type="button" className={iconButton} aria-label={`Actions for unit ${unitNumber(item.units.indexOf(unit))} of ${item.name}`}><MoreHorizontal className="h-4 w-4" /></button></DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="schedule-a min-w-[200px]">
      <DropdownMenuItem onSelect={() => openDrawer(item)}><Pencil className="h-3.5 w-3.5" />Edit unit</DropdownMenuItem>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger><RotateCw className="h-3.5 w-3.5" />Change status</DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="schedule-a">
          {EQUIPMENT_STATUSES.map(status => <DropdownMenuItem key={status} disabled={unit.status === status} onSelect={() => void setStatusFor([unit], status)}><StatusMark status={status} /></DropdownMenuItem>)}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={unit.status === "retired"} onSelect={() => void setStatusFor([unit], "retired")}><Archive className="h-3.5 w-3.5" />Retire unit</DropdownMenuItem>
      <DropdownMenuItem variant="destructive" onSelect={() => setRemoveAsk(item.units.length === 1 ? { item } : { unit, item })}><Trash2 className="h-3.5 w-3.5" />Delete unit…</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;

  const grid = "grid grid-cols-[44px_44px_minmax(0,1fr)_auto] items-center gap-x-2 xl:grid-cols-[40px_28px_minmax(0,1fr)_120px_56px_160px_minmax(200px,260px)_40px] xl:gap-x-3";
  const unitGrid = "grid grid-cols-[44px_36px_minmax(0,1fr)_auto] items-center gap-x-2 xl:grid-cols-[40px_44px_140px_160px_150px_minmax(0,1fr)_40px] xl:gap-x-3";

  return (
    <div className="schedule-a min-h-full bg-board-bg">
      <div className="mx-auto flex max-w-[1180px] min-[1800px]:max-w-[1680px] flex-col gap-5 px-4 pb-24 pt-6 md:px-8">
        <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="flex min-w-0 flex-col gap-1.5">
            <h1 className="text-[26px] font-semibold leading-[1.15] tracking-[-0.02em] text-board-text">Asset Inventory</h1>
            <p className="text-[13px] text-[var(--sa-ink-2)]">Track and manage production equipment, gear, and assets</p>
          </div>
          {canManage && items.length ? <button type="button" disabled={locked} onClick={openAdd}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-fire-500 px-3.5 text-[13px] font-semibold text-[#1a1300] hover:bg-fire-400 disabled:opacity-50 max-lg:h-11"><Plus className="h-3.5 w-3.5" strokeWidth={2.25} />Add Item</button> : null}
        </header>

        {pageError ? <p role="alert" className="flex items-center gap-2.5 rounded-xl border border-[var(--sa-danger)]/30 bg-[var(--sa-danger)]/[0.07] px-4 py-3 text-[13px] text-board-text"><CircleAlert aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--sa-danger)]" />{plainFailure(pageError)}<button type="button" onClick={() => setPageError("")} aria-label="Dismiss" className={`${iconButton} ml-auto`}><X className="h-3.5 w-3.5" /></button></p> : null}
        {!showAdd && !drawer ? <EquipmentRecovery control={control} /> : null}

        {items.length === 0 && !control.read.isError ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-[var(--sa-border-strong)] px-6 py-16 text-center">
            <span aria-hidden="true" className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-[var(--sa-surface-2)] text-[var(--sa-ink-2)]"><Package className="h-4 w-4" /></span>
            <h2 className="text-[15px] font-semibold text-board-text">No assets yet</h2>
            <p className="max-w-[400px] text-[13px] leading-[1.6] text-[var(--sa-ink-2)]">Add the gear your team uses. Each unit then gets its own status, serial number, location, and notes.</p>
            {canManage ? <button type="button" disabled={locked} onClick={openAdd} className="mt-1 inline-flex h-9 items-center gap-1.5 rounded-lg bg-fire-500 px-3.5 text-[13px] font-semibold text-[#1a1300] hover:bg-fire-400 max-lg:h-11"><Plus className="h-3.5 w-3.5" />Add Item</button> : null}
          </div>
        ) : items.length > 0 ? <>
          <SummaryStrip items={items.length} units={equipment} />

          <div className="flex flex-wrap items-center gap-2">
            <label className="relative min-w-[200px] flex-[1_1_240px] md:max-w-[260px]">
              <span className="sr-only">Search assets</span>
              <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--sa-ink-3)]" />
              <input ref={searchRef} value={search} onChange={event => setSearch(event.target.value)} placeholder="Search by name…" aria-label="Search assets" maxLength={120}
                className="h-9 w-full rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface)] pl-9 pr-9 text-base text-board-text outline-none placeholder:text-[var(--sa-ink-3)] focus:border-fire-500 lg:text-[13px] max-lg:h-11" />
              {search ? <button type="button" onClick={() => setSearch("")} aria-label="Clear asset search" className="absolute right-0 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center text-[var(--sa-ink-3)] hover:text-board-text max-lg:h-11 max-lg:w-11"><X className="h-3.5 w-3.5" /></button> : null}
            </label>
            <MultiFilter label="Type" allLabel="All types" value={types} onChange={setTypes} footer="Counts are items"
              options={EQUIPMENT_CATEGORIES.filter(category => typeCounts(category) || types.includes(category)).map(category => ({ value: category, label: EQUIPMENT_CATEGORY_LABELS[category], count: typeCounts(category), icon: <TypeIcon category={category} size="sm" /> }))} />
            <MultiFilter label="Status" allLabel="All status" value={statuses} onChange={setStatuses} footer="Counts are units"
              shortcut={{ label: "Needs attention", values: ATTENTION, count: equipment.filter(unit => ATTENTION.includes(unit.status)).length }}
              options={EQUIPMENT_STATUSES.map(status => ({ value: status, label: statusLabel(status), count: statusCounts(status), icon: (() => { const Icon = statusMeta(status).icon; return <Icon aria-hidden="true" className={`h-3.5 w-3.5 ${statusMeta(status).text}`} />; })(), tone: statusMeta(status).text }))} />
            <span className="ml-auto flex flex-wrap items-center gap-2">
              <SortMenu sort={sort.key} dir={sort.dir} onChange={changeSort} />
              <GroupControl value={groupBy} onChange={setGroupBy} />
            </span>
          </div>
          {filtered ? <div className="-mt-2 flex flex-wrap items-center gap-2">
            {types.map(type => <button key={type} type="button" onClick={() => setTypes(types.filter(t => t !== type))} aria-label={`Remove type filter ${typeLabel(type)}`} className={`${chip} h-7 rounded-full px-2.5 text-xs max-lg:h-9`}><span className="text-[var(--sa-ink-3)]">Type</span>{typeLabel(type)}<X aria-hidden="true" className="h-3 w-3" /></button>)}
            {statuses.length ? <button type="button" onClick={() => setStatuses([])} aria-label="Remove status filter" className={`${chip} h-7 rounded-full px-2.5 text-xs max-lg:h-9`}><span className="text-[var(--sa-ink-3)]">Status</span>{ATTENTION.every(s => statuses.includes(s)) && statuses.length === ATTENTION.length ? "Needs attention" : statuses.map(statusLabel).join(", ")}<X aria-hidden="true" className="h-3 w-3" /></button> : null}
            <button type="button" onClick={clearFilters} className="h-7 rounded-md px-2 text-xs font-medium text-board-text hover:bg-[var(--sa-surface-2)] max-lg:h-9">Clear all</button>
          </div> : null}

          <section aria-label="Assets" className="overflow-hidden rounded-xl border border-[var(--sa-border)] bg-[var(--sa-surface)]">
            <div className={`${grid} border-b border-[var(--sa-border)] pr-3 text-xs font-medium uppercase tracking-[0.07em] text-[var(--sa-ink-3)]`}>
              {canManage ? <Checkbox checked={allVisibleSelected} mixed={!allVisibleSelected && visibleUnits.some(unit => selected.has(unit.id))} label="Select all shown units" onChange={on => setSelected(current => toggle(current, visibleUnits.map(unit => unit.id), on))} className="justify-self-center" /> : <span />}
              <span />
              <button type="button" onClick={() => changeSort("name", sort.key === "name" && sort.dir === "asc" ? "desc" : "asc")} className="h-11 text-left uppercase hover:text-board-text xl:h-10">Name {sort.key === "name" ? sort.dir === "asc" ? "↑" : "↓" : ""}</button>
              <span className="hidden xl:block">Type</span>
              <span className="hidden text-right xl:block">Units</span>
              <span className="hidden xl:block">Location</span>
              <span className="hidden xl:block">Status</span>
              <span />
            </div>
            {visible.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
                <h2 className="text-[15px] font-semibold text-board-text">{query ? `No assets match “${search.trim()}”` : "No assets match these filters"}</h2>
                <p className="text-[13px] text-[var(--sa-ink-2)]">{query ? "Search looks at item names. Try part of a name, or clear the search." : "Try another type or status, or clear the filters."}</p>
                <button type="button" onClick={clearFilters} className="mt-2 inline-flex h-9 items-center rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface-2)] px-3.5 text-[13px] font-medium text-board-text hover:bg-[var(--sa-surface-3)] max-lg:h-11">{query && !types.length && !statuses.length ? "Clear search" : "Clear filters"}</button>
              </div>
            ) : sections.map(section => <Fragment key={section.key}>
              {section.label !== null ? <div className="flex items-center gap-3 border-b border-[var(--sa-border)] bg-board-bg px-4 py-2.5">
                {section.category ? <TypeIcon category={section.category} size="sm" /> : null}
                <span className="text-[13px] font-semibold text-board-text">{section.label}</span>
                <span className="tabular-nums text-xs text-[var(--sa-ink-3)]">{section.items.length} {section.items.length === 1 ? "item" : "items"} · {section.items.reduce((n, item) => n + item.units.length, 0)} units</span>
              </div> : null}
              {section.items.map(item => {
                const open = expanded.has(item.key);
                const ids = item.units.map(unit => unit.id);
                const all = ids.every(id => selected.has(id)), some = ids.some(id => selected.has(id));
                return <Fragment key={item.key}>
                  <div role="row" tabIndex={0} aria-expanded={open} aria-label={`${item.name}, ${item.units.length} ${item.units.length === 1 ? "unit" : "units"}`}
                    onClick={() => openDrawer(item)}
                    onKeyDown={event => { if (event.target !== event.currentTarget) return; if (event.key === " ") { event.preventDefault(); toggleExpanded(item.key); } if (event.key === "Enter") openDrawer(item); }}
                    className={`group ${grid} min-h-[52px] cursor-pointer border-b border-[var(--sa-border)] py-1 pr-3 outline-none hover:bg-[var(--sa-surface-2)] focus-visible:shadow-[inset_0_0_0_2px_var(--color-fire-500)] ${open || drawer?.key === item.key ? "bg-[var(--sa-surface-2)]" : ""} ${drawer?.key === item.key ? "shadow-[inset_2px_0_0_var(--color-fire-500)]" : ""}`}>
                    {canManage ? <Checkbox checked={all} mixed={!all && some} label={`Select ${item.name}`} onChange={on => setSelected(current => toggle(current, ids, on))} className={`justify-self-center ${all || some ? "" : reveal}`} /> : <span />}
                    <button type="button" onClick={event => { event.stopPropagation(); toggleExpanded(item.key); }} aria-label={`${open ? "Collapse" : "Expand"} ${item.name}`} aria-expanded={open} className="flex h-11 w-11 items-center justify-center text-[var(--sa-ink-3)] hover:text-board-text xl:h-8 xl:w-7">
                      <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
                    </button>
                    <span className="flex min-w-0 items-center gap-3"><TypeIcon category={item.category} /><span className="flex min-w-0 flex-col"><span className="truncate text-[13px] font-medium text-board-text">{item.name}</span><span className="truncate text-xs text-[var(--sa-ink-3)] xl:hidden">{typeLabel(item.category)} · {item.units.length} {item.units.length === 1 ? "unit" : "units"}</span><span className="md:hidden"><StatusSummary units={item.units} /></span></span></span>
                    <span className="hidden truncate text-[13px] text-[var(--sa-ink-2)] xl:block">{typeLabel(item.category)}</span>
                    <span className="hidden text-right tabular-nums text-[13px] text-board-text xl:block">{item.units.length}</span>
                    <span className="hidden truncate text-[13px] text-[var(--sa-ink-2)] xl:block">{sharedLocation(item.units)}</span>
                    <span className="flex min-w-0 items-center gap-3 max-xl:hidden"><StatusBar units={item.units} /><StatusSummary units={item.units} /></span>
                    <span className="flex items-center justify-end gap-2">
                      <span className="flex items-center gap-3 xl:hidden"><StatusBar units={item.units} /><span className="max-md:hidden"><StatusSummary units={item.units} /></span></span>
                      {canManage ? <span onClick={event => event.stopPropagation()} className={reveal}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild><button type="button" className={iconButton} aria-label={`Actions for ${item.name}`}><MoreHorizontal className="h-4 w-4" /></button></DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="schedule-a min-w-[200px]">
                            <DropdownMenuItem onSelect={() => openDrawer(item)}><Pencil className="h-3.5 w-3.5" />Open details</DropdownMenuItem>
                            <DropdownMenuItem disabled={locked} onSelect={() => addUnit(item)}><Plus className="h-3.5 w-3.5" />Add unit</DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive" onSelect={() => setRemoveAsk({ item })}><Trash2 className="h-3.5 w-3.5" />Delete item…</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </span> : null}
                    </span>
                  </div>
                  {open ? <div className="border-b border-[var(--sa-border)] bg-board-bg">
                    <div className={`${unitGrid} hidden pr-3 text-xs font-medium uppercase tracking-[0.07em] text-[var(--sa-ink-3)] xl:grid`}><span /><span className="py-2">Unit</span><span>Status</span><span>Location</span><span>Serial</span><span>Notes</span><span /></div>
                    {item.units.map((unit, index) => <div key={unit.id} className={`group ${unitGrid} min-h-11 border-t border-[var(--sa-border)] py-1 pr-3 hover:bg-[var(--sa-surface)]`}>
                      {canManage ? <Checkbox checked={selected.has(unit.id)} label={`Select unit ${unitNumber(index)} of ${item.name}`} onChange={on => setSelected(current => toggle(current, [unit.id], on))} className={`justify-self-center ${selected.has(unit.id) ? "" : reveal}`} /> : <span />}
                      <span className="tabular-nums text-xs text-[var(--sa-ink-3)]">{unitNumber(index)}</span>
                      <span className="flex min-w-0 flex-col gap-0.5"><StatusMark status={unit.status} /><span className="truncate text-xs text-[var(--sa-ink-3)] xl:hidden">{[unit.location, unit.serialNumber].filter(Boolean).join(" · ")}</span></span>
                      <span className="hidden truncate text-[13px] text-board-text xl:block">{unit.location || "—"}</span>
                      <span className="hidden truncate font-mono text-xs text-[var(--sa-ink-2)] xl:block">{unit.serialNumber || "No serial"}</span>
                      <span className="hidden truncate text-[13px] text-[var(--sa-ink-2)] xl:block">{unit.notes}</span>
                      {canManage ? <span className={`justify-self-end ${reveal}`}>{unitMenu(unit, item)}</span> : <span />}
                    </div>)}
                    {canManage ? <button type="button" disabled={locked} onClick={() => addUnit(item)} className="flex h-11 w-full items-center gap-2 border-t border-[var(--sa-border)] pl-[84px] text-[13px] text-[var(--sa-ink-2)] hover:bg-[var(--sa-surface)] hover:text-board-text disabled:opacity-50 lg:h-10"><Plus className="h-3.5 w-3.5" />Add unit</button> : null}
                  </div> : null}
                </Fragment>;
              })}
            </Fragment>)}
          </section>
          <p className="flex flex-wrap justify-between gap-2 text-xs text-[var(--sa-ink-3)]">
            <span>{selected.size ? <><span className="tabular-nums">{selected.size}</span> of <span className="tabular-nums">{equipment.length}</span> units selected</> : <><span className="tabular-nums">{visible.length}</span> items · <span className="tabular-nums">{visibleUnits.length}</span> units{filtered ? ` of ${equipment.length}` : ""}</>}</span>
            <span className="hidden sm:inline">Click a row to open details · Space to expand</span>
          </p>
        </> : null}
      </div>

      {selected.size && canManage ? <div role="toolbar" aria-label="Selected units" className="fixed bottom-5 left-1/2 z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-wrap items-center gap-2 rounded-xl border border-[var(--sa-border-strong)] bg-[var(--sa-surface)] px-3 py-2 shadow-[0_16px_40px_rgba(0,0,0,0.5)] schedule-a">
        <span className="px-1 text-[13px] font-semibold text-board-text"><span className="tabular-nums">{selected.size}</span> {selected.size === 1 ? "unit" : "units"} selected</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><button type="button" disabled={locked} className={`${chip} h-8`}><RotateCw className="h-3.5 w-3.5" />Set status</button></DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="center" className="schedule-a min-w-[220px]">
            <p className="px-2 py-1.5 text-xs font-medium uppercase tracking-[0.07em] text-[var(--sa-ink-3)]">Set status for {selected.size} {selected.size === 1 ? "unit" : "units"}</p>
            {EQUIPMENT_STATUSES.map(status => <DropdownMenuItem key={status} onSelect={() => void setStatusFor(selectedUnits, status).then(result => { if (result?.outcome === "applied") setSelected(new Set()); })}><StatusMark status={status} /></DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
        <button type="button" onClick={() => setSelected(new Set())} className="inline-flex h-8 items-center gap-2 rounded-lg px-2.5 text-[13px] text-[var(--sa-ink-2)] hover:bg-[var(--sa-surface-2)] hover:text-board-text max-lg:h-11">Clear selection<kbd className="hidden rounded border border-[var(--sa-border-strong)] px-1.5 text-xs sm:inline">Esc</kbd></button>
      </div> : null}

      {showAdd ? <ModalA title="Add New Asset" description={null} closeLabel="Close add asset dialog" onClose={closeAdd} className="sm:max-w-[480px]">
        <form noValidate onSubmit={handleAdd} className="flex flex-col gap-5">
          <fieldset disabled={locked} className="flex min-w-0 flex-col gap-5">
            <div>
              <label htmlFor="asset-name" className="mb-1.5 block text-[13px] font-medium text-board-text">Name <span className="text-[var(--sa-danger)]">*</span></label>
              <input id="asset-name" aria-label="Name" autoFocus value={addForm.name} maxLength={120} aria-invalid={addTried && !addForm.name.trim()} aria-describedby={addTried && !addForm.name.trim() ? "asset-name-error" : undefined}
                onChange={event => setAddForm({ ...addForm, name: event.target.value })} placeholder="Equipment name…" className={`w-full ${addTried && !addForm.name.trim() ? "!border-[var(--sa-danger)]" : ""}`} />
              {addTried && !addForm.name.trim() ? <p id="asset-name-error" className="mt-1.5 flex items-center gap-1.5 text-xs text-[var(--sa-danger)]"><TriangleAlert aria-hidden="true" className="h-3.5 w-3.5" />Enter a name for this asset.</p> : null}
            </div>
            <div>
              <label htmlFor="asset-type" className="mb-1.5 block text-[13px] font-medium text-board-text">Type / Category</label>
              <select id="asset-type" value={addForm.category} onChange={event => setAddForm({ ...addForm, category: event.target.value })} className="w-full">
                {EQUIPMENT_CATEGORIES.map(category => <option key={category} value={category}>{EQUIPMENT_CATEGORY_LABELS[category]}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="asset-quantity" className="mb-1.5 block text-[13px] font-medium text-board-text">Number of units</label>
              <div className="flex items-center gap-4">
                <div className="flex items-stretch rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface-2)]">
                  <button type="button" onClick={() => setAddForm({ ...addForm, quantity: Math.max(1, addForm.quantity - 1) })} disabled={addForm.quantity <= 1} aria-label="One fewer unit" className="flex h-10 w-10 items-center justify-center text-[var(--sa-ink-2)] hover:text-board-text disabled:opacity-40 max-lg:h-11 max-lg:w-11">−</button>
                  <input id="asset-quantity" aria-label="Number of units" inputMode="numeric" value={addForm.quantity} onChange={event => setAddForm({ ...addForm, quantity: Math.max(1, Math.min(100, Number(event.target.value.replace(/\D/g, "")) || 1)) })}
                    className="!h-10 !min-h-0 !w-12 !rounded-none !border-x !border-y-0 !bg-transparent !px-0 text-center tabular-nums max-lg:!h-11" />
                  <button type="button" onClick={() => setAddForm({ ...addForm, quantity: Math.min(100, addForm.quantity + 1) })} aria-label="One more unit" className="flex h-10 w-10 items-center justify-center text-[var(--sa-ink-2)] hover:text-board-text max-lg:h-11 max-lg:w-11">+</button>
                </div>
                <p className="text-xs leading-[1.45] text-[var(--sa-ink-3)]">Each unit can later have its own status, serial number, location, and notes.</p>
              </div>
            </div>
            <div>
              <div className="mb-1.5 flex items-baseline justify-between gap-2"><span className="text-[13px] font-medium text-board-text">Status</span><span className="text-xs text-[var(--sa-ink-3)]">Applies to every new unit</span></div>
              <StatusPicker label="Status" value={addForm.status} onChange={status => setAddForm({ ...addForm, status })} />
            </div>
            <div>
              <label htmlFor="asset-notes" className="mb-1.5 block text-[13px] font-medium text-board-text">Notes</label>
              <textarea id="asset-notes" aria-label="Notes" value={addForm.notes} maxLength={2000} onChange={event => setAddForm({ ...addForm, notes: event.target.value })} placeholder="Optional notes…" className="!h-16 w-full !py-2.5" />
            </div>
          </fieldset>
          {showAdd ? <EquipmentRecovery control={control} /> : null}
          <div className="-mx-5 -mb-5 flex items-center gap-2 border-t border-[var(--sa-border)] bg-board-bg px-5 py-3.5">
            <span className="mr-auto hidden items-center gap-1.5 text-xs text-[var(--sa-ink-3)] sm:inline-flex"><kbd className="rounded border border-[var(--sa-border-strong)] px-1.5 text-xs">Enter</kbd> to add</span>
            <button type="button" onClick={closeAdd} className={`${modalCancel} max-lg:h-11`}>Cancel</button>
            <button type="submit" disabled={control.pending} className={`${modalPrimary} max-lg:h-11`}>Add Asset</button>
          </div>
        </form>
      </ModalA> : null}

      <Dialog open={!!drawer} onOpenChange={open => { if (!open) closeDrawer(); }}>
        <DialogContent aria-describedby={undefined} showCloseButton={false}
          className="schedule-a sp-modal-a !left-auto !right-0 !top-0 flex h-dvh !max-w-[520px] !translate-x-0 !translate-y-0 flex-col gap-0 rounded-none border-y-0 border-r-0 border-l-[var(--sa-border-strong)] bg-[var(--sa-surface)] p-0 data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100 sm:!max-w-[520px]">
          {drawer && drawerItem ? <>
            <header className="flex items-start gap-3 border-b border-[var(--sa-border)] px-5 py-4">
              <TypeIcon category={drawerItem.category} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <DialogTitle className="truncate text-base font-semibold text-board-text">{drawerItem.name}</DialogTitle>
                <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-[var(--sa-ink-3)]">{typeLabel(drawerItem.category)} · {drawerItem.units.length} {drawerItem.units.length === 1 ? "unit" : "units"} · <StatusSummary units={drawerItem.units} /></p>
              </div>
              <button type="button" onClick={() => closeDrawer()} aria-label={`Close ${drawerItem.name} details`} className={iconButton}><X className="h-4 w-4" /></button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <fieldset disabled={!canManage || saving} className="flex flex-col gap-4 border-b border-[var(--sa-border)] px-5 py-5">
                <legend className="sr-only">Item</legend>
                <p className="text-xs font-medium uppercase tracking-[0.07em] text-[var(--sa-ink-3)]">Item</p>
                <div><label htmlFor="drawer-item-name" className="mb-1.5 block text-[13px] font-medium text-board-text">Name</label><input id="drawer-item-name" aria-label="Item name" value={drawer.name} maxLength={120} onChange={event => setDrawer({ ...drawer, name: event.target.value })} className="w-full" /></div>
                <div><label htmlFor="drawer-item-type" className="mb-1.5 block text-[13px] font-medium text-board-text">Type</label><select id="drawer-item-type" value={drawer.category} onChange={event => setDrawer({ ...drawer, category: event.target.value })} className="w-full">
                  {!isEquipmentCategory(drawer.category) ? <option value={drawer.category}>{typeLabel(drawer.category)}</option> : null}
                  {EQUIPMENT_CATEGORIES.map(category => <option key={category} value={category}>{EQUIPMENT_CATEGORY_LABELS[category]}</option>)}
                </select></div>
              </fieldset>
              <div className="flex flex-col gap-4 px-5 py-5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium uppercase tracking-[0.07em] text-[var(--sa-ink-3)]">Units · <span className="tabular-nums">{drawerItem.units.length}</span></p>
                  {canManage ? <button type="button" disabled={locked} onClick={() => addUnit(drawerItem)} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-board-text hover:bg-[var(--sa-surface-2)] disabled:opacity-50 max-lg:h-11"><Plus className="h-3.5 w-3.5" />Add unit</button> : null}
                </div>
                {drawer.base.map((unit, index) => {
                  const edit = drawer.units[unit.id];
                  if (!edit) return null;
                  const changed = unitChanged(unit) || [];
                  const set = (patch: Partial<UnitFields>) => setDrawer({ ...drawer, units: { ...drawer.units, [unit.id]: { ...edit, ...patch } } });
                  return <fieldset key={unit.id} disabled={!canManage || saving} className="flex flex-col gap-4 rounded-xl border border-[var(--sa-border)] p-4">
                    <legend className="sr-only">Unit {unitNumber(index)}</legend>
                    <div className="flex items-center justify-between gap-2">
                      <p className="flex items-center gap-2 text-xs text-[var(--sa-ink-3)]"><span className="tabular-nums">Unit {unitNumber(index)}</span>{changed.length ? <span className="inline-flex items-center gap-1.5 text-[var(--sa-warn)]"><span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[var(--sa-warn)]" />Edited</span> : null}</p>
                      {canManage ? <DropdownMenu>
                        <DropdownMenuTrigger asChild><button type="button" className={iconButton} aria-label={`Actions for unit ${unitNumber(index)}`}><MoreHorizontal className="h-4 w-4" /></button></DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="schedule-a min-w-[180px]">
                          <DropdownMenuItem disabled={!changed.length} onSelect={() => set({ status: unit.status, location: unit.location, serialNumber: unit.serialNumber, notes: unit.notes })}><RotateCw className="h-3.5 w-3.5" />Undo edits</DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onSelect={() => setRemoveAsk(drawerItem.units.length === 1 ? { item: drawerItem } : { unit, item: drawerItem })}><Trash2 className="h-3.5 w-3.5" />Delete unit…</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu> : null}
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-baseline justify-between gap-2"><span className="text-[13px] font-medium text-board-text">Status</span>{edit.status !== unit.status ? <span className="text-xs text-[var(--sa-ink-3)]">was {statusLabel(unit.status)}</span> : null}</div>
                      <StatusPicker label={`Status of unit ${unitNumber(index)}`} value={edit.status} onChange={status => set({ status })} disabled={!canManage || saving} />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div><label htmlFor={`unit-${unit.id}-location`} className="mb-1.5 block text-[13px] font-medium text-board-text">Location</label><input id={`unit-${unit.id}-location`} value={edit.location} maxLength={200} onChange={event => set({ location: event.target.value })} placeholder="Location…" className="w-full" /></div>
                      <div><label htmlFor={`unit-${unit.id}-serial`} className="mb-1.5 block text-[13px] font-medium text-board-text">Serial number</label><input id={`unit-${unit.id}-serial`} value={edit.serialNumber} maxLength={200} onChange={event => set({ serialNumber: event.target.value })} placeholder="Serial number…" className="w-full font-mono" /><span className="mt-1 block text-xs text-[var(--sa-ink-3)]">Optional</span></div>
                    </div>
                    <div><label htmlFor={`unit-${unit.id}-notes`} className="mb-1.5 block text-[13px] font-medium text-board-text">Notes</label><textarea id={`unit-${unit.id}-notes`} value={edit.notes} maxLength={2000} onChange={event => set({ notes: event.target.value })} className="!h-20 w-full !py-2.5" /></div>
                  </fieldset>;
                })}
              </div>
            </div>
            {control.unresolved ? <div className="mx-5 mb-3"><EquipmentRecovery control={control} /></div> : null}
            {drawerError ? <div role="alert" className="mx-5 mb-3 flex flex-wrap items-center gap-2.5 rounded-lg border border-[var(--sa-danger)]/30 bg-[var(--sa-danger)]/[0.07] px-3 py-2.5 text-[13px] text-board-text">
              <TriangleAlert aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--sa-danger)]" /><span className="min-w-0 flex-1">{drawerError}</span>
              {drawerError.startsWith("Someone changed") ? <button type="button" onClick={rebaseDrawer} className="h-8 rounded-md border border-[var(--sa-border-strong)] px-2.5 text-xs font-medium hover:bg-[var(--sa-surface-2)] max-lg:h-11">Use latest, keep my edits</button> : null}
            </div> : null}
            <footer className="flex items-center gap-2 border-t border-[var(--sa-border)] bg-board-bg px-5 py-3.5">
              <span className="mr-auto flex items-center gap-2 text-xs text-[var(--sa-ink-2)]">{changeCount ? <><span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[var(--sa-warn)]" /><span className="tabular-nums">{changeCount}</span> unsaved {changeCount === 1 ? "change" : "changes"}</> : "No changes"}</span>
              <button type="button" onClick={() => closeDrawer()} className={`${modalCancel} max-lg:h-11`}>{changeCount ? "Cancel" : "Close"}</button>
              {canManage ? <button type="button" disabled={!changeCount || saving || locked} onClick={() => void saveDrawer()} className={`${modalPrimary} min-w-[72px] max-lg:h-11`}>{saving ? "Saving…" : "Save"}</button> : null}
            </footer>
          </> : drawer ? <div className="flex flex-col items-start gap-3 p-6">
            <DialogTitle className="text-base font-semibold text-board-text">This item is no longer here</DialogTitle>
            <DialogDescription className="text-[13px] text-[var(--sa-ink-2)]">It was deleted or renamed on another device. Everything else in the inventory is unchanged.</DialogDescription>
            <button type="button" onClick={() => closeDrawer(true)} className={modalCancel}>Close</button>
          </div> : null}
        </DialogContent>
      </Dialog>

      <Dialog open={discardAsk} onOpenChange={setDiscardAsk}>
        <DialogContent showCloseButton={false} className="schedule-a max-w-[400px] gap-0 overflow-hidden rounded-[14px] border-[var(--sa-border-strong)] bg-[var(--sa-surface)] p-0">
          <div className="flex flex-col gap-1.5 px-5 pb-4 pt-5">
            <DialogTitle className="text-base font-semibold">Discard {changeCount} unsaved {changeCount === 1 ? "change" : "changes"}?</DialogTitle>
            <DialogDescription className="text-[13px] text-[var(--sa-ink-2)]">Your edits to {drawer?.name || "this item"} haven't been saved.</DialogDescription>
          </div>
          <div className="flex justify-end gap-2 border-t border-[var(--sa-border)] bg-board-bg px-5 py-3.5">
            <button type="button" autoFocus onClick={() => setDiscardAsk(false)} className={`${modalCancel} border border-[var(--sa-border-strong)] max-lg:h-11`}>Keep editing</button>
            <button type="button" onClick={() => closeDrawer(true)} className="inline-flex h-8 items-center rounded-lg border border-[var(--sa-danger)]/30 bg-[var(--sa-danger)]/10 px-3 text-[13px] font-semibold text-[var(--sa-danger)] max-lg:h-11">Discard</button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!removeAsk} onOpenChange={open => { if (!open) setRemoveAsk(null); }}>
        <DialogContent showCloseButton={false} className="schedule-a max-w-[460px] gap-0 overflow-hidden rounded-[14px] border-[var(--sa-border-strong)] bg-[var(--sa-surface)] p-0">
          {removeAsk ? (() => {
            const lastUnit = !("unit" in removeAsk);
            const item = removeAsk.item;
            const index = "unit" in removeAsk ? item.units.indexOf(removeAsk.unit) : 0;
            return <>
              <div className="flex flex-col gap-3 px-5 pb-4 pt-5">
                <DialogTitle className="text-base font-semibold">{lastUnit ? `Delete ${item.name}?` : `Delete unit ${unitNumber(index)} of ${item.name}?`}</DialogTitle>
                <DialogDescription className="text-[13px] leading-[1.55] text-[var(--sa-ink-2)]">
                  {lastUnit
                    ? item.units.length === 1 ? `Unit 01 is the only unit of ${item.name}, so it can't be deleted on its own. Deleting it deletes the whole item, including its location and notes. This can't be undone.` : `All ${item.units.length} units of ${item.name} are deleted, including their serial numbers, locations and notes. This can't be undone.`
                    : "Its status, serial number, location and notes are removed for good. If it is leaving service, retire it instead so its record stays in the inventory."}
                </DialogDescription>
                {lastUnit ? <div className="flex items-center gap-3 rounded-lg border border-[var(--sa-border)] px-3 py-2.5">
                  <TypeIcon category={item.category} size="sm" />
                  <span className="text-[13px] font-semibold text-board-text">{item.name}</span>
                  <span className="truncate text-xs text-[var(--sa-ink-3)]">{item.units.length} {item.units.length === 1 ? "unit" : "units"} · {sharedLocation(item.units)}</span>
                  <span className="ml-auto"><StatusSummary units={item.units} /></span>
                </div> : null}
                {lastUnit ? <p className="text-xs text-[var(--sa-ink-3)]">Retiring keeps the item and its record in the inventory.</p> : null}
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--sa-border)] bg-board-bg px-5 py-3.5">
                <span className="mr-auto hidden items-center gap-1.5 text-xs text-[var(--sa-ink-3)] sm:inline-flex"><kbd className="rounded border border-[var(--sa-border-strong)] px-1.5 text-xs">Esc</kbd> to cancel</span>
                <button type="button" autoFocus onClick={() => setRemoveAsk(null)} className={`${modalCancel} border border-[var(--sa-border-strong)] max-lg:h-11`}>Cancel</button>
                <button type="button" disabled={locked} onClick={() => void ("unit" in removeAsk ? removeUnit(removeAsk.unit, true) : removeItem(item, true))} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface-2)] px-3 text-[13px] font-medium text-board-text hover:bg-[var(--sa-surface-3)] max-lg:h-11"><Archive className="h-3.5 w-3.5" />Retire instead</button>
                <button type="button" disabled={locked} onClick={() => void ("unit" in removeAsk ? removeUnit(removeAsk.unit, false) : removeItem(item, false))} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--sa-danger)]/30 bg-[var(--sa-danger)]/10 px-3 text-[13px] font-semibold text-[var(--sa-danger)] max-lg:h-11"><Trash2 className="h-3.5 w-3.5" />{lastUnit ? "Delete item" : "Delete unit"}</button>
              </div>
            </>;
          })() : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** One calm skeleton in the real table shape. No spinner, no numbers until they are real. */
function AssetsSkeleton() {
  const bar = (width: string) => <span className={`block h-2.5 rounded bg-[var(--sa-surface-3)] ${width}`} />;
  return <div className="schedule-a min-h-full bg-board-bg">
    <p role="status" className="sr-only">Loading inventory…</p>
    <div aria-hidden="true" className="schedule-skeleton mx-auto flex max-w-[1180px] min-[1800px]:max-w-[1680px] flex-col gap-5 px-4 pt-6 md:px-8">
      <div className="flex flex-col gap-2">{bar("h-6 w-48")}{bar("w-80")}</div>
      <div className="h-[76px] rounded-xl border border-[var(--sa-border)] bg-[var(--sa-surface)]" />
      <div className="overflow-hidden rounded-xl border border-[var(--sa-border)] bg-[var(--sa-surface)]">
        <div className="h-10 border-b border-[var(--sa-border)]" />
        {Array.from({ length: 5 }, (_, row) => <div key={row} className="flex items-center gap-4 border-b border-[var(--sa-border)] px-4 py-3.5 last:border-b-0"><span className="h-8 w-8 rounded-lg bg-[var(--sa-surface-3)]" />{bar("w-1/3")}<span className="ml-auto">{bar("w-24")}</span></div>)}
      </div>
    </div>
  </div>;
}
