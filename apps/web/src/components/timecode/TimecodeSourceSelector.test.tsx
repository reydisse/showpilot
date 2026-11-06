import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TimecodeSourceSelector } from "./TimecodeSourceSelector";
import { MidiAccessFixture, MidiInputFixture } from "@/test/midi-fixture";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const fmt30 = { frameRate: 30, dropFrame: "ndf" } as const;
const fmt25 = { frameRate: 25, dropFrame: "ndf" } as const;
function props() {
  return { isMaster: false, connected: true, pending: null, running: false, format: fmt30, mtcSupported: false,
    onStartMtc: vi.fn(async () => {}), onSetFormat: vi.fn() };
}

it("requires an explicit reformat confirmation and leaves the format unchanged on Cancel", () => {
  const test = props();
  render(<TimecodeSourceSelector {...test} />);
  fireEvent.change(screen.getByLabelText("Frame Rate"), { target: { value: "25-ndf" } });
  expect(test.onSetFormat).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Frame Rate")).toHaveProperty("value", "30-ndf");
  expect(screen.getByRole("dialog").textContent).toContain("fired cues stay fired");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(test.onSetFormat).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Frame Rate"), { target: { value: "25-ndf" } });
  fireEvent.click(screen.getByRole("button", { name: "Reformat timeline" }));
  expect(test.onSetFormat).toHaveBeenCalledExactlyOnceWith(fmt25, fmt30, undefined);
});

it("blocks stale review and live-clock reformatting", () => {
  const test = props();
  const { rerender } = render(<TimecodeSourceSelector {...test} incomingFormat={{ id: "input-1", format: fmt25 }} />);
  fireEvent.click(screen.getByRole("button", { name: "Reformat timeline to 25 fps NDF" }));
  rerender(<TimecodeSourceSelector {...test} incomingFormat={{ id: "input-2", format: { frameRate: 24, dropFrame: "ndf" } }} />);
  expect(screen.getByRole("button", { name: "Reformat timeline" })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  rerender(<TimecodeSourceSelector {...test} running />);
  expect(screen.getByLabelText("Frame Rate")).toHaveProperty("disabled", true);
  expect(test.onSetFormat).not.toHaveBeenCalled();
});

it("confirms the exact stable input proposal without enabling automation", () => {
  const test = props();
  render(<TimecodeSourceSelector {...test} incomingFormat={{ id: "input-1", format: fmt25 }} />);
  expect(screen.getByRole("alert").textContent).toContain("five consecutive readings");
  fireEvent.click(screen.getByRole("button", { name: "Reformat timeline to 25 fps NDF" }));
  fireEvent.click(screen.getByRole("button", { name: "Reformat timeline" }));
  expect(test.onSetFormat).toHaveBeenCalledExactlyOnceWith(fmt25, fmt30, "input-1");
});

it("updates port discovery on hotplug and rescan while preserving the selected device", async () => {
  vi.useFakeTimers();
  const input = new MidiInputFixture("daw", "DAW MTC");
  const access = new MidiAccessFixture(input);
  const request = vi.fn().mockResolvedValue(access);
  vi.stubGlobal("navigator", { requestMIDIAccess: request });
  const test = props();
  const view = render(<TimecodeSourceSelector {...test} mtcSupported />);
  await act(async () => {});
  fireEvent.change(screen.getByLabelText("MIDI timecode input"), { target: { value: input.id } });
  act(() => access.disconnect(input));
  expect(screen.getByRole("option", { name: "DAW MTC (disconnected)" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Start MTC" })).toHaveProperty("disabled", true);
  const replacement = new MidiInputFixture("daw-replugged", input.name);
  act(() => { access.connect(replacement, false); vi.advanceTimersByTime(2_000); });
  expect(screen.getByLabelText("MIDI timecode input")).toHaveProperty("value", replacement.id);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start MTC" })));
  expect(test.onStartMtc).toHaveBeenCalledExactlyOnceWith(replacement.id, undefined);
  expect(request).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("shows permission failure with a working retry and cancels a late permission result on unmount", async () => {
  vi.useFakeTimers();
  const access = new MidiAccessFixture(new MidiInputFixture("daw"));
  const request = vi.fn().mockRejectedValueOnce(new Error("MIDI permission denied")).mockResolvedValue(access);
  vi.stubGlobal("navigator", { requestMIDIAccess: request });
  const view = render(<TimecodeSourceSelector {...props()} mtcSupported />);
  await act(async () => {});
  expect(screen.getByRole("alert").textContent).toContain("MIDI permission denied");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh" })));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("option", { name: "daw" })).toBeTruthy();
  view.unmount();
  let permit: ((value: MidiAccessFixture) => void) | undefined;
  request.mockImplementationOnce(() => new Promise(resolve => { permit = resolve; }));
  const pending = render(<TimecodeSourceSelector {...props()} mtcSupported />);
  pending.unmount();
  await act(async () => { permit?.(access); });
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps the age of the last MTC frame visible after the signal stalls", () => {
  vi.useFakeTimers(); vi.setSystemTime(10_000);
  const view = render(<TimecodeSourceSelector {...props()} source="mtc" signal={{ status: "waiting", lastFeedAt: null }} />);
  expect(screen.getByText("Waiting for an MTC frame")).toBeTruthy();
  view.rerender(<TimecodeSourceSelector {...props()} source="mtc" signal={{ status: "timecode-lost", lastFeedAt: 9_000 }} />);
  expect(screen.getByText("Last MTC frame received 1s ago")).toBeTruthy();
  act(() => vi.advanceTimersByTime(3_000));
  expect(screen.getByText("Last MTC frame received 4s ago")).toBeTruthy();
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("identifies lost LTC audio and keeps its last-frame age advancing", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-06T00:00:00Z"));
  render(<TimecodeSourceSelector {...props()} source="ltc-bridge" signal={{ status: "timecode-lost", lastFeedAt: Date.now() - 2000 }} />);
  expect(screen.getByRole("alert").textContent).toContain("LTC signal lost");
  expect(screen.getByText("Last LTC frame received 2s ago")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("ShowPilot Bridge");
  act(() => vi.advanceTimersByTime(3000));
  expect(screen.getByText("Last LTC frame received 5s ago")).toBeTruthy();
  expect(screen.queryByText(/Last MTC frame/)).toBeNull();
});
