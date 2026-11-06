import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { NativeTimerState } from "@/types/rundown";
import { ACTIVE_RUNDOWN_CHANGED_EVENT, LiveRundownBar } from "../LiveRundownBar";

const mocks = vi.hoisted(() => ({ getTarget: vi.fn(), sync: vi.fn(), sendCommand: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children, className }: { children: ReactNode; className?: string }) => <a href="/fixture/rundown" className={className}>{children}</a> }));
vi.mock("@/lib/rundown", () => ({ getActiveRundownTarget: mocks.getTarget }));
vi.mock("@/hooks/useRundownSync", () => ({ useRundownSync: mocks.sync }));
const target = { serviceDate: "2026-11-06", showId: "show-1" };
function synced() {
  const timer: NativeTimerState = { playback: "pause", currentItemId: "item-1", elapsed: 60_000, startedAt: null, pausedAt: null, mode: "count-down", serverTime: Date.now() };
  return {
    items: [{ id: "item-1", title: "Welcome", duration: 300_000, status: "live", type: "segment" }],
    timer,
    serviceName: "Sunday Morning", connected: true, hydrated: true, lastError: null as string | null, sendCommand: mocks.sendCommand,
  };
}
const props = { orgId: "org-1", slug: "fixture", canControl: true };
let state = synced();
beforeEach(() => {
  mocks.getTarget.mockReset().mockResolvedValue(target);
  mocks.sendCommand.mockReset();
  state = synced();
  mocks.sync.mockReset().mockImplementation(() => state);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("LiveRundownBar", () => {
  it("keeps the active item and controls visible outside the rundown route", async () => {
    render(<LiveRundownBar {...props} />);
    expect(await screen.findByText("Welcome")).toBeTruthy();
    expect(screen.getByText("4:00")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume rundown" }));
    expect(mocks.sendCommand).toHaveBeenCalledExactlyOnceWith("timer-resume");
    for (const button of within(screen.getByRole("region", { name: "Live rundown" })).getAllByRole("button")) {
      expect(button.className).toContain("h-11"); expect(button.className).toContain("w-11");
      expect(button.className).toContain("focus-visible:ring-2");
    }
  });

  it("shows loading, empty and ended states without removing the bar", async () => {
    state.timer.playback = "stop"; state.timer.currentItemId = null;
    const view = render(<LiveRundownBar {...props} />);
    expect(screen.getByText("Checking live rundown…")).toBeTruthy();
    expect(await screen.findByText("No live rundown")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pause rundown" })).toBeNull();
    state = { ...state, timer: { ...state.timer, playback: "play", currentItemId: "item-1", startedAt: Date.now() } };
    view.rerender(<LiveRundownBar {...props} />);
    expect(screen.getByText("Rundown live")).toBeTruthy();
    state = { ...state, timer: { ...state.timer, playback: "stop", currentItemId: null } };
    view.rerender(<LiveRundownBar {...props} />);
    expect(screen.getByText("Show ended")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Live rundown" })).toBeTruthy();
  });

  it("labels and freezes the disconnected clock, blocks controls and resumes after hydration", async () => {
    state.timer = { ...state.timer, playback: "play", startedAt: Date.now() };
    const view = render(<LiveRundownBar {...props} />);
    await screen.findByText("Rundown live");
    vi.useFakeTimers();
    state = { ...state, connected: false };
    view.rerender(<LiveRundownBar {...props} />);
    const notice = screen.getByText("Reconnecting, showing last known state");
    expect(notice.getAttribute("aria-live")).toBe("polite");
    const held = document.querySelector("[data-live-rundown-timer]")?.textContent;
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(document.querySelector("[data-live-rundown-timer]")?.textContent).toBe(held);
    for (const button of screen.getAllByRole("button")) expect(button).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Next rundown item" }));
    expect(mocks.sendCommand).not.toHaveBeenCalled();
    state = { ...state, connected: true };
    view.rerender(<LiveRundownBar {...props} />);
    expect(screen.queryByText("Reconnecting, showing last known state")).toBeNull();
    expect(screen.getByRole("button", { name: "Pause rundown" })).toHaveProperty("disabled", false);
    expect(document.querySelector("[data-live-rundown-timer]")?.textContent).not.toBe(held);
  });

  it("does not rewind a newly received clock sample when the socket closes before the next tick", async () => {
    vi.useFakeTimers();
    state.timer = { ...state.timer, playback: "play", startedAt: Date.now() };
    const view = render(<LiveRundownBar {...props} />);
    await act(async () => {});
    vi.setSystemTime(Date.now() + 2000);
    state = { ...state, timer: { ...state.timer, serverTime: Date.now() } };
    view.rerender(<LiveRundownBar {...props} />);
    const current = document.querySelector("[data-live-rundown-timer]")?.textContent;
    state = { ...state, connected: false };
    view.rerender(<LiveRundownBar {...props} />);
    expect(document.querySelector("[data-live-rundown-timer]")?.textContent).toBe(current);
  });

  it("shows unavailable and a retry after target lookup fails", async () => {
    mocks.getTarget.mockRejectedValueOnce(new Error("offline"));
    render(<LiveRundownBar {...props} />);
    expect(await screen.findByText("Live rundown unavailable")).toBeTruthy();
    expect(screen.queryByText("No live rundown")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry live rundown" }));
    expect(await screen.findByText("Welcome")).toBeTruthy();
  });

  it("bounds a hung target request and ignores its late result after retry", async () => {
    vi.useFakeTimers();
    let resolveOld!: (value: typeof target) => void;
    mocks.getTarget.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    render(<LiveRundownBar {...props} />);
    await act(async () => { vi.advanceTimersByTime(10000); });
    expect(screen.getByText("Live rundown unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry live rundown" }));
    await act(async () => {});
    expect(screen.getByText("Welcome")).toBeTruthy();
    await act(async () => { resolveOld({ ...target, showId: "stale-show" }); });
    expect(mocks.sync.mock.calls.at(-1)).toEqual(["org-1", target.serviceDate, "show-1"]);
  });

  it("keeps the previous target but blocks control when a refresh fails", async () => {
    const view = render(<LiveRundownBar {...props} />);
    await screen.findByText("Welcome");
    mocks.getTarget.mockRejectedValueOnce(new Error("offline"));
    act(() => window.dispatchEvent(new Event(ACTIVE_RUNDOWN_CHANGED_EVENT)));
    await screen.findByText("Reconnecting, showing last known state");
    expect(screen.getByText("Welcome")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume rundown" })).toHaveProperty("disabled", true);
    view.rerender(<LiveRundownBar {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry live rundown" }));
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Resume rundown" })).toHaveProperty("disabled", false);
  });

  it("clears prior organization data synchronously while a new target is loading", async () => {
    const view = render(<LiveRundownBar {...props} />);
    await screen.findByText("Welcome");
    mocks.getTarget.mockImplementationOnce(() => new Promise(() => {}));
    view.rerender(<LiveRundownBar {...props} orgId="org-2" slug="second" />);
    expect(screen.queryByText("Welcome")).toBeNull();
    expect(screen.getByText("Checking live rundown…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resume rundown" })).toBeNull();
  });

  it("keeps final-item confirmation and blocks it if connectivity or playback changes", async () => {
    const view = render(<LiveRundownBar {...props} />);
    await screen.findByText("Welcome");
    fireEvent.click(screen.getByRole("button", { name: "Next rundown item" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(mocks.sendCommand).not.toHaveBeenCalled();
    state = { ...state, connected: false };
    view.rerender(<LiveRundownBar {...props} />);
    expect(screen.getByRole("button", { name: "End show" })).toHaveProperty("disabled", true);
    state = { ...state, connected: true, timer: { ...state.timer, playback: "stop" } };
    view.rerender(<LiveRundownBar {...props} />);
    expect(screen.getByRole("button", { name: "End show" })).toHaveProperty("disabled", true);
    expect(mocks.sendCommand).not.toHaveBeenCalled();
  });

  it("shows a missing current item and rejected commands without inventing live output", async () => {
    state = { ...state, items: [], lastError: "Rundown PIN is locked." };
    render(<LiveRundownBar {...props} />);
    expect(await screen.findByText("Live item unavailable")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("PIN is locked");
    expect(screen.queryByRole("button", { name: "Resume rundown" })).toBeNull();
  });

  it("keeps read-only viewers informed without transport controls", async () => {
    render(<LiveRundownBar {...props} canControl={false} />);
    await screen.findByText("Welcome");
    expect(screen.queryByRole("button", { name: "Resume rundown" })).toBeNull();
  });
});
