import { afterEach, expect, it, vi } from "vitest";
import { MtcSource } from "../timecode-sources/mtc-source";
import { MidiAccessFixture, MidiInputFixture } from "@/test/midi-fixture";

const sources: MtcSource[] = [];
afterEach(() => { sources.splice(0).forEach(source => source.stop()); vi.unstubAllGlobals(); });
async function fixture(options?: { sysex: boolean }) {
  const input = new MidiInputFixture("daw");
  const access = new MidiAccessFixture(input);
  const request = vi.fn().mockResolvedValue(access);
  vi.stubGlobal("navigator", { requestMIDIAccess: request });
  const frame = vi.fn(); const transport = vi.fn();
  const source = new MtcSource(frame, transport); sources.push(source);
  await source.start(input.id, options);
  const cycle = (frames: number) => [frames & 15, frames >> 4, 0, 0, 0, 0, 0, 6].forEach((value, index) => input.send([0xf1, (index << 4) | value]));
  const full = (frames: number) => input.send([0xf0, 0x7f, 0x7f, 1, 1, 0x60, 0, 0, frames, 0xf7]);
  return { input, access, request, frame, transport, source, cycle, full };
}

it("Stop holds immediately; Continue waits for position and valid MTC, including after USB reconnect", async () => {
  const { input, access, frame, transport, cycle } = await fixture();
  cycle(1); input.send([0xfc]); cycle(2);
  expect(transport).toHaveBeenLastCalledWith("stopped");
  expect(frame).toHaveBeenCalledTimes(1);
  access.disconnect(input); access.connect(input); cycle(3);
  expect(frame).toHaveBeenCalledTimes(1);
  input.send([0xfb]); cycle(4); input.send([0xf8]);
  expect(transport).toHaveBeenLastCalledWith("waiting");
  expect(frame).toHaveBeenCalledTimes(1);
  input.send([0xf2, 3, 0]); input.send([0xf8]); cycle(5);
  expect(frame).toHaveBeenCalledTimes(2);
  expect(frame).toHaveBeenLastCalledWith({ hours: 0, minutes: 0, seconds: 0, frames: 5 }, { frameRate: 30, dropFrame: "ndf" });
});

it("Start implies song position zero but Clock never fabricates an absolute timestamp", async () => {
  const { input, frame, transport, cycle } = await fixture();
  input.send([0xfa]);
  for (let i = 0; i < 24; i++) input.send([0xf8]);
  expect(transport).toHaveBeenCalledExactlyOnceWith("waiting");
  expect(frame).not.toHaveBeenCalled();
  cycle(0);
  expect(frame).toHaveBeenCalledTimes(1);
});

it("deduplicates static timestamps so repeated quarter cycles cannot mask a stopped clock", async () => {
  const { cycle, full, frame } = await fixture();
  for (let i = 0; i < 20; i++) cycle(1);
  full(1);
  expect(frame).toHaveBeenCalledTimes(1);
  cycle(2); cycle(1);
  expect(frame).toHaveBeenCalledTimes(3);
});

it("full frame can locate during Stop without firing, then Continue accepts fresh quarter frames", async () => {
  const { input, cycle, full, frame } = await fixture();
  input.send([0xfc]); full(7);
  expect(frame).not.toHaveBeenCalled();
  input.send([0xfb]); cycle(7);
  expect(frame).toHaveBeenCalledTimes(1);
  input.send([0xfc]); input.send([0xfb]); full(8);
  expect(frame).toHaveBeenCalledTimes(2);
});

it("invalid or directed position messages never release the resync hold", async () => {
  const { input, cycle, frame, transport } = await fixture();
  input.send([0xfb]);
  for (const bytes of [[0xf2, 128, 0], [0xf2, 0], [0xfa, 0], [0xf0, 0x7f, 1, 1, 1, 0x60, 0, 0, 1, 0xf7], [0xf0, 0x7f, 0x7f, 1, 1, 0x40, 1, 0, 0, 0xf7]]) input.send(bytes);
  cycle(3);
  expect(frame).not.toHaveBeenCalled();
  expect(transport).toHaveBeenCalledTimes(1);
});

it("requests SysEx only when the operator opts into full-frame sync", async () => {
  const unprivileged = await fixture();
  expect(unprivileged.request).toHaveBeenCalledExactlyOnceWith();
  const fullFrame = await fixture({ sysex: true });
  expect(fullFrame.request).toHaveBeenCalledExactlyOnceWith({ sysex: true });
});
