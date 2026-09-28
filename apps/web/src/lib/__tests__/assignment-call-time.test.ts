import { describe, expect, it } from "vitest";
import { getAssignmentCallTime } from "../assignment-call-time";

const show = {
  serviceDate: "2026-09-28",
  callTime: "",
  scheduledStartTime: "2026-09-28T14:00:00.000Z",
  scheduledCallTime: "2026-09-28T12:00:00.000Z",
  timeZone: "America/Toronto",
};

describe("crew arrival times", () => {
  it("uses the saved show call instead of the show start", () => {
    expect(getAssignmentCallTime(show)).toBe("2026-09-28T12:00:00.000Z");
  });

  it("lets the individual assignment override the show in the venue timezone", () => {
    expect(getAssignmentCallTime({ ...show, callTime: "07:30" })).toBe("2026-09-28T11:30:00.000Z");
  });

  it("uses the organization lead when the show call is cleared", () => {
    expect(getAssignmentCallTime({ ...show, scheduledCallTime: null, callLeadMinutes: 45 }))
      .toBe("2026-09-28T13:15:00.000Z");
  });

  it("uses the default lead and preserves arrival on the previous date", () => {
    expect(getAssignmentCallTime({ ...show, scheduledCallTime: null, scheduledStartTime: "2026-09-28T04:30:00.000Z" }))
      .toBe("2026-09-28T03:00:00.000Z");
  });

  it("keeps an explicit call when no show start is set and otherwise leaves it unknown", () => {
    expect(getAssignmentCallTime({ ...show, scheduledStartTime: null })).toBe(show.scheduledCallTime);
    expect(getAssignmentCallTime({ ...show, scheduledStartTime: null, scheduledCallTime: null })).toBeNull();
  });
});
