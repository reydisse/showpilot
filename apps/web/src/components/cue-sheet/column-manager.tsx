/**
 * Add, rename, recolour and delete department columns.
 *
 * A panel in normal flow rather than a modal: columns get adjusted while
 * looking at the sheet, and an overlay would cover the thing being edited.
 */

import { useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { CUE_COLUMN_COLORS, type CueColumnRow } from "@/lib/cue-sheet";
import { tintFor } from "@/components/cue-sheet/cue-table";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";

export function ColumnManager({
  orgId,
  columns,
  onChanged,
  onClose,
}: {
  orgId: string;
  columns: CueColumnRow[];
  onChanged: () => void;
  onClose: () => void;
}) {
  const [label, setLabel] = useState("");
  const [color, setColor] = useState<string>("slate");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm, ConfirmDialogEl } = useConfirmDialog();

  async function add() {
    if (!label.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { addCueColumn } = await import("@/lib/cue-sheet");
      await addCueColumn({
        data: { orgId, label: label.trim(), color: color as (typeof CUE_COLUMN_COLORS)[number] },
      });
      setLabel("");
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add that column");
    } finally {
      setBusy(false);
    }
  }

  async function rename(id: string, next: string) {
    const trimmed = next.trim();
    if (!trimmed) return;
    const { updateCueColumn } = await import("@/lib/cue-sheet");
    await updateCueColumn({ data: { orgId, id, label: trimmed } });
    onChanged();
  }

  async function recolour(id: string, next: string) {
    const { updateCueColumn } = await import("@/lib/cue-sheet");
    await updateCueColumn({
      data: { orgId, id, color: next as (typeof CUE_COLUMN_COLORS)[number] },
    });
    onChanged();
  }

  async function remove(column: CueColumnRow) {
    // Deleting a column deletes its notes on every service date, past
    // services included — so the dialog says exactly that rather than
    // asking a vague "are you sure".
    const ok = await confirm({
      title: `Delete the ${column.label} column`,
      description: `Every note written in ${column.label}, on every service date including past ones, is deleted with it. This cannot be undone.`,
      confirmLabel: "Delete column",
      variant: "danger",
    });
    if (!ok) return;
    const { deleteCueColumn } = await import("@/lib/cue-sheet");
    await deleteCueColumn({ data: { orgId, id: column.id } });
    onChanged();
  }

  return (
    <div className="shrink-0 border-b border-board-border bg-board-card/60 px-6 py-3">
      <div className="flex items-center justify-between mb-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-board-muted">
          Departments
        </h2>
        <button
          onClick={onClose}
          aria-label="Close column settings"
          className="p-1 rounded text-board-muted hover:text-board-text"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex flex-wrap gap-2 mb-3">
        {columns.map((column) => (
          <div
            key={column.id}
            className="flex items-center gap-1.5 rounded-lg border border-board-border bg-board-bg px-2 py-1"
          >
            <input
              defaultValue={column.label}
              onBlur={(event) => {
                if (event.target.value.trim() !== column.label) {
                  void rename(column.id, event.target.value);
                }
              }}
              aria-label={`Rename ${column.label}`}
              className="w-24 bg-transparent text-xs text-board-text outline-none focus:ring-1 focus:ring-fire-500/40 rounded px-1"
            />
            <select
              value={column.color}
              onChange={(event) => void recolour(column.id, event.target.value)}
              aria-label={`Colour for ${column.label}`}
              className={`text-[10px] rounded px-1 py-0.5 border-0 outline-none ${tintFor(column.color).head} ${tintFor(column.color).text}`}
            >
              {CUE_COLUMN_COLORS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <button
              onClick={() => void remove(column)}
              aria-label={`Delete ${column.label}`}
              className="p-0.5 rounded text-board-muted hover:text-red-400"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void add();
          }}
          placeholder="Add a department — SM, SC, V2…"
          maxLength={60}
          className="w-56 px-2.5 py-1.5 rounded-lg bg-board-bg border border-board-border text-xs text-board-text placeholder:text-board-muted/50 outline-none focus:border-fire-500/50"
        />
        <select
          value={color}
          onChange={(event) => setColor(event.target.value)}
          aria-label="Colour for the new column"
          className={`text-[11px] rounded-lg px-2 py-1.5 border-0 outline-none ${tintFor(color).head} ${tintFor(color).text}`}
        >
          {CUE_COLUMN_COLORS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <button
          onClick={() => void add()}
          disabled={busy || !label.trim()}
          className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-fire-500/15 border border-fire-500/30 text-fire-400 hover:bg-fire-500/25 disabled:opacity-50 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          Add
        </button>
      </div>

      {error && <p className="text-[11px] text-red-400 mt-2">{error}</p>}
      {ConfirmDialogEl}
    </div>
  );
}
