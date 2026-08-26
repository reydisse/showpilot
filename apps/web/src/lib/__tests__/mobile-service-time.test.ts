import { describe, expect, it } from "vitest";
import {
  formatServiceTime,
  getServiceDateForTimeZone,
} from "../../../../mobile/src/lib/service-time";

describe("mobile service time", () => {
  it("formats the same show instant in the venue timezone", () => {
    const value = "2026-08-25T14:00:00.000Z";
    const date = new Date(value);
    const options = { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" } as const;

    expect(formatServiceTime(value, "America/New_York")).toBe(date.toLocaleTimeString([], options));
    expect(formatServiceTime(value, "America/New_York")).not.toBe(formatServiceTime(value, "Africa/Accra"));
  });

  it("fails closed for missing or invalid service-time data", () => {
    expect(formatServiceTime(null, "Africa/Accra")).toBe("Time not set");
    expect(formatServiceTime("not-a-date", "Africa/Accra")).toBe("Time not set");
    expect(formatServiceTime("2026-08-25T14:00:00.000Z", "Not/A-Timezone")).toBe("Time unavailable");
  });

  it("uses the venue date when the phone and venue are on different days", () => {
    const now = new Date("2026-08-26T01:30:00.000Z");
    expect(getServiceDateForTimeZone("America/Los_Angeles", now)).toBe("2026-08-25");
    expect(getServiceDateForTimeZone("Africa/Accra", now)).toBe("2026-08-26");
  });

  it("falls back to the UTC date for an invalid timezone", () => {
    const now = new Date("2026-08-26T23:30:00.000Z");
    expect(getServiceDateForTimeZone("Not/A-Timezone", now)).toBe("2026-08-26");
  });
});
