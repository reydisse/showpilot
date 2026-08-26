import { describe, expect, it } from "vitest";
import {
  buildScheduleQuerySelection,
  getScheduleSelectionDeps,
  normalizeScheduleSearch,
} from "../schedule-selection";

describe("schedule selection", () => {
  it("preserves a valid deep link as loader dependencies", () => {
    const search = normalizeScheduleSearch({
      show: "show-future",
      date: "2027-10-03",
      assignment: "assignment-1",
    });

    expect(search).toEqual({
      show: "show-future",
      date: "2027-10-03",
      assignment: "assignment-1",
    });
    expect(getScheduleSelectionDeps(search)).toEqual({
      selectedDate: "2027-10-03",
      selectedShowId: "show-future",
    });
  });

  it("drops malformed selections before they reach the schedule query", () => {
    expect(normalizeScheduleSearch({
      show: "",
      date: "2026-02-30",
      assignment: "x".repeat(65),
    })).toEqual({
      show: undefined,
      date: undefined,
      assignment: undefined,
    });
  });

  it("fetches an explicit date and show alongside the bounded default window", () => {
    expect(buildScheduleQuerySelection({
      from: "2026-07-27",
      to: "2026-09-26",
      selectedDate: "2027-10-03",
      selectedShowId: "show-future",
    })).toEqual({
      rundowns: [
        { serviceDate: { gte: "2026-07-27", lte: "2026-09-26" } },
        { serviceDate: "2027-10-03" },
        { id: "show-future" },
      ],
      related: [
        { serviceDate: { gte: "2026-07-27", lte: "2026-09-26" } },
        { serviceDate: "2027-10-03" },
        { showId: "show-future" },
      ],
    });
  });
});
