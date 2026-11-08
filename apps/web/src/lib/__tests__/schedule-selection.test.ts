import { describe, expect, it } from "vitest";
import {
  buildScheduleQuerySelection,
  getScheduleSelectionDeps,
  getScheduleMonthWindow,
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
    expect(
      normalizeScheduleSearch({
        show: "",
        date: "2026-02-30",
        assignment: "x".repeat(65),
      }),
    ).toEqual({
      show: undefined,
      date: undefined,
      assignment: undefined,
    });
  });

  it("fetches an explicit date and show alongside the bounded default window", () => {
    expect(
      buildScheduleQuerySelection({
        from: "2026-07-27",
        to: "2026-09-26",
        selectedDate: "2027-10-03",
        selectedShowId: "show-future",
      }),
    ).toEqual({
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

describe("calendar month navigation", () => {
  it("retains a valid month independently of the selected show", () => {
    const search = normalizeScheduleSearch({
      month: "2099-01",
      show: "selected-show",
      date: "2026-11-08",
    });
    expect(search).toMatchObject({
      month: "2099-01",
      show: "selected-show",
      date: "2026-11-08",
    });
    expect(getScheduleSelectionDeps(search)).toMatchObject({
      calendarMonth: "2099-01",
      selectedShowId: "selected-show",
    });
  });
  it.each(["2099-13", "2099-00", "2099-1", "2099-01-01", {}, ["2099-01"]])(
    "rejects invalid month %j",
    (month) => {
      expect(normalizeScheduleSearch({ month }).month).toBeUndefined();
    },
  );
});

describe("month query windows", () => {
  it.each([
    ["2028-02", "2028-02-29"],
    ["2027-02", "2027-02-28"],
    ["2026-12", "2026-12-31"],
    ["2099-01", "2099-01-31"],
  ])("bounds %s to its actual final day", (month, to) => {
    expect(getScheduleMonthWindow(month)).toEqual({ from: `${month}-01`, to });
  });
});
