import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TimecodeSourceSelector } from "./TimecodeSourceSelector";

afterEach(cleanup);
const fmt30 = { frameRate: 30, dropFrame: "ndf" } as const;
const fmt25 = { frameRate: 25, dropFrame: "ndf" } as const;
function props() {
  return { isMaster: false, connected: true, pending: null, running: false, format: fmt30, mtcSupported: false,
    onStartFreerun: vi.fn(), onStopGenerator: vi.fn(), onStartMtc: vi.fn(async () => {}), onSetFormat: vi.fn() };
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
