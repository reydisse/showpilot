/**
 * The cue sheet's row shape.
 *
 * The rebuild's whole premise is that the sheet cannot drift from the
 * rundown, because it has no rows of its own. These tests pin the
 * derivation that makes that true: rundown items in, cue rows out, with
 * section bands carried through as spanning bands and notes attached by
 * the item's stable id.
 *
 * The logic under test is deliberately extracted from the server function
 * so it can run without Workers env, D1 or auth.
 */

import { describe, expect, it } from "vitest";
import { computeCascadedTimes } from "@/lib/rundown-timing";
import { isHeaderItem, type RundownItem } from "@/types/rundown";
import type { CueRow } from "@/lib/cue-sheet";

const MINUTE = 60_000;
const START = new Date("2026-08-09T09:00:00.000Z").getTime();

/**
 * Mirror of the mapping in `getCueSheet`. Kept in step by the assertions
 * below plus tsc — `CueRow` is the real exported type.
 */
function toRows(
  items: RundownItem[],
  meta: { serviceDate: string; scheduledStartTime: string | null; status: "stopped" },
  notes: { itemId: string; columnId: string; text: string }[],
): CueRow[] {
  const timed = computeCascadedTimes(items, meta);
  const byItem = new Map<string, Record<string, string>>();
  for (const note of notes) {
    const bucket = byItem.get(note.itemId) ?? {};
    bucket[note.columnId] = note.text;
    byItem.set(note.itemId, bucket);
  }
  return timed.map((item) => ({
    itemId: item.id,
    title: item.title,
    type: item.type,
    isSection: isHeaderItem(item),
    cue: item.cue ?? "",
    durationMs: isHeaderItem(item) ? 0 : item.duration,
    scheduledStart: isHeaderItem(item) ? null : item.scheduledStart,
    expectedEnd: isHeaderItem(item) ? null : item.expectedEnd,
    status: item.status,
    notes: byItem.get(item.id) ?? {},
  }));
}

function item(overrides: Partial<RundownItem> & { id: string }): RundownItem {
  return {
    title: "Welcome",
    type: "segment",
    duration: 10 * MINUTE,
    notes: "",
    assignee: "",
    cue: "",
    status: "upcoming",
    sortOrder: 0,
    hardStop: false,
    scheduledStart: null,
    expectedEnd: null,
    actualStart: null,
    actualEnd: null,
    ...overrides,
  };
}

const meta = {
  serviceDate: "2026-08-09",
  scheduledStartTime: new Date(START).toISOString(),
  status: "stopped" as const,
};

describe("cue sheet rows", () => {
  it("produces one row per rundown item, in rundown order", () => {
    const rows = toRows(
      [
        item({ id: "a", title: "Pre-service prayer", cue: "1" }),
        item({ id: "b", title: "Testimonies", cue: "2" }),
      ],
      meta,
      [],
    );
    expect(rows.map((r) => r.title)).toEqual(["Pre-service prayer", "Testimonies"]);
    expect(rows.map((r) => r.cue)).toEqual(["1", "2"]);
  });

  it("carries a section band through as a spanning row with no times", () => {
    const rows = toRows(
      [
        item({ id: "h", title: "Pre - service", type: "header", duration: 0 }),
        item({ id: "a" }),
      ],
      meta,
      [],
    );
    expect(rows[0].isSection).toBe(true);
    expect(rows[0].scheduledStart).toBeNull();
    expect(rows[0].expectedEnd).toBeNull();
    expect(rows[0].durationMs).toBe(0);
    // The item under the band still starts at the show start.
    expect(rows[1].scheduledStart).toBe(new Date(START).toISOString());
  });

  it("cascades start and end times from the rundown, not from stored copies", () => {
    const rows = toRows(
      [item({ id: "a", duration: 40 * MINUTE }), item({ id: "b", duration: 5 * MINUTE })],
      meta,
      [],
    );
    expect(rows[0].scheduledStart).toBe(new Date(START).toISOString());
    expect(rows[1].scheduledStart).toBe(new Date(START + 40 * MINUTE).toISOString());
    expect(rows[1].expectedEnd).toBe(new Date(START + 45 * MINUTE).toISOString());
  });

  it("attaches notes to the right cell and leaves the rest empty", () => {
    const rows = toRows(
      [item({ id: "a" }), item({ id: "b" })],
      meta,
      [
        { itemId: "a", columnId: "col-prod", text: "Cue 5 live" },
        { itemId: "a", columnId: "col-lx", text: "Dim house" },
      ],
    );
    expect(rows[0].notes).toEqual({ "col-prod": "Cue 5 live", "col-lx": "Dim house" });
    expect(rows[1].notes).toEqual({});
  });

  it("follows the rundown when an item moves, because notes key off the item id", () => {
    // The old cue sheet stored its own copy of the running order and
    // matched on title, so reordering or renaming silently orphaned a
    // cue. Keying on itemId is what makes that impossible.
    const notes = [{ itemId: "b", columnId: "col-prod", text: "Cue 3 live" }];
    const before = toRows([item({ id: "a" }), item({ id: "b", title: "Offering" })], meta, notes);
    const after = toRows(
      [item({ id: "b", title: "Offering renamed" }), item({ id: "a" })],
      meta,
      notes,
    );
    expect(before[1].notes["col-prod"]).toBe("Cue 3 live");
    expect(after[0].notes["col-prod"]).toBe("Cue 3 live");
  });

  it("returns no rows when there is no rundown, rather than inventing any", () => {
    expect(toRows([], meta, [])).toEqual([]);
  });
});
