import { describe, expect, it } from "vitest";
import { selectActiveShow } from "../active-rundown-relay";

const shows = [
  { id: "morning", serviceDate: "2026-08-23" },
  { id: "evening", serviceDate: "2026-08-23" },
  { id: "next-week", serviceDate: "2026-08-30" },
];

describe("active rundown relay selection", () => {
  it("uses stable show identity before the shared calendar date", () => {
    expect(selectActiveShow(shows, "2026-08-23", "evening", "2026-08-23"))
      .toEqual(shows[1]);
  });

  it("falls back through active date, upcoming show, then latest show", () => {
    expect(selectActiveShow(shows, "2026-08-20", undefined, "2026-08-23"))
      .toEqual(shows[0]);
    expect(selectActiveShow(shows, "2026-08-25")).toEqual(shows[2]);
    expect(selectActiveShow(shows, "2026-09-01")).toEqual(shows[2]);
  });
});
