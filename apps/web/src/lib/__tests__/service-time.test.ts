import { describe, expect, it } from "vitest";
import { formatTimeInput, formatWallTime, serviceTimeToIso } from "../utils";

describe("organization service wall times", () => {
  it("round-trips a venue time independently of the device timezone", () => {
    const iso = serviceTimeToIso("2026-08-23", "09:30", "Africa/Accra");
    expect(iso).toBe("2026-08-23T09:30:00.000Z");
    expect(formatTimeInput(iso, "Africa/Accra")).toBe("09:30");
  });

  it("accounts for daylight saving time in the organization timezone", () => {
    const summer = serviceTimeToIso("2026-08-23", "09:30", "America/New_York");
    const winter = serviceTimeToIso("2026-12-23", "09:30", "America/New_York");
    expect(summer).toBe("2026-08-23T13:30:00.000Z");
    expect(winter).toBe("2026-12-23T14:30:00.000Z");
    expect(formatTimeInput(summer, "America/New_York")).toBe("09:30");
    expect(formatTimeInput(winter, "America/New_York")).toBe("09:30");
  });

  it("uses an empty value to clear a saved time", () => {
    expect(serviceTimeToIso("2026-08-23", "", "Africa/Accra")).toBeNull();
    expect(formatTimeInput(null, "Africa/Accra")).toBe("");
  });

  it("formats custom call times without applying the device timezone", () => {
    expect(formatWallTime("17:15")).toBe("5:15 PM");
    expect(formatWallTime("not-a-time")).toBe("");
  });
});
