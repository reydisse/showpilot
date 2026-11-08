import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MidiControllerPanel, MidiControllerProvider } from "./MidiController";
import { MidiAccessFixture, MidiInputFixture, MidiOutputFixture } from "@/test/midi-fixture";
import { emptyMidiController } from "@/lib/midi-controller";
import type { UseTimecodeReturn } from "@/hooks/useTimecode";

afterEach(() => { cleanup(); if (vi.isFakeTimers()) expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function fixture() {
  vi.useFakeTimers();
  const input = new MidiInputFixture("pads", "APC"); const output = new MidiOutputFixture("led", "APC");
  const access = new MidiAccessFixture(input); access.outputs.set(output.id, output);
  vi.stubGlobal("navigator", { requestMIDIAccess: vi.fn().mockResolvedValue(access) });
  const tc: UseTimecodeReturn = {
    state: { showId: "show", source: "internal-freerun", format: { frameRate: 30, dropFrame: "ndf" }, running: false, timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, totalFrames: 0, display: "00:00:00:00", serverTime: 0, lyrics: null, triggersEnabled: true },
    connected: true, connectionStatus: "connected", control: "yours", display: "00:00:00:00", events: [], isMaster: false, generatorPending: null, lastError: null, lastErrorAt: null, retryConnection: vi.fn(), mtcSupported: true,
    controlLyrics: vi.fn(async () => {}), lyricsPending: null, lyricsError: null,
    controller: { revision: 1, config: { ...emptyMidiController().config, input: { id: input.id, name: input.name, manufacturer: input.manufacturer }, output: { id: output.id, name: output.name, manufacturer: output.manufacturer }, feedback: "apc-mini-mk2", bindings: [
      { id: "next", input: { kind: "note", channel: 0, number: 0 }, action: { kind: "fire-next" } },
      { id: "scrub", input: { kind: "cc", channel: 0, number: 48 }, action: { kind: "scrub", frames: 90 } },
      { id: "offset", input: { kind: "cc", channel: 0, number: 50 }, action: { kind: "offset", frames: 30 } },
    ] } },
    saveController: vi.fn(() => ({ status: "sent" as const })), claimControl: vi.fn(), releaseControl: vi.fn(), startFreerun: vi.fn(() => ({ status: "sent" as const })), pauseGenerator: vi.fn(), stopGenerator: vi.fn(), startMtc: vi.fn(async () => {}), stopMtc: vi.fn(),
    setTimecode: vi.fn(), adjustTimecode: vi.fn(), setFormat: vi.fn(), addEvent: vi.fn(async () => {}), replaceEventGroup: vi.fn(async () => {}), updateEvent: vi.fn(async () => {}), removeEvent: vi.fn(), resetEvents: vi.fn(), retryEvent: vi.fn(), fireEvent: vi.fn(), fireNext: vi.fn(), skipEvent: vi.fn(), rearmEvent: vi.fn(), setEventEnabled: vi.fn(), setTriggersEnabled: vi.fn(), resumeAutomaticCues: vi.fn(), setLyrics: vi.fn(), clearLyrics: vi.fn(),
  };
  const tree = (clock = tc, showId = "show") => <MidiControllerProvider timecode={clock} showId={showId}><MidiControllerPanel timecode={clock} /></MidiControllerProvider>;
  const view = render(tree());
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Connect controller" })); });
  return { tc, input, output, access, rerender: (clock: UseTimecodeReturn, showId = "show") => view.rerender(tree(clock, showId)) };
}
it("requires arming, suppresses held-pad repeats, and disarms immediately for a new mapping revision", async () => {
  const { tc, input, output, rerender } = await fixture();
  act(() => input.send([0x90, 0, 127])); expect(tc.fireNext).not.toHaveBeenCalled();
  expect(output.messages).toEqual([]); // A disarmed tab must not overwrite another tab's lights.
  fireEvent.click(screen.getByRole("button", { name: "Arm controller" }));
  act(() => { input.send([0x90, 0, 127]); input.send([0x90, 0, 100]); input.send([0x90, 0, 127]); });
  expect(tc.fireNext).toHaveBeenCalledOnce();
  rerender({ ...tc, controller: { ...tc.controller, revision: 2 } });
  act(() => { input.send([0x80, 0, 127]); input.send([0x90, 0, 127]); });
  expect(tc.fireNext).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Arm controller" })).toBeTruthy();
});

it("maps note presses to lyric stepping and suppresses a held footswitch", async () => {
  const { tc, input, rerender } = await fixture();
  rerender({ ...tc, controller: { revision: 2, config: { ...tc.controller.config, bindings: [
    { id: "lyric-next", input: { kind: "note", channel: 0, number: 1 }, action: { kind: "lyrics-next" } },
    { id: "lyric-previous", input: { kind: "note", channel: 0, number: 2 }, action: { kind: "lyrics-previous" } },
  ] } } });
  fireEvent.click(screen.getByRole("button", { name: "Reload saved mappings" }));
  fireEvent.click(screen.getByRole("button", { name: "Arm controller" }));
  await act(async () => { input.send([0x90, 1, 127]); input.send([0x90, 1, 127]); input.send([0x90, 2, 127]); });
  expect(vi.mocked(tc.controlLyrics).mock.calls).toEqual([["next"], ["previous"]]);
});
it("cancels buffered fader movement on unplug, disarm, control loss and show changes", async () => {
  const { tc, input, access, rerender } = await fixture();
  fireEvent.click(screen.getByRole("button", { name: "Arm controller" }));
  act(() => { input.send([0xb0, 48, 127]); access.disconnect(input); vi.advanceTimersByTime(100); });
  expect(tc.setTimecode).not.toHaveBeenCalled();
  act(() => access.connect(input));
  act(() => input.send([0xb0, 48, 100]));
  fireEvent.click(screen.getByRole("button", { name: "Disarm controller" }));
  act(() => vi.advanceTimersByTime(100)); expect(tc.setTimecode).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Arm controller" }));
  act(() => input.send([0xb0, 48, 120])); rerender({ ...tc, control: "other" });
  act(() => vi.advanceTimersByTime(100)); expect(tc.setTimecode).not.toHaveBeenCalled();
  rerender(tc); fireEvent.click(screen.getByRole("button", { name: "Arm controller" }));
  rerender(tc, "another-show"); act(() => input.send([0x90, 0, 127])); expect(tc.fireNext).not.toHaveBeenCalled();
});
it("learns input without executing it and keeps unsaved edits until the relay echoes the save", async () => {
  const { tc, input, rerender } = await fixture();
  fireEvent.click(screen.getByRole("button", { name: "Learn MIDI input" }));
  act(() => input.send([0x90, 12, 127])); expect(tc.fireNext).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Save mappings" }));
  expect(tc.saveController).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Saving mappings…" })).toBeTruthy();
  const [config, revision] = vi.mocked(tc.saveController).mock.calls[0];
  expect(config.bindings.at(-1)).toMatchObject({ input: { kind: "note", channel: 0, number: 12 }, action: { kind: "fire-next" } });
  rerender({ ...tc, controller: { revision: revision + 1, config } });
  expect(screen.getByRole("button", { name: "Save mappings" })).toBeTruthy();
});

it("retains fractional trim across slow single-step fader movement", async () => {
  const { tc, input } = await fixture();
  fireEvent.click(screen.getByRole("button", { name: "Arm controller" }));
  for (let value = 64; value <= 127; value++) act(() => { input.send([0xb0, 50, value]); vi.advanceTimersByTime(50); });
  expect(vi.mocked(tc.adjustTimecode).mock.calls.reduce((sum, [frames]) => sum + frames, 0)).toBe(30);
});
