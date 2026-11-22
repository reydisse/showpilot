import { useEffect, useState, type RefObject } from "react";
import type { CueColumnRow } from "@/lib/cue-sheet-derive";
import { departmentStyle } from "./department-color";

export function DepartmentScroller({ columns, scrollRef }: { columns: CueColumnRow[]; scrollRef: RefObject<HTMLDivElement | null> }) {
  const [range, setRange] = useState({ left: 0, width: 100 });
  useEffect(() => {
    const node = scrollRef.current; if (!node) return;
    const update = () => {
      const table = node.querySelector("table");
      const frozen = table?.querySelector<HTMLElement>(".cue-frozen-end");
      const frozenWidth = frozen ? (Number.parseFloat(frozen.style.left) || 0) + frozen.offsetWidth : 0;
      const scrollWidth = Math.max(1, node.scrollWidth - frozenWidth);
      setRange({ left: Math.min(100, node.scrollLeft / scrollWidth * 100), width: Math.min(100, (node.clientWidth - frozenWidth) / scrollWidth * 100) });
      node.dataset.scrolled = String(node.scrollLeft > 0);
    };
    update(); node.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update); observer.observe(node); if (node.firstElementChild) observer.observe(node.firstElementChild);
    return () => { node.removeEventListener("scroll", update); observer.disconnect(); };
  }, [scrollRef, columns]);
  if (!columns.length) return null;
  return <div className="cue-scrollbar"><span>Departments</span><div className="cue-scroll-track" aria-label="Scroll to department">
    {columns.map(column => <button type="button" key={column.id} aria-label={`Scroll to ${column.label}`} title={column.label} style={departmentStyle(column.color)} onClick={() => {
      const node = scrollRef.current; if (!node) return;
      const header = Array.from(node.querySelectorAll<HTMLElement>("[data-cue-column-id]")).find(header => header.dataset.cueColumnId === column.id);
      const frozen = node.querySelector<HTMLElement>(".cue-frozen-end");
      if (header) node.scrollTo({ left: header.offsetLeft - (frozen ? (Number.parseFloat(frozen.style.left) || 0) + frozen.offsetWidth : 0), behavior: "smooth" });
    }} />)}<span className="cue-scroll-thumb" style={{ left: `${Math.min(range.left, 100 - range.width)}%`, width: `${range.width}%` }} />
  </div><div className="cue-scroll-legend">{columns.map(column => <span key={column.id} style={departmentStyle(column.color)}><i className="cue-dept-dot" />{column.label}</span>)}</div></div>;
}
