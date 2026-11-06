import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AutomationEventEditor } from "../AutomationEventEditor";
import type { NewAutomationEvent } from "@/hooks/useTimecode";

afterEach(cleanup);
const format = { frameRate: 30, dropFrame: "ndf" } as const;

it.each([
  { action: "rundown-goto-item", field: "Rundown item", payload: { itemId: "target" }, label: "Jump to Message" },
  { action: "lighting-blackout", field: "Lighting device", payload: { deviceId: "target" }, label: "Blackout Message" },
])("saves a named $action target without raw JSON", async ({ action, field, payload, label }) => {
  const save = vi.fn(async (_event: NewAutomationEvent) => {});
  const loadTargets = vi.fn(async () => [{ id: "target", label: "Message" }]);
  render(<AutomationEventEditor connected format={format} onAdd={save} loadTargets={loadTargets} />);
  fireEvent.change(screen.getByPlaceholderText("00:05:00:00"), { target: { value: "00:00:10:00" } });
  fireEvent.change(screen.getByRole("combobox"), { target: { value: action } });
  expect(screen.getByRole("button", { name: "Add Event" })).toHaveProperty("disabled", true);
  await screen.findByRole("option", { name: "1. Message" });
  fireEvent.change(screen.getByLabelText(field), { target: { value: "target" } });
  expect(document.querySelector("textarea")).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add Event" })));
  expect(save.mock.calls[0][0]).toMatchObject({ action, label, payload });
  expect(loadTargets).toHaveBeenCalledWith(action);
});

it("does not show stale targets after a keyed show change or a failed refresh", async () => {
  let release: (options: { id: string; label: string }[]) => void = () => {};
  const oldLoad = () => new Promise<{ id: string; label: string }[]>(resolve => { release = resolve; });
  const newLoad = vi.fn(async () => { throw new Error("Target list unavailable"); });
  const onAdd = vi.fn(async (_event: NewAutomationEvent) => {});
  const view = render(<AutomationEventEditor key="first-show" connected format={format} onAdd={onAdd} loadTargets={oldLoad} />);
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "rundown-goto-item" } });
  view.rerender(<AutomationEventEditor key="second-show" connected format={format} onAdd={onAdd} loadTargets={newLoad} />);
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "rundown-goto-item" } });
  await screen.findByText("Target list unavailable");
  await act(async () => release([{ id: "old", label: "Old show" }]));
  expect(screen.queryByRole("option", { name: /Old show/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Add Event" })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "Retry loading targets" }));
  await waitFor(() => expect(newLoad).toHaveBeenCalledTimes(2));
  expect(onAdd).not.toHaveBeenCalled();
});

it("saves a structured crew message and preserves it after an unconfirmed save", async () => {
  const save = vi.fn(async (_event: NewAutomationEvent) => { throw new Error("Relay disconnected"); });
  render(<AutomationEventEditor connected format={format} onAdd={save} />);
  fireEvent.change(screen.getByPlaceholderText("00:05:00:00"), { target: { value: "00:00:10:00" } });
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "crew-message" } });
  fireEvent.change(screen.getByLabelText("Crew message"), { target: { value: "  Standby cameras\nCamera 2 next  " } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add Event" })));
  expect(save.mock.calls[0][0]).toMatchObject({ action: "crew-message", payload: { message: "Standby cameras\nCamera 2 next" } });
  expect(screen.getByRole("alert").textContent).toBe("Relay disconnected");
  expect(screen.getByLabelText("Crew message")).toHaveProperty("value", "  Standby cameras\nCamera 2 next  ");
  expect(screen.getByText(/Delivery to any linked chat service/)).toBeTruthy();
});

it("offers a named prop cue and preserves its fields when saving fails", async () => {
  const save = vi.fn(async (_event: NewAutomationEvent) => { throw new Error("Relay disconnected"); });
  render(<AutomationEventEditor connected format={format} onAdd={save} />);
  fireEvent.change(screen.getByPlaceholderText("00:05:00:00"), { target: { value: "00:00:10:00" } });
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "pp-trigger-prop" } });
  fireEvent.change(screen.getByLabelText("Prop name"), { target: { value: " Standby " } });
  fireEvent.change(screen.getByLabelText("ProPresenter target (optional)"), { target: { value: "propresenter:venue.local:50001" } });
  expect(screen.queryByRole("textbox", { name: "Action details (JSON)" })).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add Event" })));
  expect(save.mock.calls[0][0]).toMatchObject({ action: "pp-trigger-prop", payload: { propName: "Standby", target: "propresenter:venue.local:50001" } });
  expect(screen.getByRole("alert").textContent).toBe("Relay disconnected");
  expect(screen.getByLabelText("Prop name")).toHaveProperty("value", " Standby ");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add Event" })));
  expect(save.mock.calls[1][0].id).toBe(save.mock.calls[0][0].id);
});

it.each(["pp-trigger-previous", "pp-clear-props", "lyrics-next-section", "lyrics-previous-section", "lyrics-clear"])("saves %s without carrying stale JSON or prop details", async action => {
  const save = vi.fn(async (_event: NewAutomationEvent) => {});
  render(<AutomationEventEditor connected format={format} onAdd={save} />);
  fireEvent.change(screen.getByPlaceholderText("00:05:00:00"), { target: { value: "00:00:10:00" } });
  fireEvent.change(document.querySelector("textarea")!, { target: { value: '{"action":"clear-all"}' } });
  fireEvent.change(screen.getByRole("combobox"), { target: { value: action } });
  expect(screen.queryByLabelText("Prop name")).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add Event" })));
  expect(save.mock.calls[0][0]).toMatchObject({ action, payload: {} });
});

it("keeps the draft through a failed save and reuses its id until relay confirmation", async () => {
  let confirm: () => void = () => {};
  let fail: (error: Error) => void = () => {};
  const save = vi.fn((_event: NewAutomationEvent) => new Promise<void>((resolve, reject) => { confirm = resolve; fail = reject; }));
  render(<AutomationEventEditor connected format={format} onAdd={save} />);
  const timecode = screen.getByPlaceholderText("00:05:00:00");
  fireEvent.change(timecode, { target: { value: "00:00:10:00" } });
  fireEvent.change(screen.getByLabelText("Tolerance (frames)"), { target: { value: "13" } });
  fireEvent.change(screen.getByLabelText("Cue lead (ms)"), { target: { value: "250" } });
  fireEvent.click(screen.getByRole("button", { name: "Add Event" }));
  expect(timecode).toHaveProperty("value", "00:00:10:00");
  expect(screen.getByLabelText("Cue lead (ms)")).toHaveProperty("value", "250");
  expect(screen.getByLabelText("Tolerance (frames)")).toHaveProperty("value", "13");
  expect(screen.getByRole("button", { name: "Waiting for relay…" }).closest("fieldset")).toHaveProperty("disabled", true);
  const id = save.mock.calls[0][0].id;
  await act(async () => fail(new Error("Disconnected; draft kept")));
  expect(timecode).toHaveProperty("value", "00:00:10:00");
  expect(screen.getByLabelText("Tolerance (frames)")).toHaveProperty("value", "13");
  fireEvent.click(screen.getByRole("button", { name: "Add Event" }));
  expect(save.mock.calls[1][0].id).toBe(id);
  expect(save.mock.calls[1][0].leadMs).toBe(250);
  await act(async () => confirm());
  expect(timecode).toHaveProperty("value", "");
  expect(screen.getByLabelText("Cue lead (ms)")).toHaveProperty("value", "0");
});

it("validates cue lead before saving", async () => {
  const save = vi.fn(async (_event: NewAutomationEvent) => {});
  render(<AutomationEventEditor connected format={format} onAdd={save} />);
  fireEvent.change(screen.getByPlaceholderText("00:05:00:00"), { target: { value: "00:00:10:00" } });
  const input = screen.getByLabelText("Cue lead (ms)");
  for (const value of ["", "-1", "0.5", "60001"]) {
    fireEvent.change(input, { target: { value } });
    expect(screen.getByRole("button", { name: "Add Event" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("alert").textContent).toContain("Cue lead");
  }
  fireEvent.change(input, { target: { value: "100" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add Event" })));
  expect(save.mock.calls[0][0].leadMs).toBe(100);
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

it.each(["triggers-disable", "triggers-enable"])("saves %s without stale JSON and explains the safety precedence", async action => {
  const save = vi.fn(async (_event: NewAutomationEvent) => {});
  render(<AutomationEventEditor connected format={format} onAdd={save} />);
  fireEvent.change(screen.getByPlaceholderText("00:05:00:00"), { target: { value: "00:00:10:00" } });
  const details = document.querySelector("textarea");
  if (!details) throw new Error("Missing initial JSON field");
  fireEvent.change(details, { target: { value: "invalid JSON from the previous action" } });
  fireEvent.change(screen.getByRole("combobox"), { target: { value: action } });
  expect(document.querySelector("textarea")).toBeNull();
  expect(screen.getByText(/pause wins/)).toBeTruthy();
  if (action === "triggers-enable") expect(screen.getByText(/cannot override the safety kill switch/)).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add Event" })));
  expect(save.mock.calls[0][0]).toMatchObject({ action, payload: {}, enabled: true });
});

it("saves named Start and Stop with structured fields, inline duration validation and retained drafts", async () => {
  const save = vi.fn(async (_event: NewAutomationEvent) => { throw new Error("Relay disconnected"); });
  render(<AutomationEventEditor connected format={format} onAdd={save} timerNames={["Speaker countdown"]} />);
  fireEvent.change(screen.getByPlaceholderText("00:05:00:00"), { target: { value: "00:00:10:00" } });
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "timer-start" } });
  fireEvent.change(screen.getByLabelText("Timer name"), { target: { value: " Speaker countdown " } });
  fireEvent.change(screen.getByLabelText("Duration (m:ss)"), { target: { value: "5:99" } });
  expect(screen.getByRole("button", { name: "Add Event" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("alert").textContent).toContain("Enter a duration");
  fireEvent.change(screen.getByLabelText("Duration (m:ss)"), { target: { value: "5:00" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add Event" })));
  expect(save.mock.calls[0][0]).toMatchObject({ action: "timer-start", payload: { name: "Speaker countdown", durationMs: 300000 }, label: "Start Speaker countdown" });
  expect(screen.getByLabelText("Timer name")).toHaveProperty("value", " Speaker countdown ");
  expect(document.querySelector("textarea")).toBeNull();
  fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "timer-stop" } });
  expect(screen.queryByLabelText("Duration (m:ss)")).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add Event" })));
  expect(save.mock.calls[1][0]).toMatchObject({ action: "timer-stop", payload: { name: "Speaker countdown" }, label: "Stop Speaker countdown" });
});
