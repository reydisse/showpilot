/**
 * Horizontal scroll with edge affordances.
 *
 * Dense toolbars scroll sideways rather than hiding controls behind
 * breakpoints — a control off to the side is reachable, one behind a
 * media query is not. But `hide-scrollbar` removes the only cue that
 * there is more, so the edges have to announce themselves.
 *
 * Arrow buttons rather than a decorative fade: trackpads and
 * touchscreens can swipe, a plain mouse cannot, and a Windows laptop
 * with a mouse is a stated target. A fade alone would say "there is
 * more" while offering no way to reach it.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

export interface EdgeScroll {
  ref: RefObject<HTMLDivElement | null>;
  edges: { left: boolean; right: boolean };
  scrollBy: (amount: number) => void;
}

export function useEdgeScroll(): EdgeScroll {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const update = () => {
      setEdges({
        left: el.scrollLeft > 2,
        right: Math.ceil(el.scrollLeft + el.clientWidth) < el.scrollWidth - 2,
      });
    };

    update();
    el.addEventListener("scroll", update, { passive: true });
    // Content can change width without the container resizing — a longer
    // service name, a role with more buttons — so watch the children too.
    const observer = new ResizeObserver(update);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);

    return () => {
      el.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, []);

  const scrollBy = useCallback((amount: number) => {
    ref.current?.scrollBy({ left: amount, behavior: "smooth" });
  }, []);

  return { ref, edges, scrollBy };
}

/**
 * Render inside a `relative` parent, as a sibling of the scroller.
 * Both sides vanish when everything fits, so a wide layout is untouched.
 */
export function ScrollEdges({ edges, scrollBy, step = 260 }: Omit<EdgeScroll, "ref"> & { step?: number }) {
  return (
    <>
      {edges.left && (
        <>
          <div className="pointer-events-none absolute inset-y-0 left-0 w-12 bg-gradient-to-r from-board-bg to-transparent" />
          <button
            type="button"
            onClick={() => scrollBy(-step)}
            aria-label="Scroll left"
            className="absolute left-1 top-1/2 -translate-y-1/2 p-1 rounded-full bg-board-card border border-board-border text-board-muted hover:text-board-text transition-colors"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
        </>
      )}
      {edges.right && (
        <>
          <div className="pointer-events-none absolute inset-y-0 right-0 w-12 bg-gradient-to-l from-board-bg to-transparent" />
          <button
            type="button"
            onClick={() => scrollBy(step)}
            aria-label="Scroll right"
            className="absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded-full bg-board-card border border-board-border text-board-muted hover:text-board-text transition-colors"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </>
      )}
    </>
  );
}
