import { describe, expect, it } from "vitest";
import { chooseLyricFit, KEEP_LINES_MIN_RATIO, largestFittingSize } from "@/lib/lyrics-fit";

describe("largestFittingSize", () => {
  it("finds the boundary within a quarter pixel", () => {
    const size = largestFittingSize((value) => value <= 97.3, 144);
    expect(size).toBeLessThanOrEqual(97.3);
    expect(size).toBeGreaterThan(97.3 - 0.25);
  });

  it("returns the floor when nothing fits and the cap when everything fits", () => {
    expect(largestFittingSize(() => false, 144)).toBe(1);
    expect(largestFittingSize(() => true, 144)).toBeGreaterThan(143.75);
  });
});

describe("chooseLyricFit", () => {
  it("keeps authored lines intact when that costs only a little size", () => {
    // 1080p verse: wrapping reached the 144px cap; one line per row fits at ~108px.
    expect(chooseLyricFit(108, 144)).toEqual({ wrap: false, size: 108 });
  });

  it("wraps when unwrapped text would become too small to read", () => {
    // Long chorus on a portrait phone: one line per row would be tiny.
    expect(chooseLyricFit(14, 31)).toEqual({ wrap: true, size: 31 });
  });

  it("switches exactly at the configured ratio", () => {
    expect(chooseLyricFit(100 * KEEP_LINES_MIN_RATIO, 100).wrap).toBe(false);
    expect(chooseLyricFit(100 * KEEP_LINES_MIN_RATIO - 0.01, 100).wrap).toBe(true);
  });
});
