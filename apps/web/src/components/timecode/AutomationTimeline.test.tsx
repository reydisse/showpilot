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
    onEditEvent: vi.fn(), onRetryEvent: vi.fn(), onSetEventEnabled: vi.fn(), onFireEvent: vi.fn(), onFireNext: vi.fn(), onSkipEvent: vi.fn(), onRearmEvent: vi.fn(),
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
    fireEvent.click(within(attention).getByRole("button", { name: "Retry Failed graphic from attention list" }));
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
    expect(props.onRetryEvent).toHaveBeenCalledWith("Next item", { fired: true, skipped: false, executionId: null });
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

  it("rejects a stale re-fire confirmation when the execution changes", () => {
    const used = cue("Crew cue", { fired: true, executionStatus: "acknowledged", executionId: "first" });
    const props = setup([used]);
    fireEvent.click(screen.getByRole("button", { name: "Re-fire" }));
    props.rerender({ events: [{ ...used, executionId: "second" }] });
    expect(screen.getByText("The cue changed. Close this dialog and review its latest status.")).toBeTruthy();
    const confirm = within(screen.getByRole("dialog")).getByRole("button", { name: "Fire again" });
    expect(confirm).toHaveProperty("disabled", true);
    fireEvent.click(confirm);
    expect(props.onRetryEvent).not.toHaveBeenCalled();
  });
});


it("orders simultaneous controls like the scheduler, with the same Next cue", () => {
  const events = [
    cue("Output", { triggerFrame: 60 }),
    cue("Pause", { triggerFrame: 60, action: "triggers-disable" }),
    cue("Resume", { triggerFrame: 60, action: "triggers-enable" }),
  ];
  setup(events);
  expect(screen.getByRole("button", { name: "Fire next" }).getAttribute("title")).toBe("Fire Resume now");
  expect(screen.getAllByRole("button", { name: /^Fire (Resume|Pause|Output)$/ }).map(button => button.getAttribute("aria-label")))
    .toEqual(["Fire Resume", "Fire Pause", "Fire Output"]);
  expect(events.map(event => event.id)).toEqual(["Output", "Pause", "Resume"]);
});


it("offers a reachable Edit action and blocks it during dispatch or disconnection", () => {
  const saved = cue("Saved", { fired: true, executionId: "receipt" });
  const props = setup([saved]);
  const edit = screen.getByRole("button", { name: "Edit Saved" });
  expect(edit.className).toContain("min-h-11");
  expect(edit.className).toContain("min-w-11");
  fireEvent.click(edit);
  expect(props.onEditEvent).toHaveBeenCalledExactlyOnceWith(saved);
  props.rerender({ events: [{ ...saved, executionStatus: "dispatching" }] });
  expect(edit).toHaveProperty("disabled", true);
  props.rerender({ connected: false });
  expect(edit).toHaveProperty("disabled", true);
  expect(props.onFireEvent).not.toHaveBeenCalled();
});


it("renders a nominal-time copy while previewing the compensated next cue on a held clock", () => {
  const events = [
    cue("Later nominal", { triggerFrame: 90, dispatchFrame: 45 }),
    cue("Earlier nominal", { triggerFrame: 60 }),
    cue("Past", { triggerFrame: 1 }),
  ];
  const props = setup(events, true, { ...state, running: false });
  expect([...document.querySelectorAll("[data-automation-event]")].map(row => row.getAttribute("data-automation-event")))
    .toEqual(["Past", "Earlier nominal", "Later nominal"]);
  expect(events.map(event => event.id)).toEqual(["Later nominal", "Earlier nominal", "Past"]);
  expect(document.querySelector("[data-next-cue]")?.textContent).toBe("Next: Later nominal · in 0.5s · Clock held");
  props.rerender({ connected: false });
  expect(document.querySelector("[data-next-cue]")?.textContent).toContain("Last known next:");
  expect(screen.getByRole("button", { name: "Fire next" })).toHaveProperty("disabled", true);
});

it("distinguishes overdue within tolerance, missed, upcoming and failed rows", () => {
  const props = setup([
    cue("Late", { triggerFrame: 28 }), cue("Missed", { triggerFrame: 24 }),
    cue("Upcoming", { triggerFrame: 31 }), cue("Rejected", { triggerFrame: 40, executionStatus: "failed" }),
  ]);
  const row = (id: string) => document.querySelector(`[data-automation-event="${id}"]`)!;
  expect(row("Late").textContent).toContain("Overdue · within tolerance");
  expect(row("Missed").textContent).toContain("Missed");
  expect(row("Upcoming").textContent).toContain("Next");
  expect(row("Rejected").textContent).toContain("FAILED");
  expect(screen.getByRole("region", { name: "Missed or failed cues" }).textContent).not.toContain("Late");
  fireEvent.click(screen.getByRole("button", { name: "Retry Rejected" }));
  expect(props.onRetryEvent).toHaveBeenCalledExactlyOnceWith("Rejected");
});

it("shows saved device names, safe action details, webhook origin and tolerance", () => {
  const props = setup([]);
  render(<AutomationTimeline {...props} events={[
    cue("Camera", { action: "device-action", targetDeviceId: "switcher", targetActionId: "set_program_input", payload: { params: { input: 3 } }, toleranceFrames: 12 }),
    cue("Webhook", { action: "custom-webhook", payload: { url: "https://operator:secret@example.com/private/path?token=secret" } }),
  ]} deviceNames={{ status: "ready", value: [{ id: "switcher", label: "Main ATEM", enabled: false }] }} />);
  expect(screen.getByText("Device: Main ATEM (disabled)")).toBeTruthy();
  expect(screen.getByText("set program input · input: 3")).toBeTruthy();
  expect(screen.getByText("Tolerance ±12 frames")).toBeTruthy();
  expect(screen.getByText("POST https://example.com")).toBeTruthy();
  expect(document.body.textContent).not.toContain("secret");
});
