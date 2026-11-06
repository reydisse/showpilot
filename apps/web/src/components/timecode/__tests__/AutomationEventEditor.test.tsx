import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AutomationEventEditor } from "../AutomationEventEditor";
import type { NewAutomationEvent } from "@/hooks/useTimecode";

afterEach(cleanup);
const format = { frameRate: 30, dropFrame: "ndf" } as const;

it("keeps the draft through a failed save and reuses its id until relay confirmation", async () => {
  let confirm: () => void = () => {};
  let fail: (error: Error) => void = () => {};
  const save = vi.fn((_event: NewAutomationEvent) => new Promise<void>((resolve, reject) => { confirm = resolve; fail = reject; }));
  render(<AutomationEventEditor connected format={format} onAdd={save} />);
  const timecode = screen.getByPlaceholderText("00:05:00:00");
  fireEvent.change(timecode, { target: { value: "00:00:10:00" } });
  fireEvent.change(screen.getByLabelText("Tolerance (frames)"), { target: { value: "13" } });
  fireEvent.click(screen.getByRole("button", { name: "Add Event" }));
  expect(timecode).toHaveProperty("value", "00:00:10:00");
  expect(screen.getByLabelText("Tolerance (frames)")).toHaveProperty("value", "13");
  expect(screen.getByRole("button", { name: "Waiting for relay…" }).closest("fieldset")).toHaveProperty("disabled", true);
  const id = save.mock.calls[0][0].id;
  await act(async () => fail(new Error("Disconnected; draft kept")));
  expect(timecode).toHaveProperty("value", "00:00:10:00");
  expect(screen.getByLabelText("Tolerance (frames)")).toHaveProperty("value", "13");
  fireEvent.click(screen.getByRole("button", { name: "Add Event" }));
  expect(save.mock.calls[1][0].id).toBe(id);
  await act(async () => confirm());
  expect(timecode).toHaveProperty("value", "");
});

it("does not send or clear a draft while offline", () => {
  const save = vi.fn(async () => {});
  const { rerender } = render(<AutomationEventEditor connected format={format} onAdd={save} />);
  const input = screen.getByPlaceholderText("00:05:00:00");
  fireEvent.change(input, { target: { value: "00:01:00:00" } });
  rerender(<AutomationEventEditor connected={false} format={format} onAdd={save} />);
  fireEvent.click(screen.getByRole("button", { name: "Add Event" }));
  expect(save).not.toHaveBeenCalled();
  expect(input).toHaveProperty("value", "00:01:00:00");
  expect(screen.getByRole("status").textContent).toContain("Reconnect");
});

it("uses the shared default, rejects invalid tolerance and saves exact zero", async () => {
  const save = vi.fn(async (_event: NewAutomationEvent) => {});
  render(<AutomationEventEditor connected format={format} onAdd={save} />);
  const tolerance = screen.getByLabelText("Tolerance (frames)");
  expect(tolerance).toHaveProperty("value", "5");
  fireEvent.change(screen.getByPlaceholderText("00:05:00:00"), { target: { value: "00:00:01:00" } });
  for (const value of ["", "-1", "1.5", "9001"]) {
    fireEvent.change(tolerance, { target: { value } });
    expect(screen.getByRole("button", { name: "Add Event" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("alert").textContent).toContain("whole number");
  }
  expect(save).not.toHaveBeenCalled();
  fireEvent.change(tolerance, { target: { value: "0" } });
  expect(screen.getByText(/Forward playback fires when the clock crosses the cue/)).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add Event" })));
  expect(save.mock.calls[0][0].toleranceFrames).toBe(0);
  expect(tolerance).toHaveProperty("value", "5");
});
