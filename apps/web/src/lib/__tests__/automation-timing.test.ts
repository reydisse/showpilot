import { describe, expect, it } from "vitest";
import {
  automationDispatchFrame,
  automationDeviceId,
  isValidTimingMs,
} from "../automation-timing";
import { nextAutomationEvent } from "../automation-cues";
import { cueBank } from "../midi-controller";
import { automationOutput } from "../automation-execution";
import type { AutomationEvent, TimecodeFormat } from "@/types/timecode";

describe("automation latency compensation", () => {
  it.each<TimecodeFormat>([
    { frameRate: 24, dropFrame: "ndf" },
    { frameRate: 25, dropFrame: "ndf" },
    { frameRate: 29.97, dropFrame: "df" },
    { frameRate: 30, dropFrame: "ndf" },
  ])(
    "adds lead and latency without moving the nominal cue at $frameRate fps",
    (format) => {
      const event = { triggerFrame: 300, leadMs: 100, deviceLatencyMs: 200 };
      expect(automationDispatchFrame(event, format)).toBe(
        300 - Math.ceil(0.3 * format.frameRate),
      );
      expect(event.triggerFrame).toBe(300);
      expect(
        automationDispatchFrame({ ...event, triggerFrame: 1 }, format),
      ).toBe(0);
      expect(automationDispatchFrame({ triggerFrame: 300 }, format)).toBe(300);
    },
  );
  it("rejects fractional, negative, non-finite and oversized timing values", () => {
    for (const value of [-1, 0.5, NaN, Infinity, 60001])
      expect(isValidTimingMs(value)).toBe(false);
    for (const value of [0, 1, 60000])
      expect(isValidTimingMs(value)).toBe(true);
  });
  it("uses the same device identity precedence as dispatch", () => {
    expect(
      automationDeviceId({
        targetDeviceId: " a ",
        payload: { deviceId: "b", targetDeviceId: "c" },
      }),
    ).toBe("a");
    expect(
      automationDeviceId({ payload: { deviceId: " b ", targetDeviceId: "c" } }),
    ).toBe("b");
    expect(automationDeviceId({ payload: { targetDeviceId: "c" } })).toBe("c");
  });
  it("serializes all aliases for the captured device on the same output", () => {
    const event: AutomationEvent = {
      id: "device",
      action: "device-action",
      label: "Device cue",
      payload: {},
      triggerFrame: 300,
      triggerTimecode: { hours: 0, minutes: 0, seconds: 10, frames: 0 },
      fired: false,
      enabled: true,
      toleranceFrames: 0,
    };
    const variants: AutomationEvent[] = [
      { ...event, targetDeviceId: " device-a " },
      { ...event, payload: { deviceId: "device-a" } },
      { ...event, payload: { targetDeviceId: "device-a" } },
      { ...event, action: "lighting-scene", timingDeviceId: "device-a" },
      { ...event, timingDeviceId: "device-a", targetDeviceId: "device-b" },
    ];
    expect(variants.map(automationOutput)).toEqual(
      Array(variants.length).fill("device:device-a"),
    );
  });
  it("keeps Next and MIDI slots in dispatch order, including zero-offset legacy cues", () => {
    const event = (
      id: string,
      triggerFrame: number,
      dispatchFrame?: number,
    ): AutomationEvent => ({
      id,
      triggerFrame,
      dispatchFrame,
      action: "lyrics-clear",
      label: id,
      payload: {},
      triggerTimecode: { hours: 0, minutes: 0, seconds: 10, frames: 0 },
      fired: false,
      enabled: true,
      toleranceFrames: 0,
    });
    const cues = [event("nominal first", 100), event("send first", 110, 80)];
    expect(nextAutomationEvent(cues, 79)?.id).toBe("send first");
    expect(nextAutomationEvent(cues, 90)?.id).toBe("nominal first");
    expect(cueBank(cues, 0).map((cue) => cue.id)).toEqual([
      "send first",
      "nominal first",
    ]);
  });
});
