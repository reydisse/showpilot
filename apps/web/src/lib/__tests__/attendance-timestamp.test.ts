import { expect, it } from "vitest";
import { attendanceTimestamp } from "../attendance-timestamp";

it.each([
  [1794744000123, "2026-11-15T12:00:00.123Z"],
  ["1794744000123", "2026-11-15T12:00:00.123Z"],
  ["2026-11-15 12:00:00", "2026-11-15T12:00:00.000Z"],
  ["2026-11-15T07:00:00-05:00", "2026-11-15T12:00:00.000Z"],
  [new Date("2026-11-15T12:00:00Z"), "2026-11-15T12:00:00.000Z"],
  [0, "1970-01-01T00:00:00.000Z"],
  [null, null], ["", null], ["invalid", null], [Number.NaN, null], [1e30, null],
])("normalizes stored timestamp %s without throwing", (value, expected) => {
  expect(attendanceTimestamp(value)).toBe(expected);
});
