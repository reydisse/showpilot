import { afterEach, expect, it, vi } from "vitest";
import { apcMiniMk2CueBindings, apcMiniMk2Led, bindingPadState, cueBank, emptyMidiController, midiControllerSchema, parseControllerMessage } from "../midi-controller";
import { MidiControllerRuntime } from "../midi-controller-runtime";
import { MidiAccessFixture, MidiInputFixture, MidiOutputFixture } from "@/test/midi-fixture";
import { MtcSource } from "../timecode-sources/mtc-source";
import { InternalTimecodeSource } from "../timecode-sources/internal-source";
import type { AutomationEvent, TimecodeState } from "@/types/timecode";

const releases: (() => void)[] = [];
afterEach(() => { releases.splice(0).forEach(stop => stop()); if (vi.isFakeTimers()) expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); vi.unstubAllGlobals(); });
const state: TimecodeState = { running: false, totalFrames: 0, source: "internal-freerun", triggersEnabled: true, display: "00:00:00:00", timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, format: { frameRate: 30, dropFrame: "ndf" }, serverTime: 0, lyrics: null };
const cue = (id: number, changes: Partial<AutomationEvent> = {}): AutomationEvent => ({ id: String(id), label: String(id), triggerFrame: id, triggerTimecode: state.timecode, action: "lyrics-clear", payload: {}, fired: false, enabled: true, toleranceFrames: 5, ...changes });
async function fixture() {
  vi.useFakeTimers();
  const pads = new MidiInputFixture("pads", "APC"); const daw = new MidiInputFixture("daw");
  const output = new MidiOutputFixture("led", "APC");
  const access = new MidiAccessFixture(pads, daw); access.outputs.set(output.id, output);
  vi.stubGlobal("navigator", { requestMIDIAccess: vi.fn().mockResolvedValue(access) });
  const callbacks = { message: vi.fn(), ports: vi.fn(), error: vi.fn() };
  const runtime = new MidiControllerRuntime(await navigator.requestMIDIAccess(), callbacks);
  releases.push(() => runtime.stop()); runtime.select(pads, output);
  return { pads, daw, access, output, callbacks, runtime };
}
it("accepts only note/CC channel messages and treats Note Off as release regardless of velocity", () => {
  expect(parseControllerMessage(Uint8Array.from([0x92, 63, 127]))).toEqual({ input: { kind: "note", channel: 2, number: 63 }, value: 127 });
  expect(parseControllerMessage(Uint8Array.from([0x82, 63, 127]))?.value).toBe(0);
  for (const message of [[0xf1, 0], [0xf2, 0, 0], [0xf8], [0xfa], [0x90, 128, 1], [0x90, 2, 255], [0xb0, 7]]) expect(parseControllerMessage(Uint8Array.from(message))).toBeNull();
});
it("rejects duplicate inputs, invalid fader mappings, arbitrary fields, and oversized configurations", () => {
  const config = { ...emptyMidiController().config, bindings: apcMiniMk2CueBindings() };
  expect(midiControllerSchema.safeParse(config).success).toBe(true);
  expect(midiControllerSchema.safeParse({ ...config, bindings: [...config.bindings, { ...config.bindings[0], id: "duplicate" }] }).success).toBe(false);
  expect(midiControllerSchema.safeParse({ ...config, bindings: [{ ...config.bindings[0], action: { kind: "jog", frames: 1 } }] }).success).toBe(false);
  expect(midiControllerSchema.safeParse({ ...config, armed: true }).success).toBe(false);
  expect(midiControllerSchema.safeParse({ ...config, bindings: Array(257).fill(config.bindings[0]) }).success).toBe(false);
});
it("paginates over 64 cues and derives distinct armed, next, fired, running, failed and off feedback", () => {
  const events = Array.from({ length: 130 }, (_, i) => cue(i + 1));
  expect(cueBank(events.reverse(), 1).map(event => event.id)).toEqual(Array.from({ length: 64 }, (_, i) => String(i + 65)));
  const binding = apcMiniMk2CueBindings()[0];
  expect(bindingPadState(binding, events, state, 0)).toBe("next");
  expect(bindingPadState(binding, events, state, 1)).toBe("armed");
  for (const [changes, expected] of [[{ fired: true }, "fired"], [{ executionStatus: "dispatching" }, "running"], [{ executionStatus: "failed" }, "failed"], [{ skipped: true }, "off"]] as const) expect(bindingPadState(binding, [cue(1, changes)], state, 0)).toBe(expected);
  expect(bindingPadState(binding, events, { ...state, triggersEnabled: false }, 0)).toBe("off");
  expect(apcMiniMk2Led(0, "armed")).toEqual([0x96, 0, 45]);
  expect(apcMiniMk2Led(1, "next")).toEqual([0x96, 1, 13]);
  expect(apcMiniMk2Led(100, "running")).toEqual([0x90, 100, 2]);
  expect(apcMiniMk2Led(122, "running")).toBeNull();
});
it("runs MTC and controller listeners simultaneously on separate inputs and preserves another listener", async () => {
  const { pads, daw, callbacks } = await fixture();
  const frames = vi.fn(); const mtc = new MtcSource(frames); releases.push(() => mtc.stop()); await mtc.start(daw.id);
  const other = vi.fn(); pads.addEventListener("midimessage", other);
  [0, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x76].forEach(value => daw.send([0xf1, value]));
  pads.send([0x90, 1, 127]); pads.send([0xb0, 48, 12]); pads.send([0xf2, 0, 0]); daw.send([0x90, 1, 127]);
  expect(frames).toHaveBeenCalledOnce(); expect(callbacks.message).toHaveBeenCalledTimes(2); expect(other).toHaveBeenCalledTimes(3);
});
it("recovers input and LED output with changed IDs through a missed hotplug event", async () => {
  const { pads, access, output, runtime, callbacks } = await fixture();
  runtime.feedback([[0x96, 0, 13]]);
  runtime.feedback([[0x96, 0, 13]]);
  expect(output.messages).toEqual([[0x96, 0, 13]]);
  pads.send([0x90, 0, 127]); pads.send([0x90, 0, 127]); expect(callbacks.message).toHaveBeenCalledOnce();
  access.disconnect(pads); output.state = "disconnected"; access.outputs.delete(output.id);
  const replacement = new MidiInputFixture("pads-new", pads.name); const newOutput = new MidiOutputFixture("led-new", output.name);
  access.connect(replacement, false); access.outputs.set(newOutput.id, newOutput);
  vi.advanceTimersByTime(2000);
  replacement.send([0x90, 0, 127]); pads.send([0x90, 1, 127]);
  expect(callbacks.message).toHaveBeenCalledTimes(2);
  expect(newOutput.messages).toEqual([[0x96, 0, 13]]);
  runtime.stop(); expect(newOutput.messages.at(-1)).toEqual([0x90, 0, 0]);
  replacement.send([0x80, 0, 127]); expect(callbacks.message).toHaveBeenCalledTimes(2);
});
it("does not attach an ambiguous replacement port", async () => {
  const { pads, access, callbacks } = await fixture(); access.disconnect(pads);
  const a = new MidiInputFixture("a", pads.name); const b = new MidiInputFixture("b", pads.name);
  access.connect(a, false); access.connect(b); a.send([0x90, 0, 127]); b.send([0x90, 0, 127]);
  expect(callbacks.message).not.toHaveBeenCalled();
});

it("keeps only one internal clock loop during repeated live seeks", () => {
  const scheduled = new Set<object>();
  vi.stubGlobal("Worker", class {
    constructor() { scheduled.add(this); }
    terminate() { scheduled.delete(this); }
    postMessage() {}
  });
  const source = new InternalTimecodeSource(state.format, vi.fn()); releases.push(() => source.stop());
  for (let frame = 0; frame < 100; frame++) { source.startAtFrame(frame); expect(scheduled.size).toBe(1); }
  expect(source.currentFrame()).toBeGreaterThanOrEqual(99);
  source.stop(); expect(scheduled.size).toBe(0);
});
