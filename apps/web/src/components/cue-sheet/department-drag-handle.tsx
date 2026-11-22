import { useRef, type PointerEvent } from "react";
import { GripVertical } from "lucide-react";
import type { CueColumnRow } from "@/lib/cue-sheet-derive";

export function DepartmentDragHandle({ column, columns, disabled, onReorder }: { column: CueColumnRow; columns: CueColumnRow[]; disabled: boolean; onReorder: (from: string, to: string) => void }) {
  const target = useRef<string | null>(null);
  const finish = (event: PointerEvent<HTMLButtonElement>) => {
    const to = target.current; target.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (to && to !== column.id) onReorder(column.id, to);
  };
  return <button type="button" className="cue-drag-handle" disabled={disabled} aria-label={`Move ${column.label} department. Drag or use arrow keys.`}
    onKeyDown={event => {
      const delta = event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : 0;
      if (!delta) return; event.preventDefault();
      const to = columns[columns.findIndex(item => item.id === column.id) + delta]; if (to) onReorder(column.id, to.id);
    }}
    onPointerDown={event => { if (event.button !== 0 || disabled) return; target.current = column.id; event.currentTarget.setPointerCapture?.(event.pointerId); event.preventDefault(); }}
    onPointerMove={event => { if (!target.current) return; const over = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-department-order-id]")?.dataset.departmentOrderId; if (over && columns.some(column => column.id === over)) target.current = over; }}
    onPointerUp={finish} onPointerCancel={() => { target.current = null; }}><GripVertical /></button>;
}
