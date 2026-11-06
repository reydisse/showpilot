import { useEffect, useRef, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { CUE_COLUMN_COLORS, type CueColumnRow, type CueColumnColor } from "@/lib/cue-sheet";
import type { CueSheetOperation } from "@/lib/cue-sheet-writes";
import { tintFor } from "@/components/cue-sheet/cue-table";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";

export function ColumnManager({ columns, onMutation, locked, confirmedOperation, onClose }: {
  columns: CueColumnRow[];
  onMutation: (operation: CueSheetOperation) => Promise<boolean>;
  locked: boolean;
  confirmedOperation: CueSheetOperation | null;
  onClose: () => void;
}) {
  const [label, setLabel] = useState("");
  const [color, setColor] = useState<CueColumnColor>("slate");
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  useEffect(() => {
    if (confirmedOperation?.kind === "add-column") setLabel(previous => previous.trim() === confirmedOperation.label ? "" : previous);
  }, [confirmedOperation]);
  async function add() {
    const captured = label.trim();
    if (!captured || locked) return;
    if (await onMutation({ kind: "add-column", label: captured, color })) setLabel(previous => previous.trim() === captured ? "" : previous);
  }
  async function remove(column: CueColumnRow) {
    if (locked) return;
    const ok = await confirm({
      title: `Delete the ${column.label} column`,
      description: `Every note written in ${column.label}, on every service date including past ones, is deleted with it. This cannot be undone.`,
      confirmLabel: "Delete column", variant: "danger",
    });
    if (ok) await onMutation({ kind: "delete-column", id: column.id, label: column.label });
  }
  return <div className="shrink-0 border-b border-board-border bg-board-card/60 px-6 py-3">
    <div className="flex items-center justify-between mb-2.5">
      <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-board-muted">Departments</h2>
      <button type="button" onClick={onClose} aria-label="Close column settings" className="min-h-11 min-w-11 flex items-center justify-center rounded text-board-muted hover:text-board-text"><X className="w-4 h-4" /></button>
    </div>
    <div className="flex flex-wrap gap-2 mb-3">
      {columns.map(column => <div key={column.id} className="flex max-w-full flex-wrap items-center gap-1.5 rounded-lg border border-board-border bg-board-bg px-2 py-1">
        <ColumnName column={column} locked={locked} onMutation={onMutation} />
        <select value={column.color} disabled={locked} onChange={event => {
          const next = CUE_COLUMN_COLORS.find(value => value === event.target.value);
          if (next && next !== column.color) void onMutation({ kind: "color-column", id: column.id, before: column.color, color: next });
        }} aria-label={`Colour for ${column.label}`} className={`min-h-11 text-xs rounded px-2 border-0 ${tintFor(column.color).head} ${tintFor(column.color).text}`}>
          {CUE_COLUMN_COLORS.map(option => <option key={option} value={option}>{option}</option>)}
        </select>
        <button type="button" disabled={locked} onClick={() => void remove(column)} aria-label={`Delete ${column.label}`} className="min-h-11 min-w-11 flex items-center justify-center rounded text-board-muted hover:text-red-400 disabled:opacity-50"><Trash2 className="w-4 h-4" /></button>
      </div>)}
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <label className="min-w-0 flex-1 basis-48 text-xs text-board-muted">New department
        <input value={label} disabled={locked} onChange={event => setLabel(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void add(); } }} placeholder="SM, SC, V2…" maxLength={60} className="block w-full min-h-11 mt-1 px-2.5 rounded-lg bg-board-bg border border-board-border text-sm text-board-text" />
      </label>
      <select value={color} disabled={locked} onChange={event => { const next = CUE_COLUMN_COLORS.find(value => value === event.target.value); if (next) setColor(next); }} aria-label="Colour for the new column" className={`min-h-11 text-xs rounded-lg px-2 ${tintFor(color).head} ${tintFor(color).text}`}>
        {CUE_COLUMN_COLORS.map(option => <option key={option} value={option}>{option}</option>)}
      </select>
      <button type="button" onClick={() => void add()} disabled={locked || !label.trim() || columns.length >= 40} className="min-h-11 inline-flex items-center gap-1.5 text-sm px-3 rounded-lg bg-fire-500/15 border border-fire-500/30 text-fire-400 disabled:opacity-50"><Plus className="w-3.5 h-3.5" />Add</button>
      {columns.length >= 40 && <p className="text-xs text-board-muted">The sheet has its maximum of 40 departments.</p>}
    </div>
    {ConfirmDialogEl}
  </div>;
}

function ColumnName({ column, locked, onMutation }: { column: CueColumnRow; locked: boolean; onMutation: (operation: CueSheetOperation) => Promise<boolean> }) {
  const [draft, setDraft] = useState(column.label);
  const focused = useRef(false), before = useRef(column.label);
  useEffect(() => { if (!focused.current && !locked) setDraft(column.label); }, [column.label, locked]);
  return <input value={draft} disabled={locked} maxLength={60} onFocus={() => { focused.current = true; before.current = column.label; }} onChange={event => setDraft(event.target.value)} onBlur={() => {
    focused.current = false;
    if (!draft.trim()) { setDraft(column.label); return; }
    if (draft.trim() !== before.current) void onMutation({ kind: "rename-column", id: column.id, before: before.current, label: draft.trim() });
  }} aria-label={`Rename ${column.label}`} className="min-h-11 w-28 bg-transparent text-sm text-board-text rounded px-1 focus-visible:outline-2 focus-visible:outline-fire-500" />;
}
