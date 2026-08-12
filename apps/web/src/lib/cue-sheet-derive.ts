/**
 * Cue sheet derivation — pure, so it can be tested without Workers env,
 * D1 or auth, and so the page and the server function can never disagree
 * about what a row is.
 *
 * Kept separate from cue-sheet.ts because that module imports the Prisma
 * client and `cloudflare:workers`, which cannot be loaded in a unit test.
 */

import { computeCascadedTimes } from "@/lib/rundown-timing";
import { isHeaderItem, type RundownItem, type RundownMeta } from "@/types/rundown";

export interface CueColumnRow {
  id: string;
  label: string;
  color: string;
  sortOrder: number;
  width: number;
}

/** One row of the sheet — a rundown item, with its notes attached. */
export interface CueRow {
  itemId: string;
  title: string;
  type: string;
  /** True for a section band: no times, no cue, spans the table. */
  isSection: boolean;
  cue: string;
  durationMs: number;
  scheduledStart: string | null;
  expectedEnd: string | null;
  status: string;
  /** columnId → text. Only cells with content are present. */
  notes: Record<string, string>;
}

export interface CueNoteRow {
  itemId: string;
  columnId: string;
  text: string;
}

/**
 * Rundown items in, cue rows out.
 *
 * Times come from the same cascade the rundown and the dashboard use, so
 * a start time changed in the rundown is correct here without anything
 * being copied. Notes attach by the item's stable id, which is what makes
 * the sheet impossible to orphan — the old cue sheet matched on title, so
 * a rename silently detached the cue.
 */
export function toCueRows(
  items: RundownItem[],
  meta: RundownMeta | undefined,
  notes: CueNoteRow[],
): CueRow[] {
  const byItem = new Map<string, Record<string, string>>();
  for (const note of notes) {
    const bucket = byItem.get(note.itemId) ?? {};
    bucket[note.columnId] = note.text;
    byItem.set(note.itemId, bucket);
  }

  return computeCascadedTimes(items, meta).map((item) => {
    const section = isHeaderItem(item);
    return {
      itemId: item.id,
      title: item.title,
      type: item.type,
      isSection: section,
      cue: item.cue ?? "",
      durationMs: section ? 0 : item.duration,
      scheduledStart: section ? null : item.scheduledStart,
      expectedEnd: section ? null : item.expectedEnd,
      status: item.status,
      notes: byItem.get(item.id) ?? {},
    };
  });
}

/**
 * Which service the sheet opens on.
 *
 * The rundown editor decides. Whatever service is open there is the one
 * the team is working on — load a rundown from years ago and the cue
 * sheet goes with it. Only when nothing has been opened yet does this
 * fall back to guessing: the next service that has a running order, then
 * the most recent one, then today.
 *
 * Opening blindly on today was the bug this replaces. A church runs one
 * or two services a week, so six days out of seven "today" has no
 * rundown and the sheet looks broken when it is merely empty.
 */
export function resolveCueSheetDate(
  dates: string[],
  today: string,
  activeServiceDate?: string | null,
): string {
  const sorted = [...new Set(dates)].sort();
  // Honoured only if that service actually has a running order.
  // "Follow the rundown" means follow a real one — an active date left
  // pointing at an empty day would land the operator back on the empty
  // sheet this whole resolution order exists to avoid.
  if (activeServiceDate && sorted.includes(activeServiceDate)) return activeServiceDate;
  if (sorted.length === 0) return today;
  return sorted.find((d) => d >= today) ?? sorted[sorted.length - 1];
}
