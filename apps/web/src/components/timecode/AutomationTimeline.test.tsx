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
function setup(events: AutomationEvent[], connected = true, clock = state) {
  const props = {
    events, state: clock, connected, onRemoveEvent: vi.fn(), onResetEvents: vi.fn(),
    onRetryEvent: vi.fn(), onSetEventEnabled: vi.fn(), onFireEvent: vi.fn(), onFireNext: vi.fn(), onSkipEvent: vi.fn(), onRearmEvent: vi.fn(),
  };
  const view = render(<AutomationTimeline {...props} />);
  return { ...props, rerender: (changes: Partial<typeof props>) => view.rerender(<AutomationTimeline {...props} {...changes} />) };
}

describe("automation safety controls", () => {
  it("shows the nominal time and compensation while choosing Next by dispatch time", () => {
    setup([
      cue("Nominal first", { triggerFrame: 40 }),
      cue("Send first", { triggerTimecode: { hours: 0, minutes: 0, seconds: 2, frames: 0 }, triggerFrame: 60, dispatchFrame: 36, leadMs: 600, deviceLatencyMs: 200 }),
    ]);
    expect(screen.getByRole("button", { name: "Fire next" }).getAttribute("title")).toBe("Fire Send first now");
    expect(screen.getByText("00:00:02:00")).toBeTruthy();
    expect(screen.getByText("Send 00:00:01:06")).toBeTruthy();
    expect(screen.getByText(/Lead 600 ms \+ device 200 ms/)).toBeTruthy();
  });

  it("offers the earliest ready cue and keeps Fire, Skip and Re-arm separate", () => {
    const props = setup([
      cue("Past"), cue("Disabled", { triggerFrame: 40, enabled: false }),
      cue("Skipped", { triggerFrame: 50, skipped: true }),
      cue("Failed", { triggerFrame: 60, executionStatus: "failed" }),
      cue("Pending", { triggerFrame: 70, executionStatus: "dispatching" }),
      cue("First ready", { triggerFrame: 80 }), cue("Later", { triggerFrame: 90 }),
    ]);
    expect(screen.getByRole("button", { name: "Fire next" }).getAttribute("title")).toBe("Fire First ready now");
    fireEvent.click(screen.getByRole("button", { name: "Fire next" }));
    expect(props.onFireNext).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Fire Later" }));
    expect(props.onFireEvent).toHaveBeenCalledWith("Later");
    fireEvent.click(screen.getByRole("button", { name: "Skip First ready" }));
    expect(props.onSkipEvent).toHaveBeenCalledWith("First ready");
    expect(props.onRearmEvent).not.toHaveBeenCalled();
    expect(props.onRetryEvent).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Fire Skipped" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Fire Failed" })).toBeNull();
  });

  it("confirms a single Re-arm without firing and preserves the reviewed attempt", () => {
    const props = setup([cue("Used", { fired: true, executionId: "attempt-one", executionStatus: "acknowledged" })]);
    fireEvent.click(screen.getByRole("button", { name: "Re-arm Used" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(props.onRearmEvent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Re-arm Used" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Re-arm cue" }));
    expect(props.onRearmEvent).toHaveBeenCalledExactlyOnceWith("Used", { executionId: "attempt-one", fired: true, skipped: false });
    expect(props.onFireEvent).not.toHaveBeenCalled();
    expect(props.onRetryEvent).not.toHaveBeenCalled();
    expect(props.onResetEvents).not.toHaveBeenCalled();
  });

  it("blocks a stale Re-arm confirmation when another attempt finishes during review", () => {
    const original = cue("Used", { fired: true, executionId: "attempt-one" });
    const props = setup([original]);
    fireEvent.click(screen.getByRole("button", { name: "Re-arm Used" }));
    props.rerender({ events: [{ ...original, executionId: "attempt-two" }] });
    expect(screen.getByText(/The cue changed/)).toBeTruthy();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Re-arm cue" }));
    expect(props.onRearmEvent).not.toHaveBeenCalled();
  });

  it.each(["offline", "automation off", "disabled", "dispatching"])("blocks manual firing when %s", (reason) => {
    const props = setup([cue("Ready", { triggerFrame: 80, enabled: reason !== "disabled", executionStatus: reason === "dispatching" ? "dispatching" : "scheduled" })], reason !== "offline", { ...state, triggersEnabled: reason !== "automation off" });
    fireEvent.click(screen.getByRole("button", { name: "Fire next" }));
    fireEvent.click(screen.getByRole("button", { name: "Fire Ready" }));
    expect(props.onFireNext).not.toHaveBeenCalled();
    expect(props.onFireEvent).not.toHaveBeenCalled();
  });

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
