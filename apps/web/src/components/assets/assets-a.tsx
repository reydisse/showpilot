import type React from "react";
import { Archive, ArrowDownUp, Ban, Box, Cable, Check, ChevronDown, CircleCheck, CircleX, Headphones, Lightbulb, Minus, Network, Plug, Radio, Speaker, TriangleAlert, Video, Wrench } from "lucide-react";
import { EQUIPMENT_STATUSES, EQUIPMENT_STATUS_LABELS, equipmentCategoryLabel, type EquipmentStatus } from "@showpilot/shared";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/**
 * Assets — A (Doop canvas aneicgaHqk, "Assets" page): status marks, the summary strip,
 * filter / sort / group controls and the status picker. Colours come from `.schedule-a`.
 */

export type Unit = { id: string; name: string; category: string; status: string; location: string; serialNumber: string; notes: string; revision: number };

export const ATTENTION: readonly string[] = ["maintenance", "needs-repair", "in-repair", "broken", "out-of-service"];

const STATUS_META: Record<EquipmentStatus, { icon: React.ElementType; text: string; bar: string; rank: number }> = {
  operational: { icon: CircleCheck, text: "text-[var(--sa-ok)]", bar: "bg-[var(--sa-ok)]", rank: 5 },
  maintenance: { icon: Wrench, text: "text-[var(--sa-warn)]", bar: "bg-[var(--sa-warn)]", rank: 3 },
  "needs-repair": { icon: TriangleAlert, text: "text-[var(--sa-warn)]", bar: "bg-[var(--sa-warn)]", rank: 2 },
  "in-repair": { icon: Wrench, text: "text-[var(--sa-warn)]", bar: "bg-[var(--sa-warn)]", rank: 2 },
  broken: { icon: CircleX, text: "text-[var(--sa-danger)]", bar: "bg-[var(--sa-danger)]", rank: 0 },
  "out-of-service": { icon: Ban, text: "text-[var(--sa-danger)]", bar: "bg-[var(--sa-danger)]", rank: 1 },
  retired: { icon: Archive, text: "text-[var(--sa-ink-3)]", bar: "bg-[var(--sa-ink-3)]", rank: 6 },
};
const UNKNOWN = { icon: CircleCheck, text: "text-[var(--sa-ink-2)]", bar: "bg-[var(--sa-ink-3)]", rank: 4 };

export function statusMeta(status: string) {
  return STATUS_META[status as EquipmentStatus] ?? UNKNOWN;
}
export function statusLabel(status: string) {
  return EQUIPMENT_STATUS_LABELS[status as EquipmentStatus] ?? (status || "Unknown");
}

const TYPE_ICON: Record<string, React.ElementType> = { audio: Speaker, video: Video, lighting: Lightbulb, streaming: Radio, network: Network, power: Plug, cables: Cable, comms: Headphones, other: Box };
export function TypeIcon({ category, size = "md" }: { category: string; size?: "sm" | "md" }) {
  const Icon = TYPE_ICON[category] ?? Box;
  return <span aria-hidden="true" className={`flex shrink-0 items-center justify-center rounded-lg border border-[var(--sa-border)] bg-[var(--sa-surface-2)] text-[var(--sa-ink-2)] ${size === "sm" ? "h-6 w-6" : "h-8 w-8"}`}>
    <Icon className={size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5"} strokeWidth={1.75} />
  </span>;
}
export const typeLabel = (category: string) => equipmentCategoryLabel(category);

/** Icon + word: colour never carries status alone. */
export function StatusMark({ status, count }: { status: string; count?: number }) {
  const meta = statusMeta(status), Icon = meta.icon;
  return <span className={`inline-flex items-center gap-1.5 whitespace-nowrap text-xs ${meta.text}`}>
    <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
    {count !== undefined ? `${count} ${statusLabel(status).toLowerCase()}` : statusLabel(status)}
  </span>;
}

/** One segment per unit (worst first), or one long bar when every unit shares a status. */
export function StatusBar({ units }: { units: Pick<Unit, "status">[] }) {
  const sorted = [...units].sort((a, b) => statusMeta(a.status).rank - statusMeta(b.status).rank);
  const same = sorted.every(unit => unit.status === sorted[0]?.status);
  return <span aria-hidden="true" className="flex w-14 shrink-0 gap-[3px]">
    {same ? <span className={`h-1 w-full rounded-full ${statusMeta(sorted[0]?.status ?? "").bar}`} />
      : sorted.slice(0, 8).map((unit, index) => <span key={index} className={`h-1 min-w-0 flex-1 rounded-full ${statusMeta(unit.status).bar}`} />)}
  </span>;
}

/** "1 in repair · 3 operational": worst statuses first, at most two. */
export function StatusSummary({ units }: { units: Pick<Unit, "status">[] }) {
  const counts = new Map<string, number>();
  for (const unit of units) counts.set(unit.status, (counts.get(unit.status) ?? 0) + 1);
  const ordered = [...counts].sort((a, b) => statusMeta(a[0]).rank - statusMeta(b[0]).rank).slice(0, 2);
  return <span className="flex min-w-0 items-center gap-x-3 overflow-hidden">{ordered.map(([status, count]) => <StatusMark key={status} status={status} count={count} />)}</span>;
}

export const unitNumber = (index: number) => String(index + 1).padStart(2, "0");

// ─── Summary strip ───────────────────────────────────────────

export function SummaryStrip({ items, units }: { items: number; units: Unit[] }) {
  const operational = units.filter(unit => unit.status === "operational").length;
  const attention = units.filter(unit => ATTENTION.includes(unit.status)).length;
  const retired = units.filter(unit => unit.status === "retired").length;
  const stat = (label: string, value: React.ReactNode) => <div className="flex flex-col gap-1">
    <span className="text-xs font-medium uppercase tracking-[0.07em] text-[var(--sa-ink-3)]">{label}</span>
    <span className="text-lg tabular-nums text-board-text">{value}</span>
  </div>;
  const sorted = [...units].sort((a, b) => statusMeta(b.status).rank === 6 ? -1 : statusMeta(a.status).rank === 6 ? 1 : statusMeta(b.status).rank - statusMeta(a.status).rank);
  return <section aria-label="Inventory summary" className="flex flex-wrap items-center gap-x-8 gap-y-4 rounded-xl border border-[var(--sa-border)] bg-[var(--sa-surface)] px-5 py-4">
    <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
      {stat("Items", items)}
      {stat("Units", units.length)}
      {stat("Operational", operational)}
      {stat("Needs attention", attention ? <span className="inline-flex items-center gap-1.5 text-[var(--sa-warn)]"><TriangleAlert aria-hidden="true" className="h-4 w-4" strokeWidth={1.75} />{attention}</span> : 0)}
      {stat("Retired", retired)}
    </div>
    <span aria-hidden="true" className="hidden h-10 w-px bg-[var(--sa-border)] lg:block" />
    <div className="flex min-w-[220px] flex-1 flex-col gap-2.5">
      <span aria-hidden="true" className="flex gap-[3px]">{sorted.slice(0, 60).map((unit, index) => <span key={index} className={`h-1.5 min-w-0 flex-1 rounded-full ${statusMeta(unit.status).bar}`} />)}</span>
      <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <StatusMark status="operational" count={operational} />
        {attention ? <span className="inline-flex items-center gap-1.5 text-xs text-[var(--sa-warn)]"><TriangleAlert aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={1.75} />{attention} need{attention === 1 ? "s" : ""} attention</span> : null}
        {retired ? <StatusMark status="retired" count={retired} /> : null}
      </span>
    </div>
  </section>;
}

// ─── Controls ────────────────────────────────────────────────

export const chip = "inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface)] px-3 text-[13px] text-board-text hover:bg-[var(--sa-surface-2)] data-[state=open]:border-fire-500 max-lg:h-11";

export function MultiFilter({ label, allLabel, options, value, onChange, footer, shortcut }: {
  label: string;
  allLabel: string;
  options: { value: string; label: string; count: number; icon?: React.ReactNode; tone?: string }[];
  value: string[];
  onChange: (next: string[]) => void;
  footer: string;
  /** e.g. "Needs attention": toggles a set of values at once. */
  shortcut?: { label: string; values: readonly string[]; count: number };
}) {
  const toggle = (item: string) => onChange(value.includes(item) ? value.filter(v => v !== item) : [...value, item]);
  const shortcutOn = !!shortcut && shortcut.values.every(v => value.includes(v)) && value.length === shortcut.values.length;
  const shown = shortcutOn ? shortcut!.label : value.length === 0 ? allLabel : value.length === 1 ? options.find(o => o.value === value[0])?.label ?? value[0] : `${value.length} selected`;
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <button type="button" aria-label={`${label}: ${shown}`} className={chip}>
        <span className="text-[var(--sa-ink-3)]">{label}</span><span className={value.length ? "font-semibold" : ""}>{shown}</span><ChevronDown aria-hidden="true" className="h-3.5 w-3.5 text-[var(--sa-ink-3)]" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="schedule-a min-w-[260px]">
      <DropdownMenuLabel className="text-xs font-medium uppercase tracking-[0.07em] text-[var(--sa-ink-3)]">{label}</DropdownMenuLabel>
      {shortcut ? <>
        <DropdownMenuCheckboxItem checked={shortcutOn} onSelect={event => event.preventDefault()} onCheckedChange={on => onChange(on ? [...shortcut.values] : [])}>
          <TriangleAlert aria-hidden="true" className="h-3.5 w-3.5 text-[var(--sa-ink-2)]" />{shortcut.label}<span className="ml-auto tabular-nums text-xs text-[var(--sa-ink-3)]">{shortcut.count}</span>
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
      </> : null}
      {options.map(option => <DropdownMenuCheckboxItem key={option.value} checked={value.includes(option.value)} onSelect={event => event.preventDefault()} onCheckedChange={() => toggle(option.value)}
        className={option.count === 0 && !value.includes(option.value) ? "opacity-60" : ""}>
        {option.icon}<span className={option.tone}>{option.label}</span><span className="ml-auto tabular-nums text-xs text-[var(--sa-ink-3)]">{option.count}</span>
      </DropdownMenuCheckboxItem>)}
      <DropdownMenuSeparator />
      <div className="flex items-center justify-between px-2 py-1 text-xs text-[var(--sa-ink-3)]">
        <span>{footer}</span>
        <button type="button" disabled={!value.length} onClick={() => onChange([])} className="rounded-md px-2 py-1 font-medium text-board-text hover:bg-[var(--sa-surface-2)] disabled:opacity-40">Clear</button>
      </div>
    </DropdownMenuContent>
  </DropdownMenu>;
}

export type SortKey = "name" | "type" | "status" | "location";
export const SORT_LABEL: Record<SortKey, string> = { name: "Name", type: "Type", status: "Status", location: "Location" };

export function SortMenu({ sort, dir, onChange }: { sort: SortKey; dir: "asc" | "desc"; onChange: (sort: SortKey, dir: "asc" | "desc") => void }) {
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <button type="button" aria-label={`Sort: ${SORT_LABEL[sort]} ${dir === "asc" ? "A to Z" : "Z to A"}`} className={chip}>
        <ArrowDownUp aria-hidden="true" className="h-3.5 w-3.5 text-[var(--sa-ink-3)]" /><span className="font-semibold">{SORT_LABEL[sort]} {dir === "asc" ? "A–Z" : "Z–A"}</span><ChevronDown aria-hidden="true" className="h-3.5 w-3.5 text-[var(--sa-ink-3)]" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="schedule-a min-w-[240px]">
      <DropdownMenuLabel className="text-xs font-medium uppercase tracking-[0.07em] text-[var(--sa-ink-3)]">Sort by</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={sort} onValueChange={next => onChange(next as SortKey, dir)}>
        {(Object.keys(SORT_LABEL) as SortKey[]).map(key => <DropdownMenuRadioItem key={key} value={key} onSelect={event => event.preventDefault()}>{key === "status" ? "Status (needs attention first)" : SORT_LABEL[key]}</DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <div role="group" aria-label="Sort direction" className="grid grid-cols-2 gap-1 p-1">
        {(["asc", "desc"] as const).map(option => <button key={option} type="button" aria-pressed={dir === option} onClick={() => onChange(sort, option)}
          className={`h-8 rounded-md text-[13px] ${dir === option ? "bg-[var(--sa-surface-3)] font-medium text-board-text" : "text-[var(--sa-ink-2)] hover:text-board-text"}`}>{option === "asc" ? "A → Z" : "Z → A"}</button>)}
      </div>
      <p className="px-2 pb-1.5 pt-1 text-xs text-[var(--sa-ink-3)]">Saved for you on this device</p>
    </DropdownMenuContent>
  </DropdownMenu>;
}

export type GroupBy = "none" | "type" | "location";
export function GroupControl({ value, onChange }: { value: GroupBy; onChange: (next: GroupBy) => void }) {
  return <div className="flex items-center gap-2">
    <span className="text-[13px] text-[var(--sa-ink-3)]">Group</span>
    <div role="radiogroup" aria-label="Group by" className="flex rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface)] p-0.5">
      {(["none", "type", "location"] as const).map(option => <button key={option} type="button" role="radio" aria-checked={value === option} onClick={() => onChange(option)}
        className={`h-8 rounded-md px-3 text-[13px] max-lg:h-11 ${value === option ? "bg-[var(--sa-surface-3)] font-medium text-board-text" : "text-[var(--sa-ink-2)] hover:text-board-text"}`}>{option === "none" ? "None" : option === "type" ? "Type" : "Location"}</button>)}
    </div>
  </div>;
}

/** A real checkbox look with a mixed state, for rows and bulk selection. */
export function Checkbox({ checked, mixed = false, onChange, label, className = "" }: { checked: boolean; mixed?: boolean; onChange: (next: boolean) => void; label: string; className?: string }) {
  return <button type="button" role="checkbox" aria-checked={mixed ? "mixed" : checked} aria-label={label} onClick={event => { event.stopPropagation(); onChange(!checked); }}
    className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-md lg:h-8 lg:w-8 ${className}`}>
    <span aria-hidden="true" className={`flex h-4 w-4 items-center justify-center rounded-[4px] ${checked || mixed ? "bg-board-text text-board-bg" : "shadow-[inset_0_0_0_1.5px_var(--sa-border-strong)]"}`}>
      {mixed ? <Minus className="h-3 w-3" strokeWidth={3} /> : checked ? <Check className="h-3 w-3" strokeWidth={3} /> : null}
    </span>
  </button>;
}

/** Seven statuses as a two-column radio grid (add asset, unit editor). */
export function StatusPicker({ value, onChange, label, disabled }: { value: string; onChange: (next: EquipmentStatus) => void; label: string; disabled?: boolean }) {
  return <div role="radiogroup" aria-label={label} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
    {EQUIPMENT_STATUSES.map(status => {
      const active = value === status;
      return <button key={status} type="button" role="radio" aria-checked={active} aria-label={statusLabel(status)} disabled={disabled} onClick={() => onChange(status)}
        className={`flex h-9 items-center gap-2.5 rounded-lg border px-3 text-left text-[13px] disabled:opacity-50 max-lg:h-11 ${active ? "border-board-text/70 bg-[var(--sa-surface-2)]" : "border-[var(--sa-border)] hover:bg-[var(--sa-surface-2)]"}`}>
        <span aria-hidden="true" className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${active ? "bg-board-text" : "shadow-[inset_0_0_0_1.5px_var(--sa-border-strong)]"}`}>{active ? <span className="h-1.5 w-1.5 rounded-full bg-board-bg" /> : null}</span>
        <StatusMark status={status} />
      </button>;
    })}
  </div>;
}
