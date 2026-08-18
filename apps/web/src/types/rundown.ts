/**
 * "header" is a section band — "Pre-service", "Pre-sermon" — not a
 * segment. It carries no time and never goes live; it exists to break a
 * long rundown into readable blocks in the editor, the cue sheet and the
 * operator views. Everything that walks the running order must skip it,
 * which is what `isHeaderItem` below is for.
 */
export type ItemType =
  | "segment"
  | "song"
  | "prayer"
  | "announcement"
  | "offering"
  | "custom"
  | "header";
export type ItemStatus = "upcoming" | "live" | "complete";

/** Section bands are structure, not running order. */
export function isHeaderItem(item: { type: string }): boolean {
  return item.type === "header";
}

/** Human-facing hierarchy: section 2 owns playable rows 2.1, 2.2, etc. */
export function rundownItemNumbers<T extends { id: string; type: string }>(items: T[]): Map<string, string> {
  const numbers = new Map<string, string>();
  if (!items.some(isHeaderItem)) {
    items.forEach((item, index) => numbers.set(item.id, String(index + 1)));
    return numbers;
  }
  let section = 0;
  let child = 0;
  let unsectioned = 0;
  for (const item of items) {
    if (isHeaderItem(item)) {
      section = Math.max(section + 1, unsectioned + 1);
      child = 0;
      numbers.set(item.id, String(section));
    } else if (section === 0) {
      unsectioned += 1;
      numbers.set(item.id, String(unsectioned));
    } else {
      child += 1;
      numbers.set(item.id, `${section}.${child}`);
    }
  }
  return numbers;
}

export interface RundownItem {
  id: string;
  title: string;
  type: ItemType;
  duration: number; // ms
  notes: string;
  assignee: string;
  cue: string;
  status: ItemStatus;
  sortOrder: number;
  hardStop: boolean;
  lowerThirdId?: string;
  scheduledStart?: string | null; // ISO timestamp
  expectedEnd?: string | null;    // ISO timestamp
  actualStart?: string | null;    // ISO timestamp
  actualEnd?: string | null;      // ISO timestamp
}

export interface RundownMeta {
  serviceDate: string;
  /** Optional label, e.g. "Christmas Eve 7pm". */
  name?: string;
  scheduledStartTime?: string | null; // ISO timestamp
  status: "stopped" | "live" | "complete";
}

export interface NativeTimerState {
  playback: "stop" | "play" | "pause";
  currentItemId: string | null;
  elapsed: number;
  startedAt: number | null;
  pausedAt: number | null;
  mode: "count-up" | "count-down" | "clock";
  serverTime: number;
}

export interface RundownState {
  items: RundownItem[];
  timer: NativeTimerState;
  meta?: RundownMeta;
}
