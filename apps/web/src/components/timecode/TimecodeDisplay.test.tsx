import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TimecodeDisplay, TimecodeText } from "./TimecodeDisplay";
import { framesToTimecode, timecodeToString } from "@/lib/timecode";
import type { TimecodeState } from "@/types/timecode";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function sample(frame: number, at: number): TimecodeState {
  const format = { frameRate: 30, dropFrame: "ndf" } as const;
  return {
    showId: "show",
    display: timecodeToString(framesToTimecode(frame, format), false),
    totalFrames: frame,
    timecode: framesToTimecode(frame, format),
    format,
    running: true,
    source: "internal-freerun",
    serverTime: at,
    signal: { status: "live", lastFeedAt: at },
    lyrics: null,
    triggersEnabled: true,
  };
}
const tree = (state: TimecodeState, connected = true) => (
  <>
    <TimecodeDisplay state={state} connectionStatus={connected ? "connected" : "disconnected"} size="large" />
    <TimecodeDisplay state={state} connectionStatus={connected ? "connected" : "disconnected"} size="compact" />
    <TimecodeText state={state} connected={connected} />
  </>
);

it("does not report a disconnected clock before its first confirmed state", () => {
  render(<TimecodeDisplay state={null} connectionStatus="connecting" size="large" />);
  expect(screen.getByRole("status", { name: "Timecode connecting" })).toBeTruthy();
  expect(screen.queryByText("Disconnected")).toBeNull();
});

it("smooths all clock sizes while leaving the relay state untouched, then holds when updates stop", () => {
  const view = render(tree(sample(300, 10_000)));
  act(() => vi.advanceTimersByTime(100));
  const next = Object.freeze(sample(303, 10_100));
  view.rerender(tree(next));
  expect(screen.getAllByText("00:00:10:00")).toHaveLength(3);
  act(() => vi.advanceTimersByTime(50));
  expect(screen.getAllByText("00:00:10:01")).toHaveLength(3);
  expect(next.totalFrames).toBe(303);
  act(() => vi.advanceTimersByTime(470));
  expect(screen.getAllByText("00:00:10:03")).toHaveLength(3);
  expect(
    screen.getAllByRole("status", { name: "Timecode signal lost" }),
  ).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
  act(() => vi.advanceTimersByTime(10_000));
  expect(screen.getAllByText("00:00:10:03")).toHaveLength(3);
});

it("snaps to the actual relay frame on disconnect and cancels rendering timers", () => {
  const view = render(tree(sample(300, 10_000)));
  act(() => vi.advanceTimersByTime(100));
  view.rerender(tree(sample(303, 10_100)));
  view.rerender(tree(sample(303, 10_100), false));
  expect(screen.getAllByText("00:00:10:03")).toHaveLength(3);
  expect(
    screen.getAllByRole("status", { name: "Timecode disconnected" }),
  ).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
