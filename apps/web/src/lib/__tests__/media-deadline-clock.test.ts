import { expect, it, vi } from "vitest";
import { MediaDeadlineClock } from "../media-playback";

it("refuses execution until a server round trip establishes a deadline bound", () => {
  expect(new MediaDeadlineClock().remaining(100_000, 50)).toBe(0);
});

it("accounts conservatively for round-trip latency and elapsed monotonic time", () => {
  const clock = new MediaDeadlineClock();
  clock.sample(100_000, 100, 400);
  expect(clock.remaining(101_000, 400)).toBe(700);
  expect(clock.remaining(101_000, 1000)).toBe(100);
  expect(clock.remaining(101_000, 1200)).toBe(-100);
});

it("does not extend a cue when the output computer's wall clock jumps", () => {
  const clock = new MediaDeadlineClock();
  clock.sample(100_000, 100, 200);
  const now = vi.spyOn(Date, "now").mockReturnValue(-5_000_000);
  try {
    expect(clock.remaining(101_000, 500)).toBe(600);
    now.mockReturnValue(50_000_000);
    expect(clock.remaining(101_000, 500)).toBe(600);
    clock.sample(100_800, 800, 850);
    expect(clock.remaining(101_000, 900)).toBe(100);
  } finally {
    now.mockRestore();
  }
});
