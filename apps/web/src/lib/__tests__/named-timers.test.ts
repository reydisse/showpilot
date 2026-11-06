import { expect, it } from "vitest";
import { NamedTimerClock, namedTimerStartSchema, namedTimerStopSchema, parseNamedTimerDuration, formatNamedTimerRemaining } from "../named-timers";

it("parses familiar minutes and m:ss without accepting malformed or out-of-range durations", () => {
  expect(parseNamedTimerDuration("5")).toBe(300000);
  expect(parseNamedTimerDuration("5:00")).toBe(300000);
  expect(parseNamedTimerDuration(" 0:01 ")).toBe(1000);
  expect(parseNamedTimerDuration("1440:00")).toBe(86400000);
  for (const value of ["", "0", "5:60", "5:0", "1:00:00", "-5", "3.5", "1440:01", "5 minutes", "abc"]) expect(parseNamedTimerDuration(value), value).toBeNull();
  expect(formatNamedTimerRemaining(300000)).toBe("5:00");
  expect(formatNamedTimerRemaining(299001)).toBe("5:00");
  expect(formatNamedTimerRemaining(-1)).toBe("0:00");
});

it("runs against relay time despite client clock skew, freezes on disconnect and adopts reconnect state", () => {
  const clock = new NamedTimerClock();
  const sample = { serverTime: 900000, timers: [{ name: "Speaker", durationMs: 300000, endsAt: 1200000 }] };
  clock.observe(sample, true, 100);
  expect(clock.values(1100)[0].remainingMs).toBe(299000);
  clock.observe(sample, false, 2100);
  expect(clock.values(900000)[0].remainingMs).toBe(298000);
  clock.observe({ serverTime: 1100000, timers: sample.timers }, true, 900000);
  expect(clock.values(900000)[0].remainingMs).toBe(100000);
  expect(clock.values(1000000)[0].remainingMs).toBe(0);
  clock.observe({ serverTime: 1200000, timers: [] }, true, 1000000);
  expect(clock.values(1000000)).toEqual([]);
  clock.observe(null, false, 1000000);
  expect(clock.values(1000000)).toEqual([]);
});

it("validates named Start and Stop as different payload contracts", () => {
  expect(namedTimerStartSchema.parse({ name: "  Cafe\u0301 ", durationMs: 300000 })).toEqual({ name: "Café", durationMs: 300000 });
  expect(namedTimerStopSchema.parse({ name: "Speaker" })).toEqual({ name: "Speaker" });
  expect(namedTimerStopSchema.safeParse({ name: "Speaker", durationMs: 1000 }).success).toBe(false);
  expect(namedTimerStartSchema.safeParse({ name: "Speaker" }).success).toBe(false);
});

it("does not add time back when a delayed snapshot arrives, but accepts a deliberately restarted timer", () => {
  const clock = new NamedTimerClock();
  const timer = { name: "Speaker", durationMs: 300000, endsAt: 1200000 };
  clock.observe({ serverTime: 900000, timers: [timer] }, true, 100);
  expect(clock.values(2100)[0].remainingMs).toBe(298000);
  clock.observe({ serverTime: 900500, timers: [timer] }, true, 2100);
  expect(clock.values(2100)[0].remainingMs).toBe(298000);
  clock.observe({ serverTime: 903000, timers: [{ ...timer, endsAt: 1203000 }] }, true, 3100);
  expect(clock.values(3100)[0].remainingMs).toBe(300000);
});
