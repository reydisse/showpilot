import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationTimeline } from "./AutomationTimeline";
import type { AutomationEvent, TimecodeState } from "@/types/timecode";

afterEach(cleanup);

const state: TimecodeState = {
  timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 }, display: "00:00:01:00",
  source: "internal-freerun", format: { frameRate: 30, dropFrame: "ndf" },
  running: true, triggersEnabled: true, serverTime: 1, totalFrames: 30, lyrics: null,
};
function cue(id: string, changes: Partial<AutomationEvent> = {}): AutomationEvent {
  return {
    id, label: id, action: "lower-third-show", enabled: true, fired: false,
    triggerTimecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, triggerFrame: 0,
    toleranceFrames: 5, payload: {}, ...changes,
  };
}
function setup(events: AutomationEvent[], connected = true) {
  const props = {
    events, state, connected, onRemoveEvent: vi.fn(), onResetEvents: vi.fn(),
    onRetryEvent: vi.fn(), onSetEventEnabled: vi.fn(),
  };
  render(<AutomationTimeline {...props} />);
  return props;
}

describe("automation safety controls", () => {
  it("requires confirmation for reset and deletion", () => {
    const props = setup([cue("Welcome")]);
    fireEvent.click(screen.getByRole("button", { name: "Reset All" }));
    expect(props.onResetEvents).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(props.onResetEvents).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reset All" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Reset all" }));
    expect(props.onResetEvents).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Delete Welcome automation" }));
    expect(props.onRemoveEvent).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete cue" }));
    expect(props.onRemoveEvent).toHaveBeenCalledWith("Welcome");
  });

  it("lists failed and missed cues while keeping disabled cues distinct", () => {
    const props = setup([
      cue("Failed graphic", { executionStatus: "failed", executionError: "Rejected with 503" }),
      cue("Missed graphic"), cue("Disabled graphic", { enabled: false }),
    ]);
    const attention = screen.getByRole("region", { name: "Missed or failed cues" });
    expect(within(attention).getAllByRole("listitem")).toHaveLength(2);
    expect(within(attention).queryByText(/Disabled graphic/)).toBeNull();
    fireEvent.click(within(attention).getByRole("button", { name: "Retry Failed graphic" }));
    expect(props.onRetryEvent).toHaveBeenCalledWith("Failed graphic");
    expect(props.onResetEvents).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Enable Disabled graphic" }));
    expect(props.onSetEventEnabled).toHaveBeenCalledWith("Disabled graphic", true);
  });

  it("requires confirmation before repeating an acknowledged action", () => {
    const props = setup([cue("Next item", { fired: true, executionStatus: "acknowledged" })]);
    fireEvent.click(screen.getByRole("button", { name: "Re-fire" }));
    expect(props.onRetryEvent).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Fire again" }));
    expect(props.onRetryEvent).toHaveBeenCalledWith("Next item");
  });

  it("disables mutation controls while disconnected", () => {
    const props = setup([cue("Failed cue", { executionStatus: "failed" })], false);
    fireEvent.click(screen.getByRole("button", { name: "Retry Failed cue" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset All" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Failed cue automation" }));
    expect(props.onRetryEvent).not.toHaveBeenCalled();
    expect(props.onResetEvents).not.toHaveBeenCalled();
    expect(props.onRemoveEvent).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
