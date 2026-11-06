import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export interface MeasuredRowProps {
  ref: (node: HTMLElement | null) => void;
  "data-index": number;
  "data-virtual-row-id": string;
  "aria-rowindex"?: number;
  "aria-posinset"?: number;
  "aria-setsize"?: number;
  role?: "listitem";
}

export function includeInteractionRows(range: Range, pinned: readonly number[]) {
  const indices = new Set(defaultRangeExtractor(range));
  for (const index of pinned) {
    // Neighbours keep natural Tab order continuous across a virtual boundary.
    for (const neighbour of [index - 1, index, index + 1]) {
      if (neighbour >= 0 && neighbour < range.count) indices.add(neighbour);
    }
  }
  return [...indices].sort((a, b) => a - b);
}

export function keyboardNeighbours(index: number, count: number, canFocus: (index: number) => boolean) {
  const neighbours: number[] = [];
  for (const direction of [-1, 1]) {
    for (let candidate = index + direction; candidate >= 0 && candidate < count; candidate += direction) {
      if (canFocus(candidate)) { neighbours.push(candidate); break; }
    }
  }
  return neighbours;
}

/** One measured list in the page's existing scroller, with focused/dragged rows retained. */
export function VirtualRows<T>({ items, getKey, renderRow, getScrollParent, estimateSize, pinnedIds = [], as = "div", colSpan = 1, className = "", gap = 0, canFocusRow = () => true }: {
  items: readonly T[];
  getKey: (item: T) => string;
  renderRow: (item: T, index: number, props: MeasuredRowProps) => ReactNode;
  getScrollParent: (body: HTMLElement) => HTMLElement | null;
  estimateSize: (index: number) => number;
  pinnedIds?: readonly (string | null)[];
  as?: "div" | "tbody";
  colSpan?: number;
  className?: string;
  gap?: number;
  canFocusRow?: (item: T) => boolean;
}) {
  const body = useRef<HTMLElement | null>(null);
  const [layout, setLayout] = useState<{ scroller: HTMLElement | null; margin: number; width: number }>({ scroller: null, margin: 0, width: 0 });
  const [focused, setFocused] = useState<string | null>(null);
  const [pointer, setPointer] = useState<string | null>(null);
  const enabled = items.length > 100;
  const pinned = [focused, pointer, ...pinnedIds].map(id => id === null ? -1 : items.findIndex(item => getKey(item) === id)).filter(index => index >= 0);
  const focusedIndex = focused === null ? -1 : items.findIndex(item => getKey(item) === focused);
  if (focusedIndex >= 0) pinned.push(...keyboardNeighbours(focusedIndex, items.length, index => canFocusRow(items[index])));
  const pinKey = [...new Set(pinned)].sort((a,b) => a-b).join(",");
  const rangeExtractor = useCallback((range: Range) => includeInteractionRows(range, pinKey ? pinKey.split(",").map(Number) : []), [pinKey]);
  const getItemKey = useCallback((index: number) => getKey(items[index]), [items, getKey]);
  const virtualizer = useVirtualizer<HTMLElement, HTMLElement>({
    count: items.length, enabled, getScrollElement: () => layout.scroller,
    getItemKey, estimateSize, overscan: 8,
    initialRect: { width: 800, height: 600 }, scrollMargin: layout.margin, gap,
    rangeExtractor,
  });
  useLayoutEffect(() => {
    const element = body.current;
    if (!enabled || !element) return;
    const refresh = () => {
      const scroller = getScrollParent(element);
      if (!scroller) return;
      const bounds = element.getBoundingClientRect();
      const margin = bounds.top - scroller.getBoundingClientRect().top + scroller.scrollTop - scroller.clientTop;
      setLayout(previous => previous.scroller === scroller && Math.abs(previous.margin - margin) < 0.5 && previous.width === bounds.width ? previous : { scroller, margin, width: bounds.width });
    };
    refresh();
    const observer = new ResizeObserver(refresh);
    // Ancestors can change size independently (notices, inspector, responsive layout).
    for (let node: HTMLElement | null = element; node; node = node.parentElement) observer.observe(node);
    window.addEventListener("resize", refresh);
    return () => { observer.disconnect(); window.removeEventListener("resize", refresh); };
  }, [enabled, getScrollParent]);
  useLayoutEffect(() => { if (enabled) virtualizer.measure(); }, [enabled, layout.width, virtualizer]);
  useEffect(() => {
    const release = () => setPointer(null);
    window.addEventListener("pointerup", release); window.addEventListener("pointercancel", release);
    return () => { window.removeEventListener("pointerup", release); window.removeEventListener("pointercancel", release); };
  }, []);
  const rowId = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>("[data-virtual-row-id]")?.dataset.virtualRowId ?? null : null;
  const spacer = (height: number, key: string) => height <= 0 ? null : as === "tbody"
    ? <tr key={key} aria-hidden="true" data-virtual-spacer><td colSpan={colSpan} style={{ height, padding: 0, border: 0 }} /></tr>
    : <div key={key} aria-hidden="true" data-virtual-spacer style={{ height }} />;
  const render = (index: number) => renderRow(items[index], index, {
    ref: enabled ? virtualizer.measureElement : () => {}, "data-index": index, "data-virtual-row-id": getKey(items[index]),
    ...(as === "tbody" ? { "aria-rowindex": index + 2 } : { role: "listitem", "aria-posinset": index + 1, "aria-setsize": items.length }),
  });
  const visible = virtualizer.getVirtualItems();
  let end = 0;
  const children = enabled ? visible.map(row => {
    const before = row.start - layout.margin - end;
    end = row.end - layout.margin;
    return <Fragment key={row.key}>{spacer(before, `space-${row.key}`)}{render(row.index)}</Fragment>;
  }) : items.map((item, index) => <Fragment key={getKey(item)}>{index > 0 && spacer(gap, `gap-${index}`)}{render(index)}</Fragment>);
  const handlers = {
    onFocusCapture: (event: React.FocusEvent<HTMLElement>) => setFocused(rowId(event.target)),
    onBlurCapture: (event: React.FocusEvent<HTMLElement>) => setFocused(rowId(event.relatedTarget)),
    onPointerDownCapture: (event: React.PointerEvent<HTMLElement>) => setPointer(rowId(event.target)),
  };
  const content = <>{children}{enabled && spacer(Math.max(0, virtualizer.getTotalSize() - end), "end")}</>;
  return as === "tbody"
    ? <tbody ref={node => { body.current = node; }} data-virtualized={enabled} className={className} {...handlers}>{content}</tbody>
    : <div ref={node => { body.current = node; }} role="list" data-virtualized={enabled} className={className} {...handlers}>{content}</div>;
}
