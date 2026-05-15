import type { RundownItem, RundownMeta } from "@/types/rundown";

export interface TimedRundownItem extends RundownItem {
  scheduledStart: string | null;
  expectedEnd: string | null;
}

/**
 * Given the scheduled show start time and item durations, compute
 * scheduledStart / expectedEnd for every item in order.
 *
 * Items with actualStart already set are treated as anchors —
 * subsequent items cascade from the actual time if the item ran
 * longer than planned, otherwise they still cascade from scheduled.
 */
export function computeCascadedTimes(
  items: RundownItem[],
  meta: RundownMeta | undefined,
): TimedRundownItem[] {
  const showStart = meta?.scheduledStartTime ? new Date(meta.scheduledStartTime).getTime() : null;

  if (showStart === null) {
    return items.map((item) => ({
      ...item,
      scheduledStart: item.scheduledStart ?? null,
      expectedEnd: item.expectedEnd ?? null,
    }));
  }

  let cursor = showStart;

  return items.map((item) => {
    const scheduledStart = new Date(cursor).toISOString();
    const expectedEnd = new Date(cursor + item.duration).toISOString();

    // If the item has already run (actualEnd exists), advance cursor from
    // the later of expectedEnd and actualEnd so we account for overrun.
    if (item.actualEnd) {
      const actualEndMs = new Date(item.actualEnd).getTime();
      cursor = Math.max(cursor + item.duration, actualEndMs);
    } else {
      cursor += item.duration;
    }

    return {
      ...item,
      scheduledStart,
      expectedEnd,
    };
  });
}

/**
 * Returns the overrun in ms for a given item (positive = late, negative = early/on-time).
 * Returns null if the item hasn't started yet.
 */
export function itemOverrunMs(item: RundownItem): number | null {
  if (!item.actualStart) return null;
  const endTime = item.actualEnd ? new Date(item.actualEnd).getTime() : Date.now();
  const elapsed = endTime - new Date(item.actualStart).getTime();
  return elapsed - item.duration;
}

/**
 * Format a duration in ms as HH:MM:SS or MM:SS.
 */
export function formatDuration(ms: number, forceHours = false): string {
  const abs = Math.abs(ms);
  const sign = ms < 0 ? "-" : "";
  const totalSeconds = Math.floor(abs / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;

  const pad = (n: number) => String(n).padStart(2, "0");

  if (h > 0 || forceHours) {
    return `${sign}${h}:${pad(m)}:${pad(s)}`;
  }
  return `${sign}${pad(m)}:${pad(s)}`;
}

/**
 * Format an ISO timestamp as a human-readable time (HH:MM or HH:MM:SS).
 */
export function formatTime(iso: string | null | undefined, includeSeconds = false): string {
  if (!iso) return "--:--";
  const d = new Date(iso);
  const h = d.getHours();
  const m = d.getMinutes();
  const s = d.getSeconds();
  const pad = (n: number) => String(n).padStart(2, "0");
  if (includeSeconds) return `${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${pad(h)}:${pad(m)}`;
}
