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

/** Reconstruct relay time without discarding resumed progress or offsets. */
export function liveElapsedMs(input: {
  playback: string;
  elapsed: number;
  startedAt: number | null;
  nowMs: number;
}): number {
  return input.playback === "play" && input.startedAt !== null
    ? input.elapsed + (input.nowMs - input.startedAt)
    : input.elapsed;
}

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
  /**
   * The note written on the rundown item itself, as opposed to a
   * department's note. Read-only here: the rundown owns it, and two
   * places to edit one field is how the old cue sheet drifted.
   */
  note: string;
  /** Who the rundown says owns the item. */
  assignee: string;
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
      note: item.notes ?? "",
      assignee: item.assignee ?? "",
      notes: byItem.get(item.id) ?? {},
    };
  });
}

/**
 * Which service the sheet opens on.
 *
 * Whatever the rundown has loaded, full stop. The rundown is where the
 * team decides which service they are working on; the cue sheet is a
 * view of that decision, and it does not get a second opinion — even if
 * that service is still empty, because an empty sheet next to an empty
 * rundown is correct and consistent.
 *
 * The fallbacks below only apply before anything has been opened at all:
 * the next service that has a running order, then the most recent, then
 * today. Opening blindly on today is what this replaces — a church runs
 * one or two services a week, so six days out of seven "today" has no
 * rundown and the sheet looks broken when it is merely empty.
 *
 * From there the operator can move the sheet anywhere with its own
 * picker; that choice is held on the page, not here.
 */
export function resolveCueSheetDate(
  dates: string[],
  today: string,
  activeServiceDate?: string | null,
): string {
  if (activeServiceDate) return activeServiceDate;
  const sorted = [...new Set(dates)].sort();
  if (sorted.length === 0) return today;
  return sorted.find((d) => d >= today) ?? sorted[sorted.length - 1];
}

// ─── The caller's clock ──────────────────────────────────────

export interface CallerClock {
  /** The item on air, if any. */
  liveTitle: string | null;
  /** What the caller calls next. Null at the end of the service. */
  nextTitle: string | null;
  /**
   * Time left on the current item. Negative once it overruns — the sign
   * matters more than the number, so it is kept rather than clamped.
   */
  itemRemainingMs: number | null;
  /** How long the current item has been running. */
  itemElapsedMs: number | null;
  /** Where the rundown says the service ends. */
  plannedEndMs: number | null;
  /** Where it will actually end if everything from here runs to plan. */
  expectedEndMs: number | null;
  /** Expected minus planned. Positive is late. */
  offsetMs: number | null;
}

export interface CallerClockInput {
  rows: CueRow[];
  currentItemId: string | null;
  /** Milliseconds the current item has been running. */
  elapsedMs: number;
  nowMs: number;
}

/**
 * The numbers a show caller reads while calling a service.
 *
 * Deliberately projected forward rather than reported backward: "we will
 * finish nine minutes late" is actionable — drop a verse, tighten the
 * notices — where "we are nine minutes behind" only says how it feels.
 *
 * Everything is derived from the same rows the sheet renders, so the
 * clock can never disagree with the page under it.
 */
export function deriveCallerClock({
  rows,
  currentItemId,
  elapsedMs,
  nowMs,
}: CallerClockInput): CallerClock {
  const items = rows.filter((row) => !row.isSection);
  const plannedEnd = items.length > 0 ? items[items.length - 1].expectedEnd : null;
  const plannedEndMs = plannedEnd ? new Date(plannedEnd).getTime() : null;

  const index = currentItemId ? items.findIndex((row) => row.itemId === currentItemId) : -1;
  const current = index >= 0 ? items[index] : null;
  const next = index >= 0 ? (items[index + 1] ?? null) : (items[0] ?? null);

  if (!current) {
    // Nothing running: the plan is the forecast, and there is no offset
    // to report because nothing has had a chance to slip yet.
    return {
      liveTitle: null,
      nextTitle: next?.title ?? null,
      itemRemainingMs: null,
      itemElapsedMs: null,
      plannedEndMs,
      expectedEndMs: plannedEndMs,
      offsetMs: null,
    };
  }

  const itemRemainingMs = current.durationMs - elapsedMs;
  // Everything after the current item is assumed to run to plan. A
  // caller cannot act on a guess about item nine; they can act on the
  // consequence of the one they are in.
  const remainingAfter = items
    .slice(index + 1)
    .reduce((sum, row) => sum + Math.max(0, row.durationMs), 0);
  // Clamped at zero: an item that has overrun is still on air, so it
  // cannot finish in the past and buy time back. Left signed, a 9-minute
  // overrun cancelled itself out of the forecast and the service read as
  // on time while the caller watched it slip.
  const expectedEndMs = nowMs + Math.max(0, itemRemainingMs) + remainingAfter;
  const plannedStart = items[0]?.scheduledStart
    ? new Date(items[0].scheduledStart).getTime()
    : null;
  // A future/past rundown is often run as a rehearsal. Comparing today's
  // wall clock with that service date produces nonsense such as -4169m.
  // Timer and item remaining are still useful; schedule offset is not.
  const scheduleIsCurrent =
    plannedStart !== null &&
    plannedEndMs !== null &&
    nowMs >= plannedStart - 24 * 60 * 60 * 1000 &&
    nowMs <= plannedEndMs + 24 * 60 * 60 * 1000;

  return {
    liveTitle: current.title,
    nextTitle: next?.title ?? null,
    itemRemainingMs,
    itemElapsedMs: elapsedMs,
    plannedEndMs,
    expectedEndMs,
    offsetMs: scheduleIsCurrent ? expectedEndMs - plannedEndMs! : null,
  };
}

/**
 * Which service the *rundown* opens on.
 *
 * This is the one place that decides, and everything downstream just
 * follows it. The rundown used to open blindly on today, which is empty
 * six days a week for a church — and once the cue sheet started
 * following the rundown, that emptiness propagated: open the editor on a
 * Wednesday and the cue sheet went blank too.
 *
 * So the "does this service exist" judgement lives here, at the source,
 * rather than being re-litigated by every page that follows along.
 *
 * `datesWithItems` is exactly what it says — a date whose rundown was
 * created but never filled does not count as somewhere to land.
 */
export function resolveOpeningServiceDate(
  datesWithItems: string[],
  today: string,
  activeServiceDate?: string | null,
): string {
  const sorted = [...new Set(datesWithItems)].sort();
  // Where the team last worked, if there is still anything there.
  if (activeServiceDate && sorted.includes(activeServiceDate)) return activeServiceDate;
  if (sorted.length === 0) return today;
  return sorted.find((d) => d >= today) ?? sorted[sorted.length - 1];
}
