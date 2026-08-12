/**
 * The cue sheet grid.
 *
 * Rows are rundown items. The left block (cue, times, title) is read-only
 * and mirrors the rundown; the department columns to the right are where
 * the work happens. That split is the whole design: one running order,
 * many departments writing against it.
 */

import { useEffect, useRef, useState } from "react";
import { GripVertical } from "lucide-react";
import type { CueColumnRow, CueRow } from "@/lib/cue-sheet";

/**
 * Column header tints. Deliberately a fixed palette rather than free hex:
 * operators work in dark booths and an arbitrary colour is a contrast bug
 * waiting to happen during a service.
 */
export const COLUMN_TINTS: Record<string, { head: string; text: string }> = {
  slate: { head: "bg-board-border", text: "text-board-text" },
  amber: { head: "bg-amber-500/85", text: "text-amber-950" },
  green: { head: "bg-green-500/80", text: "text-green-950" },
  blue: { head: "bg-blue-400/85", text: "text-blue-950" },
  purple: { head: "bg-purple-400/85", text: "text-purple-950" },
  pink: { head: "bg-pink-400/85", text: "text-pink-950" },
  cyan: { head: "bg-cyan-400/85", text: "text-cyan-950" },
  red: { head: "bg-red-400/85", text: "text-red-950" },
};

export function tintFor(color: string) {
  return COLUMN_TINTS[color] ?? COLUMN_TINTS.slate;
}

function clock(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function minutes(ms: number): string {
  if (ms <= 0) return "";
  const total = Math.round(ms / 60000);
  if (total < 60) return `${total}m`;
  return `${Math.floor(total / 60)}h ${total % 60}m`;
}

interface Props {
  rows: CueRow[];
  columns: CueColumnRow[];
  /** Column ids the operator has hidden locally. */
  hidden: Set<string>;
  currentItemId: string | null;
  canEdit: boolean;
  onNoteChange: (itemId: string, columnId: string, text: string) => void;
  onWidthChange: (columnId: string, width: number) => void;
  onReorder: (fromId: string, toId: string) => void;
}

export function CueTable({
  rows,
  columns,
  hidden,
  currentItemId,
  canEdit,
  onNoteChange,
  onWidthChange,
  onReorder,
}: Props) {
  const visible = columns.filter((column) => !hidden.has(column.id));
  const [dragId, setDragId] = useState<string | null>(null);

  return (
    <div className="overflow-x-auto">
      <table className="border-collapse text-xs" style={{ minWidth: "100%" }}>
        <thead className="sticky top-0 z-10">
          <tr>
            <Th className="w-10 text-right">#</Th>
            <Th className="w-14">Cue</Th>
            <Th className="w-16">Start</Th>
            <Th className="w-16">End</Th>
            <Th className="w-14">Dur</Th>
            <Th className="min-w-[220px]">Title</Th>
            {visible.map((column) => {
              const tint = tintFor(column.color);
              return (
                <th
                  key={column.id}
                  draggable={canEdit}
                  onDragStart={() => setDragId(column.id)}
                  onDragEnd={() => setDragId(null)}
                  onDragOver={(event) => {
                    if (dragId && dragId !== column.id) event.preventDefault();
                  }}
                  onDrop={() => {
                    if (dragId && dragId !== column.id) onReorder(dragId, column.id);
                    setDragId(null);
                  }}
                  style={{ width: column.width, minWidth: column.width }}
                  className={`relative px-2 py-1.5 text-left font-medium border-r border-board-bg/40 ${tint.head} ${tint.text} ${
                    dragId === column.id ? "opacity-50" : ""
                  }`}
                >
                  <span className="flex items-center gap-1">
                    {canEdit && <GripVertical className="w-3 h-3 opacity-50 shrink-0" />}
                    <span className="truncate">{column.label}</span>
                  </span>
                  {canEdit && (
                    <ColumnResizer
                      width={column.width}
                      onCommit={(width) => onWidthChange(column.id, width)}
                    />
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            // A section band spans the table. Giving it cells would invite
            // notes against a heading, which belong on an item.
            if (row.isSection) {
              return (
                <tr key={row.itemId}>
                  <td
                    colSpan={6 + visible.length}
                    className="px-3 py-1.5 bg-board-border/40 text-[11px] font-semibold uppercase tracking-[0.12em] text-board-muted border-y border-board-border"
                  >
                    {row.title || "Section"}
                  </td>
                </tr>
              );
            }

            const isLive = row.itemId === currentItemId;
            const isDone = row.status === "complete";

            return (
              <tr
                key={row.itemId}
                className={`border-b border-board-border/40 ${
                  isLive ? "bg-fire-500/10" : isDone ? "opacity-55" : "hover:bg-board-card/40"
                }`}
              >
                <Td className="text-right text-board-muted/60 tabular-nums">{index + 1}</Td>
                <Td className="tabular-nums text-board-text">{row.cue}</Td>
                <Td className="tabular-nums text-board-muted/70 font-mono">
                  {clock(row.scheduledStart)}
                </Td>
                <Td className="tabular-nums text-board-muted/70 font-mono">
                  {clock(row.expectedEnd)}
                </Td>
                <Td className="tabular-nums text-board-muted">{minutes(row.durationMs)}</Td>
                <Td
                  className={`${isLive ? "text-fire-400 font-medium" : "text-board-text"} ${
                    isDone ? "line-through" : ""
                  }`}
                >
                  {row.title || "Untitled"}
                </Td>
                {visible.map((column) => (
                  <NoteCell
                    key={column.id}
                    value={row.notes[column.id] ?? ""}
                    canEdit={canEdit}
                    onCommit={(text) => onNoteChange(row.itemId, column.id, text)}
                  />
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={`px-2 py-1.5 text-left font-medium text-board-muted bg-board-card border-b border-r border-board-border ${className}`}
    >
      {children}
    </th>
  );
}

function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-2 py-1.5 border-r border-board-border/30 ${className}`}>{children}</td>;
}

/**
 * One editable cell.
 *
 * Local state while focused, committed on blur. Committing per keystroke
 * would put a write on the wire for every letter typed on a church
 * connection; committing only on blur means a cell left focused when the
 * tab closes loses its text, so Enter commits too.
 */
function NoteCell({
  value,
  canEdit,
  onCommit,
}: {
  value: string;
  canEdit: boolean;
  onCommit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);

  // Adopt remote edits, but never while this operator is mid-word in the
  // same cell — overwriting what someone is actively typing is the worst
  // possible outcome of a live sync.
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  if (!canEdit) {
    return (
      <td className="px-2 py-1.5 border-r border-board-border/30 align-top text-board-muted whitespace-pre-wrap">
        {value}
      </td>
    );
  }

  return (
    <td className="p-0 border-r border-board-border/30 align-top">
      <textarea
        value={draft}
        rows={1}
        onFocus={() => setEditing(true)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          setEditing(false);
          if (draft !== value) onCommit(draft);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            setDraft(value);
            event.currentTarget.blur();
          }
        }}
        className="w-full h-full min-h-[30px] px-2 py-1.5 bg-transparent text-board-text resize-none outline-none focus:bg-board-bg focus:ring-1 focus:ring-fire-500/50 placeholder:text-board-muted/30"
      />
    </td>
  );
}

/** Drag the right edge of a header to resize. Commits once, on release. */
function ColumnResizer({
  width,
  onCommit,
}: {
  width: number;
  onCommit: (width: number) => void;
}) {
  const start = useRef<{ x: number; width: number } | null>(null);

  useEffect(() => {
    function move(event: PointerEvent) {
      if (!start.current) return;
      const next = Math.round(
        Math.min(640, Math.max(80, start.current.width + (event.clientX - start.current.x))),
      );
      // Live feedback without a render per pixel: the header cell is
      // resized directly, and React state only catches up on release.
      const th = document.querySelector<HTMLElement>(`[data-resizing="1"]`);
      if (th) {
        th.style.width = `${next}px`;
        th.style.minWidth = `${next}px`;
      }
    }
    function up(event: PointerEvent) {
      if (!start.current) return;
      const next = Math.round(
        Math.min(640, Math.max(80, start.current.width + (event.clientX - start.current.x))),
      );
      start.current = null;
      document.querySelector<HTMLElement>(`[data-resizing="1"]`)?.removeAttribute("data-resizing");
      if (next !== width) onCommit(next);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [width, onCommit]);

  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize column"
      onPointerDown={(event) => {
        const th = event.currentTarget.closest("th");
        if (th) th.setAttribute("data-resizing", "1");
        start.current = { x: event.clientX, width };
        event.preventDefault();
      }}
      className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-black/25"
    />
  );
}
