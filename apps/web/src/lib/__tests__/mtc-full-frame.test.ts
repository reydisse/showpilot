import { afterEach, describe, expect, it, vi } from "vitest";
import { MtcSource } from "../timecode-sources/mtc-source";

import { MidiAccessFixture, MidiInputFixture } from "@/test/midi-fixture";

const sources: MtcSource[] = [];
afterEach(() => {
  sources.splice(0).forEach(source => source.stop());
  vi.unstubAllGlobals();
});

async function receiver() {
  const input = new MidiInputFixture("fixture-midi");
  const request = vi.fn().mockResolvedValue(new MidiAccessFixture(input));
  vi.stubGlobal("navigator", { requestMIDIAccess: request });
  const callback = vi.fn();
  const source = new MtcSource(callback);
  sources.push(source);
  await source.start(input.id);
  return { callback, source, request, input, send: (bytes: number[]) => input.send(bytes) };
}

// Synthetic parser fixtures, not evidence that unprivileged Web MIDI delivers SysEx.
const frame = [0xf0, 0x7f, 0x7f, 1, 1, 0x61, 2, 3, 4, 0xf7];

describe("MTC full-frame boundary", () => {
  it.each([
    [0, 24, "ndf"], [1, 25, "ndf"], [2, 29.97, "df"], [3, 30, "ndf"],
  ] as const)("decodes rate code %i without changing SMPTE format", async (rate, frameRate, dropFrame) => {
    const { send, callback } = await receiver();
    send([...frame.slice(0, 5), (rate << 5) | 1, 2, 3, 4, 0xf7]);
    expect(callback).toHaveBeenCalledExactlyOnceWith({ hours: 1, minutes: 2, seconds: 3, frames: 4 }, { frameRate, dropFrame });
  });

  it.each([
    ["another device", 2, 0x01], ["invalid device byte", 2, 0x80],
    ["hour overflow", 5, 0x78], ["hour status bit", 5, 0xe1],
    ["minute overflow", 6, 60], ["minute status bit", 6, 0x82],
    ["second overflow", 7, 60], ["second status bit", 7, 0x83],
    ["frame overflow", 8, 30], ["frame status bit", 8, 0x84],
    ["missing terminator", 9, 0],
  ] as const)("ignores %s", async (_name, index, value) => {
    const { send, callback } = await receiver();
    const bytes = [...frame]; bytes[index] = value;
    send(bytes);
    expect(callback).not.toHaveBeenCalled();
  });

  it("rejects truncated and overlong messages", async () => {
    const { send, callback } = await receiver();
    send(frame.slice(0, 9)); send([...frame, 0]);
    expect(callback).not.toHaveBeenCalled();
  });

  it("rejects frame labels outside their rate, including skipped drop-frame labels", async () => {
    const { send, callback } = await receiver();
    for (const bytes of [[0x01, 2, 3, 24], [0x21, 2, 3, 25], [0x41, 1, 0, 0], [0x41, 1, 0, 1]]) {
      send([0xf0, 0x7f, 0x7f, 1, 1, ...bytes, 0xf7]);
    }
    expect(callback).not.toHaveBeenCalled();
    send([0xf0, 0x7f, 0x7f, 1, 1, 0x41, 1, 0, 2, 0xf7]);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("discards partial quarter frames on a full-frame relocation", async () => {
    const { send, callback } = await receiver();
    const pieces = [0x00, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x76];
    pieces.slice(0, 4).forEach(value => send([0xf1, value]));
    send(frame);
    pieces.slice(4).forEach(value => send([0xf1, value]));
    expect(callback).toHaveBeenCalledTimes(1);
    pieces.slice(0, 4).forEach(value => send([0xf1, value]));
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("keeps browser permission requests limited to quarter-frame MIDI", async () => {
    const { request, input, source, callback } = await receiver();
    expect(await MtcSource.getInputs()).toEqual([input]);
    expect(request.mock.calls).toEqual([[], []]);
    source.stop();
    input.send(frame);
    expect(callback).not.toHaveBeenCalled();
  });
});
