import { describe, expect, it } from "vitest";
import {
  getCrewScheduleResponseWindow,
  isCrewScheduleResponseOpen,
} from "@/lib/crew-schedule-response";

const MINUTE = 60_000;
const START = new Date("2026-08-23T10:00:00.000Z").getTime();

describe("getCrewScheduleResponseWindow", () => {
  it("stays open immediately before the planned service end", () => {
    const window = getCrewScheduleResponseWindow(
      {
        serviceDate: "2026-08-23",
        scheduledStartTime: new Date(START).toISOString(),
        plannedDurationMs: 75 * MINUTE,
      },
      START + 75 * MINUTE - 1,
    );

    expect(window).toEqual({
      status: "open",
      closesAt: "2026-08-23T11:15:00.000Z",
    });
  });

  it("closes exactly at the planned service end", () => {
    expect(
      getCrewScheduleResponseWindow(
        {
          serviceDate: "2026-08-23",
          scheduledStartTime: new Date(START).toISOString(),
          plannedDurationMs: 75 * MINUTE,
        },
        START + 75 * MINUTE,
      ),
    ).toEqual({
      status: "closed",
      closedAt: "2026-08-23T11:15:00.000Z",
    });
  });

  it("prefers the planned rundown length over the configured window", () => {
    expect(
      getCrewScheduleResponseWindow(
        {
          serviceDate: "2026-08-23",
          scheduledStartTime: new Date(START).toISOString(),
          plannedDurationMs: 120 * MINUTE,
          serviceWindowMinutes: 30,
        },
        START + 60 * MINUTE,
      ),
    ).toEqual({
      status: "open",
      closesAt: "2026-08-23T12:00:00.000Z",
    });
  });

  it("uses the configured service window when the rundown is empty", () => {
    expect(
      getCrewScheduleResponseWindow(
        {
          serviceDate: "2026-08-23",
          scheduledStartTime: new Date(START).toISOString(),
          plannedDurationMs: 0,
          serviceWindowMinutes: 45,
        },
        START,
      ),
    ).toEqual({
      status: "open",
      closesAt: "2026-08-23T10:45:00.000Z",
    });
  });

  it("closes an untimed service at the next local midnight", () => {
    expect(
      getCrewScheduleResponseWindow(
        {
          serviceDate: "2026-08-23",
          scheduledStartTime: null,
          timeZone: "Africa/Accra",
        },
        new Date("2026-08-23T23:59:59.999Z").getTime(),
      ),
    ).toEqual({
      status: "open",
      closesAt: "2026-08-24T00:00:00.000Z",
    });
  });

  it("uses the organization timezone for an untimed service", () => {
    expect(
      getCrewScheduleResponseWindow(
        {
          serviceDate: "2026-08-23",
          scheduledStartTime: null,
          timeZone: "America/New_York",
        },
        new Date("2026-08-24T03:59:59.999Z").getTime(),
      ),
    ).toEqual({
      status: "open",
      closesAt: "2026-08-24T04:00:00.000Z",
    });
  });

  it("fails closed when the service date cannot define a deadline", () => {
    expect(
      getCrewScheduleResponseWindow(
        { serviceDate: "not-a-date", scheduledStartTime: null },
        START,
      ),
    ).toEqual({ status: "closed", closedAt: null });
  });
});

describe("isCrewScheduleResponseOpen", () => {
  const window = {
    status: "open" as const,
    closesAt: "2026-08-23T11:15:00.000Z",
  };

  it("rechecks an open server response against the current clock", () => {
    expect(isCrewScheduleResponseOpen(window, START)).toBe(true);
    expect(isCrewScheduleResponseOpen(window, START + 75 * MINUTE)).toBe(false);
  });
});
