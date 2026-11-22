import { Columns3, GripVertical, Palette } from "lucide-react";
import { Popover } from "radix-ui";
import type { CueColumnRow } from "@/lib/cue-sheet-derive";
import { TOGGLEABLE_COLUMNS } from "./cue-table";
import { departmentStyle } from "./department-color";
import { DepartmentDragHandle } from "./department-drag-handle";

export function CueColumnsMenu({ columns, hidden, counts, canManage, locked, onToggle, onShowAll, onManage, onReorder }: {
  columns: CueColumnRow[]; hidden: Set<string>; counts: Record<string, number>; canManage: boolean; locked: boolean;
  onToggle: (id: string) => void; onShowAll: () => void; onManage: () => void; onReorder: (from: string, to: string) => void;
}) {
  const total = TOGGLEABLE_COLUMNS.length + columns.length;
  const shown = TOGGLEABLE_COLUMNS.filter(column => !hidden.has(column.key)).length + columns.filter(column => !hidden.has(column.id)).length;
  return <Popover.Root><Popover.Trigger asChild><button type="button" className="cue-button" aria-label={`Columns, ${shown} of ${total} shown`}><Columns3 />Columns · {shown}/{total}</button></Popover.Trigger>
    <Popover.Portal><Popover.Content align="end" sideOffset={4} className="cue-portal cue-columns-pop z-40 max-h-[var(--radix-popover-content-available-height)] overflow-y-auto" aria-label="Visible columns">
      <div className="cue-pop-section"><div className="cue-pop-heading"><span>Columns <span className="cue-quiet cue-mono ml-2">{shown} of {total} shown</span></span><button type="button" className="cue-quiet" onClick={onShowAll}>Show all</button></div>
        <div className="cue-pop-heading"><p className="cue-pop-label">Fields</p><span className="cue-quiet">Your view</span></div>
        {TOGGLEABLE_COLUMNS.map(column => <ToggleRow key={column.key} label={column.label} checked={!hidden.has(column.key)} onToggle={() => onToggle(column.key)} />)}
        <p className="cue-quiet mt-3"># and Title are always shown.</p>
      </div>
      <div className="cue-pop-section"><div className="cue-pop-heading"><span className="cue-pop-label">Departments</span>{canManage && <span className="cue-quiet">Order shared · show/hide is your view</span>}</div>
        {columns.map(column => <div key={column.id} data-department-order-id={column.id} className="cue-toggle-row" style={departmentStyle(column.color)}>
          {canManage ? <DepartmentDragHandle column={column} columns={columns} disabled={locked} onReorder={onReorder} /> : <GripVertical className="h-3 w-3 opacity-30" />}
          <span className="cue-dept-dot" /><label htmlFor={`cue-visible-${column.id}`}>{column.label}</label><span className="cue-quiet cue-mono">{counts[column.id] ?? 0} cues</span>
          <Toggle id={`cue-visible-${column.id}`} label={`Show ${column.label}`} checked={!hidden.has(column.id)} onToggle={() => onToggle(column.id)} />
        </div>)}
      </div>
      <div className="cue-pop-section cue-quiet">Column order and widths are shared across the organization. Hiding a field or department only changes your view.</div>
      {canManage && <div className="cue-pop-section flex justify-between gap-2"><Popover.Close asChild><button type="button" className="cue-quiet flex items-center gap-2" onClick={onManage}><Palette className="h-3.5 w-3.5" />Manage departments…</button></Popover.Close><span className="cue-quiet">Shared layout</span></div>}
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
function ToggleRow({ label, checked, onToggle }: { label: string; checked: boolean; onToggle: () => void }) {
  return <div className="cue-toggle-row"><label htmlFor={`cue-visible-${label}`}>{label}</label><Toggle id={`cue-visible-${label}`} label={`Show ${label}`} checked={checked} onToggle={onToggle} /></div>;
}
function Toggle({ id, label, checked, onToggle }: { id: string; label: string; checked: boolean; onToggle: () => void }) {
  return <button type="button" id={id} role="switch" aria-label={label} aria-checked={checked} onClick={onToggle} className="cue-toggle"><span /></button>;
}
