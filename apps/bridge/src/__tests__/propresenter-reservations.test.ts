import { expect, it } from "vitest";
import { ProPresenterReservations } from "../propresenter-reservations";
it("consumes a reservation once and cannot renew it while it is live", () => {
  let now = 0;
  const r = new ProPresenterReservations(() => now);
  r.reserve("one", "target", "next");
  now = 4000;
  r.reserve("one", "target", "next");
  const guard = r.take("one", "target", "next");
  guard();
  expect(() => r.take("one", "target", "next")).toThrow();
  expect(() => r.reserve("one", "target", "next")).toThrow();
  now = 5000;
  expect(guard).toThrow("expired");
});
it("rejects delayed, missing, changed and disconnected reservations", () => {
  let now = 0;
  const r = new ProPresenterReservations(() => now);
  expect(() => r.take("missing", "target", "next")).toThrow();
  r.reserve("one", "target", "next");
  expect(() => r.take("one", "other", "next")).toThrow();
  expect(() => r.take("one", "target", "clear")).toThrow();
  now = 5001;
  expect(() => r.take("one", "target", "next")).toThrow();
  r.reserve("two", "target", "clear");
  const guard = r.take("two", "target", "clear");
  r.clear();
  expect(guard).toThrow();
});
it("bounds pending reservations and frees expired entries", () => {
  let now = 0;
  const r = new ProPresenterReservations(() => now);
  for (let i = 0; i < 256; i++) r.reserve(String(i), "target", "next");
  expect(() => r.reserve("overflow", "target", "next")).toThrow("Too many");
  now = 6000;
  r.reserve("after", "target", "next");
  r.take("after", "target", "next")();
});
