import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MtcSource } from "../timecode-sources/mtc-source";
import { MidiAccessFixture, MidiInputFixture } from "@/test/midi-fixture";

const sources: MtcSource[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  sources.splice(0).forEach(source => source.stop());
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const cycle = [0, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x76];
function frame(input: MidiInputFixture) { cycle.forEach(value => input.send([0xf1, value])); }
async function fixture() {
  const input = new MidiInputFixture("daw-1", "DAW timecode");
  const controller = new MidiInputFixture("pads", "APC");
  const access = new MidiAccessFixture(input, controller);
  const request = vi.fn().mockResolvedValue(access);
  vi.stubGlobal("navigator", { requestMIDIAccess: request });
  const callback = vi.fn();
  const source = new MtcSource(callback);
  sources.push(source);
  await source.start(input.id);
  return { input, controller, access, request, callback, source };
}

describe("MTC USB recovery", () => {
  it.each([true, false])("reacquires the selected port and drops partial frames, statechange=%s", async notify => {
    const { input, access, request, callback } = await fixture();
    cycle.slice(0, 4).forEach(value => input.send([0xf1, value]));
    access.disconnect(input, notify);
    if (!notify) vi.advanceTimersByTime(2_000);
    frame(input);
    expect(callback).not.toHaveBeenCalled();
    const replacement = new MidiInputFixture(input.id, input.name);
    access.connect(replacement, notify);
    if (!notify) vi.advanceTimersByTime(2_000);
    cycle.slice(4).forEach(value => replacement.send([0xf1, value]));
    expect(callback).not.toHaveBeenCalled();
    frame(replacement);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("recovers a changed ID only when the saved name and manufacturer are unique", async () => {
    const { input, access, callback } = await fixture();
    access.disconnect(input);
    const first = new MidiInputFixture("new-a", input.name);
    const second = new MidiInputFixture("new-b", input.name);
    access.connect(first, false);
    access.connect(second);
    frame(first); frame(second);
    expect(callback).not.toHaveBeenCalled();
    access.disconnect(second);
    frame(first);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("does not consume controller notes, CCs, or timecode from a different input", async () => {
    const { input, controller, callback } = await fixture();
    frame(controller);
    input.send([0x90, 60, 127]); input.send([0xb0, 7, 127]);
    expect(callback).not.toHaveBeenCalled();
    frame(input);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("leaves other listeners intact and releases its listeners and rescan on stop", async () => {
    const { input, access, source, callback } = await fixture();
    const other = vi.fn();
    input.addEventListener("midimessage", other);
    frame(input);
    expect(callback).toHaveBeenCalledTimes(1);
    source.stop();
    frame(input);
    access.disconnect(input); access.connect(input);
    frame(input);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(24);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not attach after stop while a permission request is pending", async () => {
    const { input, access, source, request, callback } = await fixture();
    let permit: ((value: MidiAccessFixture) => void) | undefined;
    request.mockImplementationOnce(() => new Promise(resolve => { permit = resolve; }));
    const opening = source.start(input.id);
    source.stop();
    permit?.(access);
    await opening;
    frame(input);
    expect(callback).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects malformed quarter frames and invalid SMPTE labels", async () => {
    const { input, callback } = await fixture();
    cycle.forEach(value => input.send([0xf1, value | 0x80]));
    cycle.forEach(value => input.send([0xf1, value, 0]));
    [15, 0x11, ...cycle.slice(2)].forEach(value => input.send([0xf1, value]));
    expect(callback).not.toHaveBeenCalled();
    frame(input);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
