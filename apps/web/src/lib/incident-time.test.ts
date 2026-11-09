import { expect, it } from "vitest";
import { parseIncidentTimestamp } from "./incident-time";

it.each([
  ["2026-11-09 13:51:56", "2026-11-09T13:51:56.000Z"],
  ["2026-11-09 13:51:56.123", "2026-11-09T13:51:56.123Z"],
  ["2026-11-09T08:51:56-05:00", "2026-11-09T13:51:56.000Z"],
  ["2026-11-09T13:51:56Z", "2026-11-09T13:51:56.000Z"],
])("interprets %s as the same instant in server and viewer timezones", (value, expected) => {
  expect(parseIncidentTimestamp(value).toISOString()).toBe(expected);
});
