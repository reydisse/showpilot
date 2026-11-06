// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LtcInputConfig, LtcStatus, MtcStatus } from "./desktop";

const native = vi.hoisted(() => ({
  getBridgeConfig: vi.fn(), getMtcStatus: vi.fn(), getLtcStatus: vi.fn(),
  listMidiInputs: vi.fn(), listAudioInputs: vi.fn(),
  startMtcInput: vi.fn(), startLtcInput: vi.fn(), stopMtcInput: vi.fn(), stopLtcInput: vi.fn(),
}));
vi.mock("./desktop", async original => ({ ...await original<typeof import("./desktop")>(), ...native }));
import { TimecodeInputs } from "./TimecodeInputs";

let mtc: MtcStatus;
let ltc: LtcStatus;
const input: LtcInputConfig = { deviceId: "interface", deviceName: "Audio interface", channel: 2, rate: "25-ndf" };
const ports = [{ id: "interface", name: "Audio interface", channels: 2 }];

beforeEach(() => {
  vi.resetAllMocks();
  mtc = { connected: true, inputName: "midi", timecode: "01:02:03:04" };
  ltc = { selected: null, connected: false, locked: false, timecode: null, level: 0, sampleRate: null, lastFrameAgeMs: null, error: null };
  native.getBridgeConfig.mockResolvedValue({ site: "https://example.test", org: "test", key: "", midiInputName: "midi" });
  native.getMtcStatus.mockImplementation(async () => mtc);
  native.getLtcStatus.mockImplementation(async () => ltc);
  native.listMidiInputs.mockResolvedValue([{ id: "midi", name: "MIDI interface" }]);
  native.listAudioInputs.mockResolvedValue(ports);
  native.startLtcInput.mockImplementation(async (selected: LtcInputConfig) => {
    mtc = { connected: false, inputName: null, timecode: null };
    ltc = { ...ltc, selected, connected: true, sampleRate: 48000 };
    return ltc;
  });
  native.stopLtcInput.mockImplementation(async () => { ltc = { ...ltc, selected: null, connected: false, locked: false }; });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

async function chooseAudio() {
  await screen.findByRole("option", { name: "Audio interface" });
  fireEvent.change(screen.getByLabelText("Audio input"), { target: { value: "interface" } });
  fireEvent.change(screen.getByLabelText("Audio channel"), { target: { value: "2" } });
  fireEvent.change(screen.getByLabelText("LTC frame rate"), { target: { value: "25-ndf" } });
}
async function rescan() {
  fireEvent.click(screen.getByRole("button", { name: "Rescan inputs" }));
  await waitFor(() => expect(screen.queryByText("Refreshing inputs…")).toBeNull());
}

it("switches from MTC, reports lock loss, and preserves the selected channel through unplug and reconnect", async () => {
  render(<TimecodeInputs bridgeRunning />);
  await chooseAudio();
  fireEvent.click(screen.getByRole("button", { name: "Switch to LTC" }));
  await screen.findByText("Waiting for LTC");
  expect(native.startLtcInput).toHaveBeenCalledWith(input);
  expect(screen.queryByText("MTC connected")).toBeNull();

  ltc = { ...ltc, locked: true, timecode: "01:02:03:04", level: .6, lastFrameAgeMs: 12 };
  await rescan();
  expect(screen.getByText("LTC locked")).toBeTruthy();
  expect(screen.getByLabelText("Decoded LTC").textContent).toBe("01:02:03:04");
  expect(screen.getByLabelText("LTC input level").getAttribute("value")).toBe("0.6");

  ltc = { ...ltc, connected: false, locked: false, level: 0, error: "Audio input disconnected" };
  native.listAudioInputs.mockResolvedValue([]);
  await rescan();
  expect(screen.getByText("Audio input unavailable")).toBeTruthy();
  expect(screen.getByRole("option", { name: "Audio interface · unavailable" })).toBeTruthy();
  expect((screen.getByLabelText("Audio channel") as HTMLInputElement).value).toBe("2");
  native.listAudioInputs.mockResolvedValue(ports);
  ltc = { ...ltc, connected: true, locked: true, error: null };
  await rescan();
  expect(screen.getByText("LTC locked")).toBeTruthy();
  expect(native.startLtcInput).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Stop LTC" }));
  await screen.findByText("LTC stopped");
  expect(native.stopLtcInput).toHaveBeenCalledOnce();
});

it("keeps the draft and MTC state when audio permission is rejected, then allows a retry", async () => {
  native.startLtcInput.mockRejectedValueOnce(new Error("Allow microphone access to capture LTC."));
  render(<TimecodeInputs bridgeRunning />);
  await chooseAudio();
  fireEvent.click(screen.getByRole("button", { name: "Switch to LTC" }));
  await screen.findByRole("alert");
  expect(screen.getByText("MTC connected")).toBeTruthy();
  expect((screen.getByLabelText("LTC frame rate") as HTMLSelectElement).value).toBe("25-ndf");
  fireEvent.click(screen.getByRole("button", { name: "Switch to LTC" }));
  await screen.findByText("Waiting for LTC");
  expect(native.startLtcInput).toHaveBeenNthCalledWith(2, input);
});

it("blocks an invalid channel and starting input capture while the Bridge is stopped", async () => {
  const view = render(<TimecodeInputs bridgeRunning={false} />);
  await chooseAudio();
  expect((screen.getByRole("button", { name: "Switch to LTC" }) as HTMLButtonElement).disabled).toBe(true);
  view.rerender(<TimecodeInputs bridgeRunning />);
  for (const value of ["", "0", "3", "1.5"]) {
    fireEvent.change(screen.getByLabelText("Audio channel"), { target: { value } });
    expect((screen.getByRole("button", { name: "Switch to LTC" }) as HTMLButtonElement).disabled).toBe(true);
  }
  expect(native.startLtcInput).not.toHaveBeenCalled();
});

it("does not claim an LTC lock after status failure and recovers without hiding a healthy MTC input", async () => {
  ltc = { ...ltc, selected: input, connected: true, locked: true };
  render(<TimecodeInputs bridgeRunning />);
  await screen.findByText("LTC locked");
  native.getLtcStatus.mockRejectedValueOnce(new Error("LTC status unavailable"));
  await rescan();
  expect(screen.queryByText("LTC locked")).toBeNull();
  expect(screen.getByText("MTC connected")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("LTC status unavailable");
  await rescan();
  expect(screen.getByText("LTC locked")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("ignores an older poll response when a source switch completes", async () => {
  vi.useFakeTimers();
  await act(async () => { render(<TimecodeInputs bridgeRunning />); });
  expect(screen.getByRole("option", { name: "Audio interface" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Audio input"), { target: { value: "interface" } });
  fireEvent.change(screen.getByLabelText("Audio channel"), { target: { value: "2" } });
  fireEvent.change(screen.getByLabelText("LTC frame rate"), { target: { value: "25-ndf" } });
  let finish: (status: LtcStatus) => void = () => {};
  const old = ltc;
  native.getLtcStatus.mockImplementationOnce(() => new Promise<LtcStatus>(resolve => { finish = resolve; }));
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(native.getLtcStatus).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Switch to LTC" }));
  await act(async () => { finish(old); });
  expect(screen.getByText("Waiting for LTC")).toBeTruthy();
  expect(screen.queryByText("LTC stopped")).toBeNull();
});
