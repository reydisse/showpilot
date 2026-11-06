import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { TimecodeState } from "@/types/timecode";
import { TimecodeTransport } from "./TimecodeTransport";

afterEach(cleanup);
const state: TimecodeState = {
  showId: "show", timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
  display: "00:00:00:00", totalFrames: 0, format: { frameRate: 30, dropFrame: "ndf" },
  running: false, source: "internal-freerun", serverTime: 1, triggersEnabled: true, lyrics: null,
};
function setup() {
  const props = { state, connected: true, canControl: true, isMaster: false, pending: null as "starting" | "stopping" | null, onStart: vi.fn(), onStop: vi.fn(), onPause: vi.fn() };
  const view = render(<TimecodeTransport {...props} />);
  return { ...props, rerender: (changes: Partial<typeof props>) => view.rerender(<TimecodeTransport {...props} {...changes} />) };
}
it("starts directly and exposes stop, pause and resume in the same transport", () => {
  const props = setup();
  fireEvent.click(screen.getByRole("button", { name: "Start Internal Generator" }));
  expect(props.onStart).toHaveBeenCalledExactlyOnceWith();
  expect(screen.queryByRole("dialog")).toBeNull();
  props.rerender({ isMaster: true, state: { ...state, running: true } });
  fireEvent.click(screen.getByRole("button", { name: "Pause clock" }));
  expect(props.onPause).toHaveBeenCalledOnce();
  props.rerender({ isMaster: true, state: { ...state, running: false, signal: { status: "paused", lastFeedAt: 1 } } });
  fireEvent.click(screen.getByRole("button", { name: "Resume clock" }));
  expect(props.onStart).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Stop Generator" }));
  expect(props.onStop).toHaveBeenCalledOnce();
});
it.each(["offline", "permission", "pending"])("disables all transport mutations when %s", reason => {
  const props = setup();
  props.rerender({ connected: reason !== "offline", canControl: reason !== "permission", pending: reason === "pending" ? "starting" : null });
  for (const button of screen.getAllByRole("button")) expect(button).toHaveProperty("disabled", true);
  expect(props.onStart).not.toHaveBeenCalled();
});
it("keeps the custom draft after cancel and submits a reviewed start position", () => {
  const props = setup();
  fireEvent.click(screen.getByRole("button", { name: "Choose start position" }));
  fireEvent.change(screen.getByLabelText("Internal start position"), { target: { value: "00:01:00:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Start at 00:01:00:00" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByLabelText("Internal start position")).toHaveProperty("value", "00:01:00:00");
  expect(props.onStart).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Start at 00:01:00:00" }));
  fireEvent.click(screen.getByRole("button", { name: "Start from position" }));
  expect(props.onStart).toHaveBeenCalledExactlyOnceWith({ timecode: { hours: 0, minutes: 1, seconds: 0, frames: 0 }, expectedShowId: "show", expectedFrame: 0, expectedFormat: state.format, confirmed: true });
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("blocks a reviewed start if control is lost while the dialog is open", () => {
  const props = setup();
  fireEvent.click(screen.getByRole("button", { name: "Choose start position" }));
  fireEvent.click(screen.getByRole("button", { name: "Start at 00:00:00:00" }));
  props.rerender({ canControl: false });
  const confirm = screen.getByRole("button", { name: "Start from position" });
  expect(confirm).toHaveProperty("disabled", true);
  fireEvent.click(confirm);
  expect(props.onStart).not.toHaveBeenCalled();
});
