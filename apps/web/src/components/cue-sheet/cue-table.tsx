import { useDeviceTimeZone } from "@/hooks/useDeviceTimeZone";
import { VirtualRows } from "@/components/ui/virtual-rows";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronsLeft, ChevronsRight, Expand } from "lucide-react";
import type { CueColumnRow, CueRow } from "@/lib/cue-sheet-derive";
import { rundownItemNumbers } from "@/types/rundown";
import { liveElapsedMs } from "@/lib/cue-sheet-derive";
import type { NativeTimerState } from "@/types/rundown";
import { departmentStyle } from "./department-color";

export const BASE_COLUMNS = [{ key: "cue", label: "Cue", width: 52 }, { key: "start", label: "Start", width: 56 }, { key: "end", label: "End", width: 56 }, { key: "duration", label: "Dur", width: 48 }] as const;
export const RUNDOWN_DETAIL_COLUMNS = [{ key: "owner", label: "Owner", width: 130 }, { key: "note", label: "Note", width: 200 }] as const;
export const TOGGLEABLE_COLUMNS = [...BASE_COLUMNS, ...RUNDOWN_DETAIL_COLUMNS];
export type BaseColumnKey = (typeof BASE_COLUMNS)[number]["key"];
// Kept for callers of the old exported helper; department colour is identity, never a fill.
export function tintFor(_color: string) { return { head: "bg-board-card", text: "text-board-text" }; }

function clock(iso: string | null, timeZone: string) {
  return iso ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }) : "";
}
function minutes(ms: number) {
  const total = Math.round(ms / 60000);
  return total < 1 ? "" : total < 60 ? `${total}m` : `${Math.floor(total / 60)}h ${total % 60}m`;
}
export function cueRemaining(ms: number) {
  const seconds = Math.floor(Math.abs(ms) / 1000);
  return `${ms < 0 ? "+" : "−"}${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}
interface Props {
  rows: CueRow[]; columns: CueColumnRow[]; hidden: Set<string>; currentItemId: string | null;
  canEdit: boolean; canManageColumns?: boolean; canAdjustLayout?: boolean;
  collapsed?: Set<string>; focusedDepartment?: string | null; compact?: boolean; narrow?: boolean; remainingMs?: number | null; timer?: Pick<NativeTimerState, "playback" | "elapsed" | "startedAt"> | null; initialNow?: number;
  onCollapse?: (id: string) => void; onFocusDepartment?: (id: string) => void;
  onNoteChange: (itemId: string, columnId: string, text: string, expectedText: string) => void;
  onWidthChange: (columnId: string, width: number) => void;
  onReorder: (fromId: string, toId: string) => void;
  cellNotices?: Record<string, React.ReactNode>;
  focusRequest?: { itemId: string; columnId: string } | null;
}
const cueRowKey = (row: CueRow) => row.itemId;
const cueScrollParent = (body: HTMLElement) => body.closest("table")?.parentElement ?? null;
const estimateCueRow = () => 44;
const canFocusCueRow = (row: CueRow) => !row.isSection;

/** The sticky block shares one scroll surface with every department. */
export function CueTable({ rows, columns, hidden, currentItemId, canEdit, canManageColumns = canEdit,
  canAdjustLayout = canManageColumns, collapsed = new Set(), focusedDepartment, compact = false, narrow = false, remainingMs,
  onCollapse, onFocusDepartment, onNoteChange, onWidthChange, timer = null, initialNow = 0, cellNotices = {}, focusRequest }: Props) {
  const timeZone = useDeviceTimeZone();
  const visible = columns.filter(column => !hidden.has(column.id) && (!focusedDepartment || column.id === focusedDepartment));
  const details = RUNDOWN_DETAIL_COLUMNS.filter(column => !hidden.has(column.key) && !focusedDepartment);
  const showCue = !hidden.has("cue");
  const timeFields = ["start", "end", "duration"].filter(key => !hidden.has(key));
  const indexWidth = compact ? 36 : 40, cueWidth = 52, timeWidth = compact ? 150 : 172, titleWidth = narrow ? 96 : compact ? 176 : 220;
  const timeLeft = indexWidth + (showCue ? cueWidth : 0);
  const titleLeft = timeLeft + (timeFields.length ? timeWidth : 0);
  const fieldCount = 2 + Number(showCue) + Number(timeFields.length > 0) + details.length;
  const [rowHeights, setRowHeights] = useState(() => new Map<string, number>());
  const [activeCell, setActiveCell] = useState<string | null>(null);
  const itemNumbers = rundownItemNumbers(rows.map(row => ({ id: row.itemId, type: row.type })));
  const items = rows.filter(row => !row.isSection);
  const currentIndex = items.findIndex(row => row.itemId === currentItemId);
  const nextId = items[currentIndex + 1]?.itemId;
  const table = useRef<HTMLTableElement>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  useLayoutEffect(() => {
    const parent = table.current?.parentElement; if (!parent) return;
    const update = () => setViewportWidth(parent.clientWidth);
    update(); const observer = new ResizeObserver(update); observer.observe(parent);
    return () => observer.disconnect();
  }, []);
  const revealCell = (cell: HTMLElement) => {
    const scroller = table.current?.parentElement; if (!scroller) return;
    const frozen = titleLeft + titleWidth;
    const available = Math.max(0, scroller.clientWidth - frozen);
    const right = cell.offsetLeft + Math.min(cell.offsetWidth, available);
    let left = scroller.scrollLeft;
    if (cell.offsetLeft < left + frozen || cell.offsetWidth > available) left = cell.offsetLeft - frozen;
    else if (right > left + scroller.clientWidth) left = right - scroller.clientWidth;
    scroller.scrollLeft = Math.max(0, left);
  };
  const navigable = visible.filter(column => focusedDepartment || !collapsed.has(column.id));
  const firstCell = navigable.length && items.length ? JSON.stringify([items[0].itemId, navigable[0].id]) : null;
  const focusCell = (itemId: string, columnId: string, edit = false) => {
    const cells = table.current?.querySelectorAll<HTMLElement>("[data-cue-cell]");
    const target = Array.from(cells ?? []).find(cell => cell.dataset.itemId === itemId && cell.dataset.columnId === columnId);
    if (!target) return;
    if (edit) target.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true }); else target.focus({ preventScroll: true });
    target.scrollIntoView?.({ block: "nearest", inline: "nearest" }); revealCell(target);
  };
  const navigate = (event: KeyboardEvent, itemId: string, columnId: string) => {
    if (event.target instanceof HTMLTextAreaElement) return;
    const row = items.findIndex(item => item.itemId === itemId), col = navigable.findIndex(column => column.id === columnId);
    const delta: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (event.key === "Enter" && canEdit) { event.preventDefault(); focusCell(itemId, columnId, true); }
    const move = delta[event.key];
    if (!move) return;
    event.preventDefault();
    const nextRow = items[Math.min(items.length - 1, Math.max(0, row + move[0]))];
    const nextCol = navigable[Math.min(navigable.length - 1, Math.max(0, col + move[1]))];
    if (nextRow && nextCol) focusCell(nextRow.itemId, nextCol.id);
  };
  const moveEditor = (itemId: string, columnId: string, direction: "down" | "next" | "previous") => {
    let row = items.findIndex(item => item.itemId === itemId), col = navigable.findIndex(column => column.id === columnId);
    if (direction === "down") row++;
    else { col += direction === "next" ? 1 : -1; if (col >= navigable.length) { col = 0; row++; } if (col < 0) { col = navigable.length - 1; row--; } }
    if (items[row] && navigable[col]) focusCell(items[row].itemId, navigable[col].id, direction !== "down");
    else focusCell(itemId, columnId);
  };
  useLayoutEffect(() => {
    if (!focusRequest) return;
    const frame = requestAnimationFrame(() => focusCell(focusRequest.itemId, focusRequest.columnId));
    return () => cancelAnimationFrame(frame);
  }, [focusRequest]);
  const widthFor = (column: CueColumnRow) => focusedDepartment ? Math.max(96, Math.min(520, (viewportWidth || 1004) - titleLeft - titleWidth)) : collapsed.has(column.id) ? 44 : narrow ? Math.max(160, Math.min(column.width, (viewportWidth || 360) - titleLeft - titleWidth)) : Math.min(480, Math.max(160, column.width));
  const tableWidth = titleLeft + titleWidth + details.reduce((sum, column) => sum + column.width, 0) + visible.reduce((sum, column) => sum + widthFor(column), 0);
  return <table style={{ width: tableWidth, minWidth: tableWidth }} ref={table} onFocusCapture={event => { const cell = event.target.closest<HTMLElement>("[data-cue-cell]"); if (cell) revealCell(cell); }} role="grid" aria-label="Cue sheet" aria-rowcount={rows.length + 1} aria-colcount={fieldCount + visible.length} className="cue-sheet-grid">
    <colgroup>
      <col style={{ width: indexWidth }} />{showCue && <col style={{ width: cueWidth }} />}{timeFields.length > 0 && <col style={{ width: timeWidth }} />}
      <col style={{ width: titleWidth }} />{details.map(column => <col key={column.key} style={{ width: column.width }} />)}
      {visible.map(column => <col key={column.id} style={{ width: widthFor(column) }} />)}
    </colgroup>
    <thead><tr>
      <Pinned as="th" left={0} width={indexWidth} className="cue-index cue-field-head">#</Pinned>
      {showCue && <Pinned as="th" left={indexWidth} width={cueWidth} className="cue-field-head">Cue</Pinned>}
      {timeFields.length > 0 && <Pinned as="th" left={timeLeft} width={timeWidth} className="cue-field-head">Time</Pinned>}
      <Pinned as="th" left={titleLeft} width={titleWidth} divider className="cue-field-head">Title</Pinned>
      {details.map(column => <th key={column.key} className="cue-field-head" style={{ width: column.width, minWidth: column.width }}>{column.label}</th>)}
      {visible.map(column => {
        const isCollapsed = !focusedDepartment && collapsed.has(column.id);
        const count = rows.filter(row => row.notes[column.id]?.trim()).length;
        return <th key={column.id} data-cue-column-id={column.id} className={`cue-dept-head ${isCollapsed ? "cue-collapsed" : ""}`}
          style={{ ...departmentStyle(column.color), width: widthFor(column), minWidth: widthFor(column), maxWidth: widthFor(column) }}>
          <div className="cue-dept-label"><span className="cue-dept-dot" />
            {isCollapsed ? <button type="button" className="cue-icon" aria-label={`Expand ${column.label}`} title={`Expand ${column.label}`} onClick={() => onCollapse?.(column.id)}><ChevronsRight /></button> : <>
              <span className="cue-dept-name">{column.label}</span><span className="cue-dept-count">{count}</span>
              {!focusedDepartment && <span className="cue-dept-tools">
                {onFocusDepartment && <button type="button" className="cue-icon" title={`Focus ${column.label}`} aria-label={`Focus ${column.label}`} onClick={() => onFocusDepartment(column.id)}><Expand /></button>}
                {onCollapse && <button type="button" className="cue-icon" title={`Collapse ${column.label}`} aria-label={`Collapse ${column.label}`} onClick={() => onCollapse(column.id)}><ChevronsLeft /></button>}
              </span>}
            </>}
          </div>
          {canAdjustLayout && !isCollapsed && !focusedDepartment && <ColumnResizer label={column.label} width={widthFor(column)} onCommit={width => onWidthChange(column.id, width)} />}
        </th>;
      })}
    </tr></thead>
    <VirtualRows as="tbody" items={rows} getKey={cueRowKey} getScrollParent={cueScrollParent} estimateSize={estimateCueRow} canFocusRow={canFocusCueRow} pinnedIds={[currentItemId, focusRequest?.itemId ?? null]} colSpan={fieldCount + visible.length}
      renderRow={(row, _index, rowProps) => {
        if (row.isSection) return <tr key={row.itemId} {...rowProps} className="cue-section" data-cue-row-id={row.itemId}><td colSpan={fieldCount + visible.length}><span className="sticky left-3">{itemNumbers.get(row.itemId)} · {row.title || "Section"}</span></td></tr>;
        const live = row.itemId === currentItemId, done = row.status === "complete";
        return <tr key={row.itemId} {...rowProps} data-cue-row-id={row.itemId} style={{ height: rowHeights.get(row.itemId) }} className={`${live ? "cue-live" : done ? "cue-done" : ""}`}>
          <Pinned left={0} width={indexWidth} className="cue-index relative"><span>{itemNumbers.get(row.itemId)}</span><RowResizer rowLabel={row.title || "untitled"} onCommit={height => setRowHeights(previous => new Map(previous).set(row.itemId, height))} /></Pinned>
          {showCue && <Pinned left={indexWidth} width={cueWidth}><span className="cue-mono cue-quiet">{row.cue}</span></Pinned>}
          {timeFields.length > 0 && <Pinned left={timeLeft} width={timeWidth}><div className="cue-time"><span>{!hidden.has("start") && clock(row.scheduledStart, timeZone)}{!hidden.has("start") && !hidden.has("end") && " → "}{!hidden.has("end") && clock(row.expectedEnd, timeZone)}</span>{!hidden.has("duration") && <span className="cue-duration">{minutes(row.durationMs)}</span>}</div></Pinned>}
          <Pinned left={titleLeft} width={titleWidth} divider><div className="cue-item-title"><span className="cue-title-text" title={row.title}>{row.title || "Untitled"}</span>
            {row.itemId === nextId && <span className="cue-next-tag">Next</span>}
            {live && (remainingMs != null ? <span className="cue-remaining" data-over={remainingMs < 0}>{cueRemaining(remainingMs)}</span> : timer ? <LiveCueRemaining durationMs={row.durationMs} timer={timer} initialNow={initialNow} /> : null)}
          </div></Pinned>
          {details.map(column => <td key={column.key}><span className="cue-quiet whitespace-pre-wrap">{column.key === "owner" ? row.assignee : row.note}</span></td>)}
          {visible.map(column => collapsed.has(column.id) && !focusedDepartment ? <td key={column.id} className="cue-collapsed" aria-label={`${column.label} collapsed`} /> : <NoteCell key={column.id}
            itemId={row.itemId} columnId={column.id} label={`${column.label}: ${row.title}`} value={row.notes[column.id] ?? ""} canEdit={canEdit}
            notice={cellNotices[JSON.stringify([row.itemId, column.id])]}
            tabIndex={(activeCell ?? firstCell) === JSON.stringify([row.itemId, column.id]) ? 0 : -1}
            onFocusCell={() => setActiveCell(JSON.stringify([row.itemId, column.id]))}
            onNavigate={event => navigate(event, row.itemId, column.id)}
            onMove={direction => moveEditor(row.itemId, column.id, direction)}
            onCommit={(text, expectedText) => onNoteChange(row.itemId, column.id, text, expectedText)} />)}
        </tr>;
      }} />
  </table>;
}

function Pinned({ as = "td", left, width, divider, className = "", children }: { as?: "td" | "th"; left: number; width: number; divider?: boolean; className?: string; children: React.ReactNode }) {
  const Tag = as;
  return <Tag style={{ left, width, minWidth: width, maxWidth: width }} className={`cue-pinned ${divider ? "cue-frozen-end" : ""} ${className}`}>{children}</Tag>;
}

function NoteCell({ value, canEdit, onCommit, itemId, columnId, label, tabIndex, onFocusCell, onNavigate, onMove, notice }: {
  notice?: React.ReactNode; value: string; canEdit: boolean; itemId: string; columnId: string; label: string; tabIndex: number;
  onFocusCell: () => void; onNavigate: (event: KeyboardEvent) => void; onMove: (direction: "down" | "next" | "previous") => void;
  onCommit: (text: string, expectedText: string) => void;
}) {
  const [draft, setDraft] = useState(value), [editing, setEditing] = useState(false);
  const editBase = useRef(value), cancelled = useRef(false), committed = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  useLayoutEffect(() => { const node = textareaRef.current; if (node) { node.style.height = "0px"; node.style.height = `${Math.max(44, node.scrollHeight)}px`; } }, [draft]);
  useEffect(() => {
    const node = textareaRef.current; if (!node) return;
    let width = node.clientWidth;
    const observer = new ResizeObserver(() => { if (width === node.clientWidth) return; width = node.clientWidth; node.style.height = "0px"; node.style.height = `${Math.max(44, node.scrollHeight)}px`; });
    observer.observe(node); return () => observer.disconnect();
  }, []);
  const commit = () => { if (!cancelled.current && !committed.current && draft !== editBase.current) { committed.current = true; onCommit(draft, editBase.current); } };
  return <td role="gridcell" data-cue-cell data-item-id={itemId} data-column-id={columnId} aria-label={label} tabIndex={tabIndex}
    data-empty={!draft} className="cue-note-cell" onFocus={onFocusCell} onKeyDown={onNavigate}
    onClick={event => { if (canEdit && event.target === event.currentTarget) textareaRef.current?.focus(); }}>
    {canEdit ? <textarea ref={textareaRef} value={draft} title={editing ? undefined : draft || undefined} rows={1} maxLength={2000} aria-label={`Edit ${label}`} tabIndex={-1}
      onFocus={() => { editBase.current = value; cancelled.current = false; committed.current = false; setEditing(true); }}
      onChange={event => setDraft(event.target.value)}
      onBlur={() => { commit(); setEditing(false); }}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); cancelled.current = true; setDraft(value); event.currentTarget.blur(); event.currentTarget.closest<HTMLElement>("td")?.focus(); }
        else if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") { event.preventDefault(); commit(); event.currentTarget.blur(); onMove(event.key === "Enter" ? "down" : event.shiftKey ? "previous" : "next"); }
      }} className="overflow-hidden" /> : <div className="cue-read-note" title={value}>{value}</div>}
    {notice}
  </td>;
}

function ColumnResizer({ label, width, onCommit }: { label: string; width: number; onCommit: (width: number) => void }) {
  const start = useRef<{ x: number; width: number; header: HTMLElement; col: HTMLElement | null; table: HTMLTableElement; tableWidth: number } | null>(null);
  const clamp = (width: number) => Math.min(480, Math.max(160, Math.round(width)));
  const finish = (event: ReactPointerEvent, cancel = false) => {
    const current = start.current; if (!current) return;
    const next = clamp(current.width + event.clientX - current.x);
    current.header.style.width = `${width}px`; current.header.style.minWidth = `${width}px`; current.header.style.maxWidth = `${width}px`;
    if (current.col) current.col.style.width = `${width}px`; current.table.style.width = `${current.tableWidth}px`; current.table.style.minWidth = `${current.tableWidth}px`;
    start.current = null;
    if (!cancel && next !== width) onCommit(next);
  };
  return <span role="separator" tabIndex={0} aria-orientation="vertical" aria-label={`Resize ${label} column`} aria-valuemin={160} aria-valuemax={480} aria-valuenow={width}
    onKeyDown={event => { if (["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); onCommit(clamp(width + (event.key === "ArrowRight" ? 10 : -10))); } }}
    onPointerDown={event => { if (event.button !== 0) return; const header = event.currentTarget.closest("th"); if (!header) return; event.currentTarget.setPointerCapture?.(event.pointerId); const table = header.closest("table")!; const col = table.querySelectorAll<HTMLElement>("col")[header.cellIndex] ?? null; start.current = { x: event.clientX, width, header, col, table, tableWidth: table.getBoundingClientRect().width }; event.preventDefault(); }}
    onPointerMove={event => { const current = start.current; if (!current) return; const next = clamp(current.width + event.clientX - current.x); current.header.style.width = `${next}px`; current.header.style.minWidth = `${next}px`; current.header.style.maxWidth = `${next}px`; if (current.col) current.col.style.width = `${next}px`; current.table.style.width = `${current.tableWidth + next - width}px`; current.table.style.minWidth = `${current.tableWidth + next - width}px`; }}
    onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize touch-none hover:bg-board-border focus:bg-board-border" />;
}
/** Drag the bottom edge of a row to give every cell in it more room. */
function RowResizer({
  rowLabel,
  onCommit,
}: {
  rowLabel: string;
  onCommit: (height: number) => void;
}) {
  const start = useRef<{
    row: HTMLTableRowElement;
    y: number;
    height: number;
    inlineHeight: string;
  } | null>(null);

  const heightFor = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = start.current;
    if (!current) return null;
    return Math.min(1_000, Math.max(30, Math.round(current.height + event.clientY - current.y)));
  };

  const finish = (event: ReactPointerEvent<HTMLButtonElement>, cancelled: boolean) => {
    const current = start.current;
    if (!current) return;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (cancelled) {
      current.row.style.height = current.inlineHeight;
    } else {
      const next = heightFor(event);
      if (next !== null) onCommit(next);
    }
    current.row.removeAttribute("data-row-resizing");
    start.current = null;
  };

  return (
    <button
      type="button"
      role="separator"
      aria-orientation="horizontal"
      aria-label={`Resize ${rowLabel} row`}
      className="cue-row-resizer absolute bottom-0 left-0 z-20 h-1 w-full cursor-row-resize touch-none rounded-sm bg-board-border/50 opacity-0 transition-opacity hover:bg-fire-500/70 hover:opacity-100 focus-visible:bg-fire-500/70 focus-visible:opacity-100"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const row = event.currentTarget.closest<HTMLTableRowElement>("tr");
        if (!row) return;
        start.current = {
          row,
          y: event.clientY,
          height: row.getBoundingClientRect().height,
          inlineHeight: row.style.height,
        };
        row.setAttribute("data-row-resizing", "1");
        try {
          event.currentTarget.setPointerCapture?.(event.pointerId);
        } catch {
          // Synthetic or already-released pointers can reject capture;
          // pointer movement still works while the handle remains mounted.
        }
        event.preventDefault();
      }}
      onPointerMove={(event) => {
        const current = start.current;
        const next = heightFor(event);
        if (!current || next === null) return;
        current.row.style.height = `${next}px`;
      }}
      onPointerUp={(event) => finish(event, false)}
      onPointerCancel={(event) => finish(event, true)}
    />
  );
}


function LiveCueRemaining({ durationMs, timer, initialNow }: { durationMs: number; timer: Pick<NativeTimerState, "playback" | "elapsed" | "startedAt">; initialNow: number }) {
  const [now, setNow] = useState(initialNow);
  useEffect(() => { setNow(Date.now()); const interval = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(interval); }, []);
  const remaining = durationMs - liveElapsedMs({ ...timer, nowMs: now });
  return <span className="cue-remaining" data-over={remaining < 0}>{cueRemaining(remaining)}</span>;
}
