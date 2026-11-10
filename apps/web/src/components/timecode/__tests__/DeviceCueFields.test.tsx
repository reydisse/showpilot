import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DeviceCueFields } from "../DeviceCueFields";
import type { AutomationDeviceTarget, CueDetails } from "@/lib/automation-catalog";

vi.mock("@/lib/automation-targets", () => ({ getAutomationDeviceTargets: vi.fn(), getAutomationHomeAssistantActions: vi.fn() }));
afterEach(() => { cleanup(); vi.useRealTimers(); });
const devices: AutomationDeviceTarget[] = [{ id: "atem", label: "Main switcher", category: "video", actionSource: "static", actions: [
  { id: "program", label: "Program input", category: "switching", params: [{ id: "input", label: "Input", type: "number", min: 1, max: 8, step: 1 }] },
  { id: "aux", label: "Aux output", category: "switching", params: [{ id: "name", label: "Name", type: "string" }, { id: "enabled", label: "Enabled", type: "boolean" }, { id: "mode", label: "Mode", type: "select", options: [{ label: "Program", value: "program" }] }] },
] }, { id: "lights", label: "House lights", category: "lighting", actionSource: "static", actions: [
  { id: "recall_scene", label: "Recall scene", category: "scenes", params: [{ id: "scene", label: "Scene", type: "string" }] },
] }];

it("builds typed device parameters and rejects blank, fractional and out-of-range inputs", async () => {
  const change = vi.fn<(details: CueDetails) => void>();
  render(<DeviceCueFields lighting={false} initial={{}} onChange={change} loadDevices={async () => devices} />);
  await screen.findByRole("option", { name: "Main switcher" });
  fireEvent.change(screen.getByLabelText("Device"), { target: { value: "atem" } });
  fireEvent.change(screen.getByLabelText("Device action"), { target: { value: "program" } });
  for (const value of ["", "0", "2.5", "9"]) {
    fireEvent.change(screen.getByLabelText("Input"), { target: { value } });
    expect(change.mock.lastCall?.[0].status).toBe("invalid");
  }
  fireEvent.change(screen.getByLabelText("Input"), { target: { value: "3" } });
  expect(change.mock.lastCall?.[0]).toEqual({ status: "ready", payload: { deviceId: "atem", actionId: "program", params: { input: 3 } } });
  fireEvent.change(screen.getByLabelText("Device"), { target: { value: "lights" } });
  expect(change.mock.lastCall?.[0].status).toBe("invalid");
  expect(screen.queryByLabelText("Input")).toBeNull();
});

it("renders text, boolean and select parameters without JSON", async () => {
  const change = vi.fn<(details: CueDetails) => void>();
  render(<DeviceCueFields lighting={false} initial={{}} onChange={change} loadDevices={async () => devices} />);
  await screen.findByRole("option", { name: "Main switcher" });
  fireEvent.change(screen.getByLabelText("Device"), { target: { value: "atem" } });
  fireEvent.change(screen.getByLabelText("Device action"), { target: { value: "aux" } });
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: " Stream " } });
  fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "program" } });
  expect(change.mock.lastCall?.[0]).toEqual({ status: "ready", payload: { deviceId: "atem", actionId: "aux", params: { name: "Stream", mode: "program", enabled: false } } });
  fireEvent.click(screen.getByLabelText("Enabled"));
  expect(change.mock.lastCall?.[0]).toMatchObject({ payload: { params: { enabled: true } } });
});

it("restricts a lighting scene to lighting devices and the recall action", async () => {
  const change = vi.fn<(details: CueDetails) => void>();
  render(<DeviceCueFields lighting initial={{}} onChange={change} loadDevices={async () => devices} />);
  await screen.findByRole("option", { name: "House lights" });
  expect(screen.queryByRole("option", { name: "Main switcher" })).toBeNull();
  fireEvent.change(screen.getByLabelText("Lighting device"), { target: { value: "lights" } });
  fireEvent.change(screen.getByLabelText("Scene"), { target: { value: "Worship" } });
  expect(change.mock.lastCall?.[0]).toMatchObject({ status: "ready", payload: { deviceId: "lights", actionId: "recall_scene", params: { scene: "Worship" } } });
});

it("rejects a removed saved target and ignores a response from an old workspace", async () => {
  let complete: (devices: AutomationDeviceTarget[]) => void = () => {};
  const change = vi.fn<(details: CueDetails) => void>();
  const view = render(<DeviceCueFields key="old" lighting={false} initial={{ deviceId: "atem", actionId: "program", params: { input: 3 } }} onChange={change} loadDevices={() => new Promise(resolve => { complete = resolve; })} />);
  await act(async () => {});
  view.rerender(<DeviceCueFields key="new" lighting={false} initial={{ deviceId: "atem", actionId: "program", params: { input: 3 } }} onChange={change} loadDevices={async () => [devices[1]]} />);
  await screen.findByRole("option", { name: "House lights" });
  await act(async () => complete(devices));
  expect(screen.queryByRole("option", { name: "Main switcher" })).toBeNull();
  await waitFor(() => expect(change.mock.lastCall?.[0].status).toBe("invalid"));
});

it("bounds a stalled device catalog and exposes retry", async () => {
  vi.useFakeTimers();
  render(<DeviceCueFields lighting={false} initial={{}} onChange={() => {}} loadDevices={() => new Promise(() => {})} />);
  await act(async () => vi.advanceTimersByTime(10000));
  expect(screen.getByRole("alert").textContent).toContain("timed out");
  expect(screen.getByRole("button", { name: "Refresh devices" })).toHaveProperty("disabled", false);
});


it("allows fractional numeric values when the device definition has no integer step", async () => {
  const change = vi.fn<(details: CueDetails) => void>();
  const fractional: AutomationDeviceTarget = { id: "mixer", label: "Mixer", category: "audio", actionSource: "static", actions: [{ id: "gain", label: "Set gain", category: "audio", params: [{ id: "gain", label: "Gain", type: "number", min: 0, max: 1 }] }] };
  render(<DeviceCueFields lighting={false} initial={{}} onChange={change} loadDevices={async () => [fractional]} />);
  await screen.findByRole("option", { name: "Mixer" });
  fireEvent.change(screen.getByLabelText("Device"), { target: { value: "mixer" } });
  fireEvent.change(screen.getByLabelText("Device action"), { target: { value: "gain" } });
  const input = screen.getByLabelText("Gain");
  fireEvent.change(input, { target: { value: "0.5" } });
  expect(input).toBeInstanceOf(HTMLInputElement);
  if (!(input instanceof HTMLInputElement)) throw new Error("Missing numeric field");
  expect(input.checkValidity()).toBe(true);
  expect(change.mock.lastCall?.[0]).toMatchObject({ status: "ready", payload: { params: { gain: 0.5 } } });
});

const haDevices: AutomationDeviceTarget[] = [
  { id: "ha-stage", label: "Stage HA", category: "automation", actionSource: "homeassistant" },
  { id: "ha-lobby", label: "Lobby HA", category: "automation", actionSource: "homeassistant" },
];
const haActions = [{ id: "ha:scene:turn_on:scene.service", label: "Service", category: "scenes", params: [] }];
it("discovers only the selected HA device, retains failures and retries before accepting an action", async () => {
  const change = vi.fn<(details: CueDetails) => void>();
  const discover = vi.fn(async (_deviceId: string) => haActions).mockRejectedValueOnce(new Error("Connect this Home Assistant device in Devices, then refresh actions."));
  render(<DeviceCueFields orgId="org" lighting={false} initial={{}} onChange={change} loadDevices={async () => haDevices} loadActions={discover} />);
  await screen.findByRole("option", { name: "Stage HA" });
  expect(discover).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Device"), { target: { value: "ha-stage" } });
  expect((await screen.findByRole("alert")).textContent).toContain("Connect this Home Assistant device");
  expect(change.mock.lastCall?.[0].status).toBe("invalid");
  fireEvent.click(screen.getByRole("button", { name: "Refresh actions" }));
  await screen.findByRole("option", { name: "Service" });
  fireEvent.change(screen.getByLabelText("Device action"), { target: { value: haActions[0].id } });
  expect(change.mock.lastCall?.[0]).toEqual({ status: "ready", payload: { deviceId: "ha-stage", actionId: haActions[0].id, params: {} } });
  expect(discover.mock.calls).toEqual([["ha-stage"], ["ha-stage"]]);
});

it("discards a late HA response when another device is selected", async () => {
  const change = vi.fn<(details: CueDetails) => void>();
  let release: (value: typeof haActions) => void = () => {};
  const discover = vi.fn(async (_deviceId: string) => haActions).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
    .mockResolvedValueOnce([{ id: "ha:light:turn_off:light.lobby", label: "Lobby Off", category: "lights", params: [] }]);
  render(<DeviceCueFields orgId="org" lighting={false} initial={{}} onChange={change} loadDevices={async () => haDevices} loadActions={discover} />);
  await screen.findByRole("option", { name: "Stage HA" });
  fireEvent.change(screen.getByLabelText("Device"), { target: { value: "ha-stage" } });
  await waitFor(() => expect(discover).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByLabelText("Device"), { target: { value: "ha-lobby" } });
  await screen.findByRole("option", { name: "Lobby Off" });
  await act(async () => release(haActions));
  expect(screen.queryByRole("option", { name: "Service" })).toBeNull();
  fireEvent.change(screen.getByLabelText("Device action"), { target: { value: "ha:light:turn_off:light.lobby" } });
  expect(change.mock.lastCall?.[0]).toMatchObject({ status: "ready", payload: { deviceId: "ha-lobby", actionId: "ha:light:turn_off:light.lobby" } });
});

it("times out discovery without showing an empty catalog and keeps the edit invalid until refreshed", async () => {
  vi.useFakeTimers();
  const change = vi.fn<(details: CueDetails) => void>();
  const discover = vi.fn<() => Promise<typeof haActions>>().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue(haActions);
  render(<DeviceCueFields orgId="org" lighting={false} initial={{ deviceId: "ha-stage", actionId: haActions[0].id }} onChange={change} loadDevices={async () => haDevices} loadActions={discover} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByText("Discovering Home Assistant actions…")).toBeTruthy();
  expect(screen.queryByText("This device has no supported actions available.")).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(screen.getByRole("alert").textContent).toContain("timed out");
  expect(change.mock.lastCall?.[0].status).toBe("invalid");
  fireEvent.click(screen.getByRole("button", { name: "Refresh actions" }));
  expect(change.mock.lastCall?.[0].status).toBe("invalid");
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(change.mock.lastCall?.[0].status).toBe("ready");
});
