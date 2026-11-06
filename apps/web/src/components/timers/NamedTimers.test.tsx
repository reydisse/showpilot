import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NamedTimers, namedTimerDisplayUrl } from "./NamedTimers";

afterEach(() => { cleanup(); if (vi.isFakeTimers()) expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); });
const sample = { serverTime: 100000, timers: [{ name: "Speaker", durationMs: 300000, endsAt: 400000 }] };
it("counts down while mounted, labels disconnected output, and clears a stopped timer", () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
  const { rerender, unmount } = render(<NamedTimers sample={sample} connected mode="single" selectedName="Speaker" />);
  expect(screen.getByText("5:00")).toBeTruthy();
  act(() => vi.advanceTimersByTime(2000)); expect(screen.getByText("4:58")).toBeTruthy();
  rerender(<NamedTimers sample={sample} connected={false} mode="single" selectedName="Speaker" />);
  expect(screen.getByRole("status").textContent).toContain("timer unconfirmed");
  act(() => vi.advanceTimersByTime(2000)); expect(screen.getByText("4:58")).toBeTruthy();
  rerender(<NamedTimers sample={{ serverTime: 104000, timers: [] }} connected mode="single" selectedName="Speaker" />);
  expect(screen.getByRole("status").textContent).toBe("Stopped");
  expect(screen.queryByText("4:58")).toBeNull();
  unmount();
});
it("pins a display link to its show and safely encodes names", () => {
  render(<NamedTimers sample={sample} connected outputTarget={{ orgSlug: "team", showId: "show-two" }} />);
  expect(screen.getByRole("link", { name: "Open Speaker timer display" }).getAttribute("href")).toBe("/timer/team?namedTimer=Speaker&showId=show-two");
  expect(namedTimerDisplayUrl("some team", "show/2", "Speaker & café")).toBe("/timer/some%20team?namedTimer=Speaker+%26+caf%C3%A9&showId=show%2F2");
});
it("keeps independent named timers visible and does not substitute another timer for a stopped selection", () => {
  const multiple = { ...sample, timers: [...sample.timers, { name: "Break", durationMs: 60000, endsAt: 100000 }] };
  const { rerender } = render(<NamedTimers sample={multiple} connected />);
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
  expect(screen.getByText("Complete")).toBeTruthy();
  rerender(<NamedTimers sample={multiple} connected mode="single" selectedName="Other timer" />);
  expect(screen.getByRole("heading").textContent).toBe("Other timer");
  expect(screen.getByRole("status").textContent).toBe("Stopped");
  expect(screen.queryByText("5:00")).toBeNull();
});
