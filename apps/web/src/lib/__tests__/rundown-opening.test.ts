import { describe, expect, it } from "vitest";
import { resolveRundownOpeningShow } from "../rundown-opening";

const shows = [
  { id: "old", serviceDate: "2026-08-16" },
  { id: "next", serviceDate: "2026-08-23" },
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

  it("uses the active or next show only when no date was requested", () => {
    expect(resolveRundownOpeningShow({ shows, today: "2026-08-21", activeShowId: "old" })?.id).toBe("old");
    expect(resolveRundownOpeningShow({ shows, today: "2026-08-21" })?.id).toBe("next");
  });
});
