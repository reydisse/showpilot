import { describe, expect, it } from "vitest";
import { formatServicePickerLabel } from "../service-picker";

describe("formatServicePickerLabel", () => {
  it("always includes the occurrence date when a service has a name", () => {
    expect(formatServicePickerLabel({
      name: "Sunday Service",
      serviceDate: "2026-08-23",
    })).toBe("Sunday Service — Sun, Aug 23, 2026");
  });

  it("does not duplicate the date for an unnamed service", () => {
    expect(formatServicePickerLabel({
      name: "",
      serviceDate: "2026-08-23",
    })).toBe("Sun, Aug 23, 2026");
  });

  it("can include the venue time and today marker", () => {
    expect(formatServicePickerLabel({
      name: "Evening Service",
      serviceDate: "2026-08-23",
      scheduledStartTime: "2026-08-23T18:30:00.000Z",
    }, {
      timeZone: "Africa/Accra",
      today: "2026-08-23",
    })).toBe("Evening Service — Sun, Aug 23, 2026 · 6:30 PM · today");
  });
});
