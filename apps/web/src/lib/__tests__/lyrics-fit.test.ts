import { describe, expect, it } from "vitest";
import { applyLyricSizeSetting, chooseLyricFit, KEEP_LINES_MIN_RATIO, largestFittingSize } from "@/lib/lyrics-fit";

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

describe("applyLyricSizeSetting", () => {
  // A slide limited by space: fits at 92px whatever the cap.
  const spaceLimited = (cap: number) => Math.min(cap, 92);

  it("leaves the default size unchanged", () => {
    expect(applyLyricSizeSetting(spaceLimited, 144, 1)).toBe(92);
  });

  it("shrinks visibly below 100% even when space is the limit", () => {
    expect(applyLyricSizeSetting(spaceLimited, 144, 0.75)).toBe(69);
  });

  it("raises the cap above 100% so short slides can grow", () => {
    const short = (cap: number) => Math.min(cap, 400);
    expect(applyLyricSizeSetting(short, 144, 1.5)).toBe(216);
  });
});
