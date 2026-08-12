/**
 * The cue sheet grid.
 *
 * Rows are rundown items. The left block (cue, times, title) is read-only
 * and mirrors the rundown; the department columns to the right are where
 * the work happens. That split is the whole design: one running order,
 * many departments writing against it.
 *
 * A real service sheet is wider than any screen, so the whole grid
 * scrolls sideways and the left block stays pinned — scrolling out to the
 * eighth department and losing which row you are on defeats the point.
 * The scroller itself is owned by the page so there is exactly one, not a
 * table scrolling inside a page that also scrolls.
 */

import { useEffect, useRef, useState } from "react";
import { GripVertical } from "lucide-react";
import type { CueColumnRow, CueRow } from "@/lib/cue-sheet-derive";

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

/**
 * The columns that come from the rundown.
 *
 * Hideable, like the department columns, because on a laptop the times
 * are often dead weight next to eight departments — but # and Title are
 * not in this list: a sheet with no row numbers and no titles is not a
 * sheet.
 */
export const BASE_COLUMNS = [
  { key: "cue", label: "Cue", width: 48 },
  { key: "start", label: "Start", width: 56 },
  { key: "end", label: "End", width: 56 },
  { key: "duration", label: "Dur", width: 48 },
] as const;

/**
 * Columns that come from the rundown but sit past the pinned block:
 * useful context, not identity, so they scroll with the departments.
 * Read-only — the rundown owns them, and a field editable in two places
 * is how the old cue sheet drifted from the running order.
 */
export const RUNDOWN_DETAIL_COLUMNS = [
  { key: "owner", label: "Owner", width: 130 },
  { key: "note", label: "Note", width: 240 },
] as const;

export const TOGGLEABLE_COLUMNS = [...BASE_COLUMNS, ...RUNDOWN_DETAIL_COLUMNS];

export type BaseColumnKey = (typeof BASE_COLUMNS)[number]["key"];

const INDEX_WIDTH = 34;
const TITLE_WIDTH = 230;

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
  /** Column ids and base column keys the operator has hidden locally. */
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
  const bases = BASE_COLUMNS.filter((column) => !hidden.has(column.key));
  const details = RUNDOWN_DETAIL_COLUMNS.filter((column) => !hidden.has(column.key));
  const [dragId, setDragId] = useState<string | null>(null);

  // Left offsets for the pinned block, accumulated in render order so
  // hiding a time column closes the gap instead of leaving a hole.
  let offset = INDEX_WIDTH;
  const baseOffsets = bases.map((column) => {
    const left = offset;
    offset += column.width;
    return left;
  });
  const titleLeft = offset;
  const pinnedWidth = titleLeft + TITLE_WIDTH;

  return (
    <table className="border-collapse text-xs w-max min-w-full">
      <thead>
        <tr>
          <Pinned as="th" left={0} width={INDEX_WIDTH} header className="text-right">
            #
          </Pinned>
          {bases.map((column, index) => (
            <Pinned
              key={column.key}
              as="th"
              left={baseOffsets[index]}
              width={column.width}
              header
            >
              {column.label}
            </Pinned>
          ))}
          <Pinned as="th" left={titleLeft} width={TITLE_WIDTH} header divider>
            Title
          </Pinned>
          {details.map((column) => (
            <th
              key={column.key}
              style={{ width: column.width, minWidth: column.width }}
              className="sticky top-0 z-20 px-2 py-1.5 text-left font-medium text-board-muted bg-board-card border-b border-r border-board-border"
            >
              {column.label}
            </th>
          ))}
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
                className={`sticky top-0 z-20 relative px-2 py-1.5 text-left font-medium border-r border-board-bg/40 ${tint.head} ${tint.text} ${
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
        {/* Section bands are not items, so they must not consume a row
            number — a sheet that reads 2, 4, 5 has an operator hunting
            for the missing ones mid-service. */}
        {(() => {
          let itemNumber = 0;
          return rows.map((row) => {
          // A section band spans the table. Giving it cells would invite
          // notes against a heading, which belong on an item.
          if (row.isSection) {
            return (
              <tr key={row.itemId}>
                <td
                  colSpan={2 + bases.length + details.length + visible.length}
                  className="sticky left-0 px-3 py-1.5 bg-board-border/40 text-[11px] font-semibold uppercase tracking-[0.12em] text-board-muted border-y border-board-border"
                  style={{ maxWidth: pinnedWidth }}
                >
                  {row.title || "Section"}
                </td>
              </tr>
            );
          }

          itemNumber += 1;
          const isLive = row.itemId === currentItemId;
          const isDone = row.status === "complete";
          // Pinned cells need their own background or the scrolling
          // columns show through them.
          const rowBg = isLive ? "bg-[#221610]" : isDone ? "bg-board-bg" : "bg-board-bg";

          return (
            <tr
              key={row.itemId}
              className={`border-b border-board-border/40 ${
                isLive ? "bg-fire-500/10" : isDone ? "opacity-45" : "hover:bg-board-card/40"
              }`}
            >
              <Pinned
                left={0}
                width={INDEX_WIDTH}
                bg={rowBg}
                className="text-right text-board-muted/60 tabular-nums"
              >
                {itemNumber}
              </Pinned>
              {bases.map((column, i) => (
                <Pinned key={column.key} left={baseOffsets[i]} width={column.width} bg={rowBg}>
                  {column.key === "cue" && <span className="text-board-text">{row.cue}</span>}
                  {column.key === "start" && (
                    <span className="text-board-muted/70 font-mono tabular-nums">
                      {clock(row.scheduledStart)}
                    </span>
                  )}
                  {column.key === "end" && (
                    <span className="text-board-muted/70 font-mono tabular-nums">
                      {clock(row.expectedEnd)}
                    </span>
                  )}
                  {column.key === "duration" && (
                    <span className="text-board-muted tabular-nums">{minutes(row.durationMs)}</span>
                  )}
                </Pinned>
              ))}
              <Pinned
                left={titleLeft}
                width={TITLE_WIDTH}
                bg={rowBg}
                divider
                className={isLive ? "text-fire-400 font-medium" : "text-board-text"}
              >
                {row.title || "Untitled"}
              </Pinned>
              {details.map((column) => (
                <td
                  key={column.key}
                  className="px-2 py-1.5 align-top border-r border-board-border/30 text-board-muted whitespace-pre-wrap"
                >
                  {column.key === "owner" ? row.assignee : row.note}
                </td>
              ))}
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
          });
        })()}
      </tbody>
    </table>
  );
}

/**
 * A cell in the pinned left block.
 *
 * Sticky cells must carry an opaque background of their own — the
 * scrolling columns pass underneath them, and a transparent cell shows
 * the text of whatever is sliding past.
 */
function Pinned({
  as = "td",
  left,
  width,
  bg = "bg-board-card",
  header = false,
  divider = false,
  className = "",
  children,
}: {
  as?: "td" | "th";
  left: number;
  width: number;
  bg?: string;
  header?: boolean;
  divider?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const Tag = as;
  return (
    <Tag
      style={{ left, width, minWidth: width }}
      className={`sticky px-2 py-1.5 text-left ${
        header
          ? "top-0 z-30 font-medium text-board-muted bg-board-card border-b border-board-border"
          : `z-10 ${bg}`
      } border-r ${divider ? "border-board-border" : "border-board-border/30"} ${className}`}
    >
      {children}
    </Tag>
  );
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
    function clamp(event: PointerEvent) {
      if (!start.current) return null;
      return Math.round(
        Math.min(640, Math.max(80, start.current.width + (event.clientX - start.current.x))),
      );
    }
    function move(event: PointerEvent) {
      const next = clamp(event);
      if (next === null) return;
      // Live feedback without a render per pixel: the header cell is
      // resized directly, and React state only catches up on release.
      const th = document.querySelector<HTMLElement>(`[data-resizing="1"]`);
      if (th) {
        th.style.width = `${next}px`;
        th.style.minWidth = `${next}px`;
      }
    }
    function up(event: PointerEvent) {
      const next = clamp(event);
      if (next === null) return;
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
