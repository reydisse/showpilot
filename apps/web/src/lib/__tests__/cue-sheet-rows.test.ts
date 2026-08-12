/**
 * The cue sheet's row shape.
 *
 * The rebuild's whole premise is that the sheet cannot drift from the
 * rundown, because it has no rows of its own. These tests pin the
 * derivation that makes that true: rundown items in, cue rows out, with
 * section bands carried through as spanning bands and notes attached by
 * the item's stable id.
 *
 * `toCueRows` is the same function the server calls — the pure half lives
 * in cue-sheet-derive precisely so this can exercise it directly rather
 * than a copy that would drift.
 */

import { describe, expect, it } from "vitest";
import { deriveCallerClock, resolveCueSheetDate, toCueRows } from "@/lib/cue-sheet-derive";
import type { RundownItem } from "@/types/rundown";

const toRows = toCueRows;

const MINUTE = 60_000;
const START = new Date("2026-08-09T09:00:00.000Z").getTime();

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

  it("carries the rundown's own note and owner onto the row", () => {
    // The note written on the rundown item has to surface here or the
    // planner and the operator are reading two different documents.
    const rows = toRows(
      [item({ id: "a", notes: "Start live here.", assignee: "Worship Team" })],
      meta,
      [],
    );
    expect(rows[0].note).toBe("Start live here.");
    expect(rows[0].assignee).toBe("Worship Team");
  });

  it("returns no rows when there is no rundown, rather than inventing any", () => {
    expect(toRows([], meta, [])).toEqual([]);
  });
});

describe("which service the cue sheet opens on", () => {
  const dates = ["2026-04-10", "2026-05-19", "2026-09-06"];

  it("follows the rundown editor above everything else", () => {
    // The point of the setting: open a service from years ago in the
    // rundown and the cue sheet goes with it, even though today is not
    // near it and it is not the next service.
    expect(resolveCueSheetDate([...dates, "2016-03-06"], "2026-08-12", "2016-03-06")).toBe(
      "2016-03-06",
    );
  });

  it("follows the rundown even onto a service with nothing in it yet", () => {
    // Building next Sunday from scratch: the rundown is empty, so the
    // cue sheet is empty too. Consistent beats clever — jumping the
    // sheet to some other date would be the app second-guessing the
    // service the team just opened.
    expect(resolveCueSheetDate(dates, "2026-08-12", "2026-10-04")).toBe("2026-10-04");
  });

  it("falls back to the next service with a rundown", () => {
    expect(resolveCueSheetDate(dates, "2026-08-12", null)).toBe("2026-09-06");
  });

  it("falls back to the most recent service when nothing is ahead", () => {
    expect(resolveCueSheetDate(dates, "2026-12-25", null)).toBe("2026-09-06");
  });

  it("uses today only when the org has no rundowns at all", () => {
    expect(resolveCueSheetDate([], "2026-08-12", null)).toBe("2026-08-12");
  });

  it("does not treat an empty stored value as a choice", () => {
    expect(resolveCueSheetDate(dates, "2026-08-12", "")).toBe("2026-09-06");
  });
});

describe("the caller's clock", () => {
  const rows = toRows(
    [
      item({ id: "h", title: "Pre - service", type: "header", duration: 0 }),
      item({ id: "a", title: "Worship", duration: 40 * MINUTE }),
      item({ id: "b", title: "Offering", duration: 10 * MINUTE }),
      item({ id: "c", title: "Sermon", duration: 30 * MINUTE }),
    ],
    meta,
    [],
  );
  // Planned: 09:00 + 40 + 10 + 30 = 10:20.
  const PLANNED_END = START + 80 * MINUTE;

  it("reports the plan and no offset before anything runs", () => {
    const clock = deriveCallerClock({ rows, currentItemId: null, elapsedMs: 0, nowMs: START });
    expect(clock.liveTitle).toBeNull();
    expect(clock.nextTitle).toBe("Worship");
    expect(clock.plannedEndMs).toBe(PLANNED_END);
    expect(clock.expectedEndMs).toBe(PLANNED_END);
    // Nothing has had a chance to slip, so claiming "on time" would be
    // reporting a measurement nobody took.
    expect(clock.offsetMs).toBeNull();
  });

  it("counts down the running item and names what is next", () => {
    const clock = deriveCallerClock({
      rows,
      currentItemId: "a",
      elapsedMs: 25 * MINUTE,
      nowMs: START + 25 * MINUTE,
    });
    expect(clock.liveTitle).toBe("Worship");
    expect(clock.nextTitle).toBe("Offering");
    expect(clock.itemRemainingMs).toBe(15 * MINUTE);
    expect(clock.offsetMs).toBe(0);
  });

  it("projects the overrun forward rather than reporting it backward", () => {
    // Worship is nine minutes long by now and still going. What the
    // caller needs is "we finish nine minutes late", not "we are nine
    // minutes behind" — one of those can be acted on.
    const clock = deriveCallerClock({
      rows,
      currentItemId: "a",
      elapsedMs: 49 * MINUTE,
      nowMs: START + 49 * MINUTE,
    });
    expect(clock.itemRemainingMs).toBe(-9 * MINUTE);
    expect(clock.expectedEndMs).toBe(PLANNED_END + 9 * MINUTE);
    expect(clock.offsetMs).toBe(9 * MINUTE);
  });

  it("recovers the offset when an earlier item ran short", () => {
    // Worship finished four minutes early, so Offering started at 09:36
    // and has been running four minutes. Everything from here to plan
    // lands the service four minutes early.
    const clock = deriveCallerClock({
      rows,
      currentItemId: "b",
      elapsedMs: 4 * MINUTE,
      nowMs: START + 40 * MINUTE,
    });
    expect(clock.offsetMs).toBe(-4 * MINUTE);
  });

  it("says the service is ending rather than naming a next item", () => {
    const clock = deriveCallerClock({
      rows,
      currentItemId: "c",
      elapsedMs: 0,
      nowMs: START + 50 * MINUTE,
    });
    expect(clock.nextTitle).toBeNull();
  });

  it("never treats a section band as something to call", () => {
    const clock = deriveCallerClock({ rows, currentItemId: null, elapsedMs: 0, nowMs: START });
    expect(clock.nextTitle).not.toBe("Pre - service");
  });
});
