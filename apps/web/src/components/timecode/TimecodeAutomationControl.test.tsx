import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TimecodeAutomationControl } from "./TimecodeAutomationControl";
import type { TimecodeState } from "@/types/timecode";

afterEach(cleanup);
const state: TimecodeState = {
  source: "mtc", running: true, totalFrames: 300, display: "00:00:10:00", timecode: { hours: 0, minutes: 0, seconds: 10, frames: 0 },
  format: { frameRate: 30, dropFrame: "ndf" }, serverTime: 1, lyrics: null, triggersEnabled: false,
  automationHold: { id: "jump-1", reason: "timecode-jump", from: "00:00:01:00", to: "00:00:10:00", detectedAt: 1 },
};

it("requires explicit confirmation for a jump and sends the reviewed hold identifier", () => {
  const onSetEnabled = vi.fn();
  render(<TimecodeAutomationControl state={state} connected canControl onSetEnabled={onSetEnabled} />);
  expect(screen.getByRole("alert").textContent).toContain("00:00:01:00 to 00:00:10:00");
  fireEvent.click(screen.getByRole("button", { name: "Review and resume automation" }));
  expect(onSetEnabled).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onSetEnabled).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Review and resume automation" }));
  fireEvent.click(screen.getByRole("button", { name: "Resume automation" }));
  expect(onSetEnabled).toHaveBeenCalledExactlyOnceWith(true, "jump-1");
});

it("blocks a stale dialog when another jump arrives while the operator reviews it", () => {
  const onSetEnabled = vi.fn();
  const { rerender } = render(<TimecodeAutomationControl state={state} connected canControl onSetEnabled={onSetEnabled} />);
  fireEvent.click(screen.getByRole("button", { name: "Review and resume automation" }));
  rerender(<TimecodeAutomationControl state={{ ...state, automationHold: { ...state.automationHold!, id: "jump-2", to: "00:00:20:00" } }} connected canControl onSetEnabled={onSetEnabled} />);
  expect(screen.getByText(/Timecode changed again/)).toBeTruthy();
  const confirm = screen.getByRole("button", { name: "Resume automation" });
  expect(confirm).toHaveProperty("disabled", true);
  fireEvent.click(confirm);
  expect(onSetEnabled).not.toHaveBeenCalled();
});

it("keeps the emergency disable immediate and blocks writes for a viewing operator", () => {
  const onSetEnabled = vi.fn();
  const { rerender } = render(<TimecodeAutomationControl state={{ ...state, triggersEnabled: true, automationHold: null }} connected canControl onSetEnabled={onSetEnabled} />);
  fireEvent.click(screen.getByRole("button", { name: "Disable automation" }));
  expect(onSetEnabled).toHaveBeenCalledExactlyOnceWith(false);
  rerender(<TimecodeAutomationControl state={state} connected canControl={false} onSetEnabled={onSetEnabled} />);
  expect(screen.getByRole("button", { name: "Review and resume automation" })).toHaveProperty("disabled", true);
});
