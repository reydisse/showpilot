import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { RundownItem, RundownState, NativeTimerState, ItemStatus } from "@/types/rundown";
import { saveRundownItems, saveRundownTimer } from "@/lib/rundown";

interface UseRundownOptions {
  orgId: string;
  serviceDate: string;
  initialState?: RundownState;
}

interface UseRundownReturn {
  items: RundownItem[];
  timer: NativeTimerState;
  displayTime: number;
  isOvertime: boolean;
  currentItem: RundownItem | null;
  nextItem: RundownItem | null;
  addItem: (item: Omit<RundownItem, "id" | "sortOrder" | "status">) => void;
  updateItem: (id: string, updates: Partial<RundownItem>) => void;
  removeItem: (id: string) => void;
  reorderItems: (fromIndex: number, toIndex: number) => void;
  start: (itemId: string) => void;
  pause: () => void;
  stop: () => void;
  next: () => void;
  setTimerMode: (mode: "count-up" | "count-down") => void;
}

const defaultTimer: NativeTimerState = {
  playback: "stop",
  currentItemId: null,
  elapsed: 0,
  startedAt: null,
  pausedAt: null,
  mode: "count-down",
  serverTime: Date.now(),
};

function generateId(): string {
  return `rd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * useRundown — React hook for the native ShowPilot rundown system.
 *
 * Manages rundown items, timer state with requestAnimationFrame for smooth
 * display, and debounced persistence to the server via server functions.
 */
export function useRundown({ orgId, serviceDate, initialState }: UseRundownOptions): UseRundownReturn {
  const [items, setItems] = useState<RundownItem[]>(initialState?.items ?? []);
  const [timer, setTimer] = useState<NativeTimerState>(initialState?.timer ?? defaultTimer);
  const [displayTime, setDisplayTime] = useState(0);

  const rafRef = useRef<number | null>(null);
  const saveItemsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveTimerTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timerRef = useRef(timer);
  const itemsRef = useRef(items);

  // Keep refs in sync
  timerRef.current = timer;
  itemsRef.current = items;

  // ─── Derived state ──────────────────────────────────────────

  const currentItem = useMemo(
    () => items.find((i) => i.id === timer.currentItemId) ?? null,
    [items, timer.currentItemId],
  );

  const nextItem = useMemo(() => {
    if (!timer.currentItemId) return items[0] ?? null;
    const currentIndex = items.findIndex((i) => i.id === timer.currentItemId);
    if (currentIndex === -1) return items[0] ?? null;
    return items[currentIndex + 1] ?? null;
  }, [items, timer.currentItemId]);

  const isOvertime = useMemo(() => {
    if (!currentItem || timer.mode !== "count-down") return false;
    return displayTime < 0;
  }, [currentItem, timer.mode, displayTime]);

  // ─── Timer animation loop ──────────────────────────────────

  useEffect(() => {
    const tick = () => {
      const t = timerRef.current;
      if (t.playback === "play" && t.startedAt !== null) {
        const elapsed = Date.now() - t.startedAt;
        const item = itemsRef.current.find((i) => i.id === t.currentItemId);

        if (t.mode === "count-down" && item) {
          setDisplayTime(item.duration - elapsed);
        } else {
          setDisplayTime(elapsed);
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    if (timer.playback === "play") {
      rafRef.current = requestAnimationFrame(tick);
    } else if (timer.playback === "pause") {
      // Show frozen time
      const item = items.find((i) => i.id === timer.currentItemId);
      if (timer.mode === "count-down" && item) {
        setDisplayTime(item.duration - timer.elapsed);
      } else {
        setDisplayTime(timer.elapsed);
      }
    } else {
      setDisplayTime(0);
    }

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [timer.playback, timer.startedAt, timer.currentItemId, timer.elapsed, timer.mode, items]);

  // ─── Debounced persistence ─────────────────────────────────

  const persistItems = useCallback(
    (newItems: RundownItem[]) => {
      if (saveItemsTimeoutRef.current) clearTimeout(saveItemsTimeoutRef.current);
      saveItemsTimeoutRef.current = setTimeout(() => {
        saveRundownItems({ data: { orgId, serviceDate, items: newItems } }).catch(() => {
          // Silent fail — optimistic UI, server will catch up
        });
      }, 1000);
    },
    [orgId, serviceDate],
  );

  const persistTimer = useCallback(
    (newTimer: NativeTimerState) => {
      if (saveTimerTimeoutRef.current) clearTimeout(saveTimerTimeoutRef.current);
      saveTimerTimeoutRef.current = setTimeout(() => {
        saveRundownTimer({ data: { orgId, serviceDate, timer: newTimer } }).catch(() => {
          // Silent fail
        });
      }, 1000);
    },
    [orgId, serviceDate],
  );

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (saveItemsTimeoutRef.current) clearTimeout(saveItemsTimeoutRef.current);
      if (saveTimerTimeoutRef.current) clearTimeout(saveTimerTimeoutRef.current);
    };
  }, []);

  // ─── Item management ───────────────────────────────────────

  const addItem = useCallback(
    (item: Omit<RundownItem, "id" | "sortOrder" | "status">) => {
      setItems((prev) => {
        const newItem: RundownItem = {
          ...item,
          id: generateId(),
          sortOrder: prev.length,
          status: "upcoming" as ItemStatus,
        };
        const next = [...prev, newItem];
        persistItems(next);
        return next;
      });
    },
    [persistItems],
  );

  const updateItem = useCallback(
    (id: string, updates: Partial<RundownItem>) => {
      setItems((prev) => {
        const next = prev.map((item) =>
          item.id === id ? { ...item, ...updates } : item,
        );
        persistItems(next);
        return next;
      });
    },
    [persistItems],
  );

  const removeItem = useCallback(
    (id: string) => {
      // If removing the current item, stop the timer
      if (timerRef.current.currentItemId === id) {
        const stopped: NativeTimerState = { ...defaultTimer, mode: timerRef.current.mode };
        setTimer(stopped);
        persistTimer(stopped);
      }
      setItems((prev) => {
        const next = prev
          .filter((item) => item.id !== id)
          .map((item, i) => ({ ...item, sortOrder: i }));
        persistItems(next);
        return next;
      });
    },
    [persistItems, persistTimer],
  );

  const reorderItems = useCallback(
    (fromIndex: number, toIndex: number) => {
      if (fromIndex === toIndex) return;
      setItems((prev) => {
        const next = [...prev];
        const [moved] = next.splice(fromIndex, 1);
        next.splice(toIndex, 0, moved);
        const reordered = next.map((item, i) => ({ ...item, sortOrder: i }));
        persistItems(reordered);
        return reordered;
      });
    },
    [persistItems],
  );

  // ─── Timer controls ────────────────────────────────────────

  const start = useCallback(
    (itemId: string) => {
      // Mark previous item as complete, target item as live
      setItems((prev) => {
        const next = prev.map((item) => {
          if (item.id === timerRef.current.currentItemId) return { ...item, status: "complete" as ItemStatus };
          if (item.id === itemId) return { ...item, status: "live" as ItemStatus };
          return item;
        });
        persistItems(next);
        return next;
      });

      const now = Date.now();
      const newTimer: NativeTimerState = {
        playback: "play",
        currentItemId: itemId,
        elapsed: 0,
        startedAt: now,
        pausedAt: null,
        mode: timerRef.current.mode,
        serverTime: now,
      };
      setTimer(newTimer);
      persistTimer(newTimer);
    },
    [persistItems, persistTimer],
  );

  const pause = useCallback(() => {
    const t = timerRef.current;
    if (t.playback !== "play" || t.startedAt === null) return;

    const now = Date.now();
    const elapsed = now - t.startedAt;
    const newTimer: NativeTimerState = {
      ...t,
      playback: "pause",
      elapsed,
      pausedAt: now,
      serverTime: now,
    };
    setTimer(newTimer);
    persistTimer(newTimer);
  }, [persistTimer]);

  const stop = useCallback(() => {
    // Mark current item back to upcoming
    if (timerRef.current.currentItemId) {
      setItems((prev) => {
        const next = prev.map((item) =>
          item.id === timerRef.current.currentItemId
            ? { ...item, status: "upcoming" as ItemStatus }
            : item,
        );
        persistItems(next);
        return next;
      });
    }

    const newTimer: NativeTimerState = {
      ...defaultTimer,
      mode: timerRef.current.mode,
    };
    setTimer(newTimer);
    setDisplayTime(0);
    persistTimer(newTimer);
  }, [persistItems, persistTimer]);

  const next = useCallback(() => {
    const currentIndex = itemsRef.current.findIndex(
      (i) => i.id === timerRef.current.currentItemId,
    );
    const nextIdx = currentIndex + 1;
    if (nextIdx < itemsRef.current.length) {
      start(itemsRef.current[nextIdx].id);
    } else {
      // No more items — stop
      stop();
    }
  }, [start, stop]);

  const setTimerMode = useCallback(
    (mode: "count-up" | "count-down") => {
      setTimer((prev) => {
        const newTimer = { ...prev, mode };
        persistTimer(newTimer);
        return newTimer;
      });
    },
    [persistTimer],
  );

  return {
    items,
    timer,
    displayTime,
    isOvertime,
    currentItem,
    nextItem,
    addItem,
    updateItem,
    removeItem,
    reorderItems,
    start,
    pause,
    stop,
    next,
    setTimerMode,
  };
}
