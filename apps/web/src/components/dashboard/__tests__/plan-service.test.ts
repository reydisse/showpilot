import { describe, expect, it } from "vitest";
import { nextSunday } from "@/components/dashboard/plan-service";

describe("nextSunday", () => {
  it("returns the following Sunday from a midweek day", () => {
    expect(nextSunday(new Date("2026-08-12T09:00:00Z"))).toBe("2026-08-16");
  });

  it("skips to the next one when today is already Sunday", () => {
    // Planning "next Sunday" on a Sunday means the one after — today's
    // service is already underway or done.
    expect(nextSunday(new Date("2026-08-09T09:00:00Z"))).toBe("2026-08-16");
  });

  it("crosses month and year boundaries", () => {
    expect(nextSunday(new Date("2026-08-27T09:00:00Z"))).toBe("2026-08-30");
    expect(nextSunday(new Date("2026-08-31T09:00:00Z"))).toBe("2026-09-06");
    expect(nextSunday(new Date("2026-12-31T09:00:00Z"))).toBe("2027-01-03");
  });
});
