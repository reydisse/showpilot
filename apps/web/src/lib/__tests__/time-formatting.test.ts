import { describe, expect, it } from "vitest";
import { formatServicePickerLabel } from "../service-picker";
import { formatClockFull, formatTime } from "../utils";

const instant = new Date("2026-09-22T00:30:15.000Z");

describe("timezone-stable time formatting", () => {
  it("uses the explicit venue timezone for short and full clocks", () => {
    expect(formatTime(instant, "12hr", "America/Toronto")).toBe("8:30 PM");
    expect(formatClockFull(instant, "24hr", "America/Toronto")).toBe(
      "20:30:15",
    );
  });

  it("uses UTC when a service picker has no configured venue timezone", () => {
    expect(
      formatServicePickerLabel({
        serviceDate: "2026-09-22",
        name: "Late show",
        scheduledStartTime: instant.toISOString(),
      }),
    ).toContain("12:30 AM");
  });
});
