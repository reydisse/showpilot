import { useEffect, useRef, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { CUE_COLUMN_COLORS, type CueColumnRow, type CueColumnColor } from "@/lib/cue-sheet";
import type { CueSheetOperation } from "@/lib/cue-sheet-writes";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { DEPARTMENT_COLORS, departmentStyle } from "./department-color";
import { DepartmentDragHandle } from "./department-drag-handle";

export function ColumnManager({ columns, counts = {}, onMutation, locked, confirmedOperation, onClose, onReorder, failure, onRetry, undoNotice }: {
  columns: CueColumnRow[]; counts?: Record<string, number>;
  onMutation: (operation?: CueSheetOperation) => Promise<boolean>; locked: boolean;
  confirmedOperation: CueSheetOperation | null; onClose: () => void;
  onReorder?: (from: string, to: string) => void; failure?: string | null; onRetry?: () => void;
  undoNotice?: React.ReactNode;
}) {
  const [label, setLabel] = useState(""), [color, setColor] = useState<CueColumnColor>("red");
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  useEffect(() => { if (confirmedOperation?.kind === "add-column") setLabel(previous => previous.trim() === confirmedOperation.label ? "" : previous); }, [confirmedOperation]);
  const add = async () => {
    const captured = label.trim(); if (!captured || locked || columns.length >= 40) return;
    if (await onMutation({ kind: "add-column", label: captured, color })) setLabel(previous => previous.trim() === captured ? "" : previous);
  };
  const remove = async (column: CueColumnRow) => {
    if (locked) return;
    if (column.noteCount === 0) {
      await onMutation({ kind: "delete-empty-column", id: column.id, label: column.label });
      return;
    }
    // These columns are org-wide today. Never imply that deletion affects only this show.
    const ok = await confirm({ title: `Delete ${column.label} from every show?`, description: `${column.noteCount ?? "The department's"} cue notes across all shows, including past shows, will be deleted with this department. This cannot be undone.`, confirmLabel: "Delete for every show", variant: "danger" });
    if (ok) await onMutation({ kind: "delete-column", id: column.id, label: column.label });
  };
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}><Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-40 bg-black/55" />
    <Dialog.Content className="cue-portal cue-sheet-dialog" onCloseAutoFocus={event => { event.preventDefault(); document.querySelector<HTMLButtonElement>("[data-cue-departments-trigger]")?.focus(); }}>
      <Dialog.Title>Departments</Dialog.Title><Dialog.Close asChild><button type="button" className="cue-icon absolute right-4 top-4" aria-label="Close departments"><X /></button></Dialog.Close>
      <Dialog.Description className="cue-sheet-description">Each department gets its own cue column. Departments are shared across the organization. Drag to reorder.</Dialog.Description>
      <p className="cue-pop-label mb-3">{columns.length} departments</p>
      <div>{columns.map(column => <div key={column.id} data-department-order-id={column.id} className="cue-dept-edit">
        {onReorder && <DepartmentDragHandle column={column} columns={columns} disabled={locked} onReorder={onReorder} />}
        <ColumnName column={column} locked={locked} onMutation={onMutation} />
        <Swatches value={column.color} disabled={locked} label={`Color for ${column.label}`} onChange={next => { if (next !== column.color) void onMutation({ kind: "color-column", id: column.id, before: column.color, color: next }); }} />
        <span className="cue-quiet cue-mono ml-auto whitespace-nowrap text-[11px]" title="Cue notes across all shows">{column.noteCount ?? counts[column.id] ?? 0} cues</span>
        <button type="button" className="cue-icon shrink-0 hover:text-red-400" disabled={locked} aria-label={`Delete ${column.label}`} onClick={() => void remove(column)}><Trash2 /></button>
      </div>)}</div>
      <div className="cue-add-dept"><p className="cue-pop-label">New department</p><form onSubmit={event => { event.preventDefault(); void add(); }}>
        <input value={label} onChange={event => setLabel(event.target.value)} disabled={locked} maxLength={60} placeholder="Department name" aria-label="Department name" autoFocus={columns.length === 0} />
        <button type="submit" className="cue-button" data-primary disabled={locked || !label.trim() || columns.length >= 40}><Plus />Add</button>
      </form><div className="flex items-center gap-3"><span className="cue-quiet">Color</span><Swatches value={color} label="Color for the new department" disabled={locked} onChange={setColor} /></div></div>
      {columns.length >= 40 && <p className="cue-quiet mt-3">This organization has its maximum of 40 departments.</p>}
      {undoNotice}
      {failure && <div role="alert" className="mt-4 rounded-lg border border-red-400/30 p-3 text-[13px]"><p>{failure}</p>{onRetry && <button type="button" className="cue-button mt-3" disabled={locked} onClick={onRetry}>Try again</button>}</div>}
      {ConfirmDialogEl}
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}
function Swatches({ value, onChange, label, disabled }: { value: string; label: string; disabled: boolean; onChange: (color: CueColumnColor) => void }) {
  const palette: readonly CueColumnColor[] = CUE_COLUMN_COLORS.includes(value as CueColumnColor) && !DEPARTMENT_COLORS.some(color => color === value) ? [value as CueColumnColor, ...DEPARTMENT_COLORS] : DEPARTMENT_COLORS;
  return <div role="radiogroup" aria-label={label} className="cue-swatches">{palette.map((color, index) => <button key={color} type="button" role="radio" aria-label={color} aria-checked={value === color} disabled={disabled} style={departmentStyle(color)} className="cue-swatch" tabIndex={value === color ? 0 : -1}
    onClick={() => onChange(color)} onKeyDown={event => {
      const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
      if (!delta) return; event.preventDefault(); const next = (index + delta + palette.length) % palette.length;
      onChange(palette[next]); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
    }} />)}</div>;
}
function ColumnName({ column, locked, onMutation }: { column: CueColumnRow; locked: boolean; onMutation: (operation?: CueSheetOperation) => Promise<boolean> }) {
  const [draft, setDraft] = useState(column.label), focused = useRef(false), before = useRef(column.label), cancelled = useRef(false);
  useEffect(() => { if (!focused.current && !locked) setDraft(column.label); }, [column.label, locked]);
  return <input value={draft} disabled={locked} maxLength={60} aria-label={`Rename ${column.label}`}
    onFocus={() => { focused.current = true; cancelled.current = false; before.current = column.label; }} onChange={event => setDraft(event.target.value)}
    onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } if (event.key === "Escape") { cancelled.current = true; setDraft(column.label); before.current = column.label; event.currentTarget.blur(); } }}
    onBlur={() => { focused.current = false; if (cancelled.current) { setDraft(column.label); return; } if (!draft.trim()) { setDraft(column.label); return; } if (draft.trim() !== before.current) void onMutation({ kind: "rename-column", id: column.id, before: before.current, label: draft.trim() }); }} />;
}
