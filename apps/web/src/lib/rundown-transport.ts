import { isHeaderItem } from "@/types/rundown";
import type { RundownItem, NativeTimerState, ItemStatus } from "@/types/rundown";

// ─────────────────────────────────────────────────────────────
// Pure rundown transport transitions.
//
// Extracted verbatim from useRundown.ts so the same logic can drive the
// hook, the Companion control endpoints, and unit tests without any React,
// Workers env, or database dependency. Every transition is a pure function
// `(items, timer, …args) => { items, timer }` — it never mutates its inputs
// and never reads the clock except through the injected `now` argument
// (defaulting to Date.now() so callers can stay terse).
// ─────────────────────────────────────────────────────────────

export interface TransportState {
  items: RundownItem[];
  timer: NativeTimerState;
}

/**
 * Resolve the timer's elapsed position without discarding a negative offset.
 * Negative elapsed is intentional: adding time before an item has consumed its
 * full allowance makes the countdown longer than the originally assigned time.
 */
export function elapsedAt(timer: NativeTimerState, now: number = Date.now()): number {
  if (timer.playback === "play" && timer.startedAt !== null) {
    return timer.elapsed + (now - timer.startedAt);
  }
  return timer.elapsed;
}

const DEFAULT_TIMER: NativeTimerState = {
  playback: "stop",
  currentItemId: null,
  elapsed: 0,
  startedAt: null,
  pausedAt: null,
  mode: "count-down",
  serverTime: Date.now(),
};

/**
 * Start (or restart) a specific item. Marks the previously-current item
 * complete and the target live, then runs its timer from zero.
 */
export function start(
  items: RundownItem[],
  timer: NativeTimerState,
  itemId: string,
  now: number = Date.now(),
): TransportState {
  const nextItems = items.map((item) => {
    if (item.id === timer.currentItemId) return { ...item, status: "complete" as ItemStatus };
    if (item.id === itemId) return { ...item, status: "live" as ItemStatus };
    return item;
  });

  const nextTimer: NativeTimerState = {
    playback: "play",
    currentItemId: itemId,
    elapsed: 0,
    startedAt: now,
    pausedAt: null,
    mode: timer.mode,
    serverTime: now,
  };

  return { items: nextItems, timer: nextTimer };
}

/**
 * Pause the running timer, banking elapsed time. No-op unless a timer is
 * actively playing.
 */
export function pause(
  items: RundownItem[],
  timer: NativeTimerState,
  now: number = Date.now(),
): TransportState {
  if (timer.playback !== "play" || timer.startedAt === null) {
    return { items, timer };
  }

  const elapsed = elapsedAt(timer, now);
  const nextTimer: NativeTimerState = {
    ...timer,
    playback: "pause",
    elapsed,
    pausedAt: now,
    serverTime: now,
  };

  return { items, timer: nextTimer };
}

/** Stop the show: the current item returns to upcoming and the timer resets. */
export function stop(items: RundownItem[], timer: NativeTimerState): TransportState {
  const nextItems = timer.currentItemId
    ? items.map((item) =>
        item.id === timer.currentItemId ? { ...item, status: "upcoming" as ItemStatus } : item,
      )
    : items;

  const nextTimer: NativeTimerState = { ...DEFAULT_TIMER, mode: timer.mode };

  return { items: nextItems, timer: nextTimer };
}

/**
 * Advance to the next item. If there is no next item the show stops. Mirrors
 * useRundown's behaviour exactly (no-current → starts the first item).
 */
export function next(
  items: RundownItem[],
  timer: NativeTimerState,
  now: number = Date.now(),
): TransportState {
  const currentIndex = items.findIndex((i) => i.id === timer.currentItemId);
  // Section bands are structure, not running order. Stepping onto one
  // would put a heading live and stop the clock on a real segment, so
  // skip over any that sit between here and the next item.
  let nextIdx = currentIndex + 1;
  while (nextIdx < items.length && isHeaderItem(items[nextIdx])) nextIdx++;
  if (nextIdx < items.length) {
    return start(items, timer, items[nextIdx].id, now);
  }
  return stop(items, timer);
}

/**
 * Step back to the previous item. At the first item (or with no current item)
 * this is a no-op — it never wraps to the end.
 */
export function previous(
  items: RundownItem[],
  timer: NativeTimerState,
  now: number = Date.now(),
): TransportState {
  const currentIndex = items.findIndex((i) => i.id === timer.currentItemId);
  if (currentIndex <= 0) {
    return { items, timer };
  }
  // Step back over section bands, for the same reason as `next`.
  let prevIdx = currentIndex - 1;
  while (prevIdx >= 0 && isHeaderItem(items[prevIdx])) prevIdx--;
  if (prevIdx < 0) {
    return { items, timer };
  }
  return start(items, timer, items[prevIdx].id, now);
}

/**
 * Shift the running/paused timer by ±deltaSeconds without changing play
 * state. Positive adds time (more remaining), negative subtracts it. Elapsed
 * may become negative so added time can exceed the assigned duration. No-op
 * when stopped.
 */
export function adjustTime(
  items: RundownItem[],
  timer: NativeTimerState,
  deltaSeconds: number,
  now: number = Date.now(),
): TransportState {
  const deltaMs = deltaSeconds * 1000;

  if (timer.playback === "play" && timer.startedAt !== null) {
    const elapsed = elapsedAt(timer, now) - deltaMs;
    return { items, timer: { ...timer, elapsed, startedAt: now, serverTime: now } };
  }

  if (timer.playback === "pause") {
    const elapsed = timer.elapsed - deltaMs;
    return { items, timer: { ...timer, elapsed, serverTime: now } };
  }

  return { items, timer };
}
