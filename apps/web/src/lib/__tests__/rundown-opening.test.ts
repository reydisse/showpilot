import { describe, expect, it } from "vitest";
import { partitionShowsAround, resolveRundownOpeningShow } from "../rundown-opening";

const shows = [
  { id: "old", serviceDate: "2026-08-16" },
  { id: "morning", serviceDate: "2026-08-23" },
  { id: "evening", serviceDate: "2026-08-23" },
  { id: "next", serviceDate: "2026-08-30" },
];

describe("rundown opening selection", () => {
  it("keeps an explicitly selected empty date blank", () => {
    expect(resolveRundownOpeningShow({
      shows,
      today: "2026-08-21",
      requestedServiceDate: "2026-08-22",
      activeShowId: "old",
    })).toBeUndefined();
  });

  it("opens the requested show when it exists", () => {
    expect(resolveRundownOpeningShow({
      shows,
      today: "2026-08-21",
      requestedShowId: "next",
    })?.id).toBe("next");
  });

  it("uses the active instance when a date contains more than one show", () => {
    expect(resolveRundownOpeningShow({
      shows,
      today: "2026-08-21",
      requestedServiceDate: "2026-08-23",
      activeShowId: "evening",
    })?.id).toBe("evening");
  });

  it("keeps same-day shows as separate previous and upcoming instances", () => {
    expect(partitionShowsAround(shows, "evening")).toEqual({
      previous: [shows[1], shows[0]],
      upcoming: [shows[3]],
    });
    expect(partitionShowsAround(shows, "morning")).toEqual({
      previous: [shows[0]],
      upcoming: [shows[2], shows[3]],
    });
  });

  it("uses the active or next show only when no date was requested", () => {
    expect(resolveRundownOpeningShow({ shows, today: "2026-08-21", activeShowId: "old" })?.id).toBe("old");
    expect(resolveRundownOpeningShow({ shows, today: "2026-08-21" })?.id).toBe("morning");
  });
});
