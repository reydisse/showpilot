import { expect, it } from "vitest";
import {
  compareAutomationCues, cueTimingStatus, nextAutomationEvent, orderedAutomationEvents,
  scheduledDispatchFrame, cueCountdown, deviceCueSummary, webhookCueSummary,
} from "@showpilot/shared";
import { parseMobileTimecodeEvent, type MobileTimecodeEvent } from "../../../../mobile/src/lib/timecode-contract";

const cue = (id: string, patch: Partial<MobileTimecodeEvent> = {}): MobileTimecodeEvent => ({
  id, label: id, action: "lyrics-clear", enabled: true, fired: false, skipped: false,
  payload: {}, triggerFrame: 300, triggerTimecode: { hours: 0, minutes: 0, seconds: 10, frames: 0 }, ...patch,
});
it("retains canonical dispatch timing in native hydration and computes Next from it", () => {
  const saved = cue("early send", { dispatchFrame: 270, deviceLatencyMs: 500, leadMs: 500, timingDeviceId: "captured-device" });
  const parsed = parseMobileTimecodeEvent(saved);
  expect(parsed).toMatchObject({ dispatchFrame: 270, deviceLatencyMs: 500, leadMs: 500, timingDeviceId: "captured-device" });
  expect(nextAutomationEvent([cue("earlier nominal", { triggerFrame: 280 }), parsed!], 260)?.id).toBe("early send");
  expect(cueCountdown(scheduledDispatchFrame(parsed!) - 260, { frameRate: 25, dropFrame: "ndf" })).toBe("0.4s");
});
it("sorts a copy by nominal cue time without reordering the relay snapshot", () => {
  const list = Object.freeze([cue("later", { triggerFrame: 400, dispatchFrame: 250 }), cue("earlier")]);
  const sorted = orderedAutomationEvents(list);
  expect(sorted.map(cue => cue.id)).toEqual(["earlier", "later"]);
  expect(list.map(cue => cue.id)).toEqual(["later", "earlier"]);
  expect(nextAutomationEvent(list, 0)?.id).toBe("later");
});
it("uses control priority for ties and preserves stable ordering of ordinary cues", () => {
  const list = [cue("output"), cue("disable", { action: "triggers-disable" }), cue("enable", { action: "triggers-enable" }), cue("second output")];
  expect(orderedAutomationEvents(list).map(cue => cue.id)).toEqual(["enable", "disable", "output", "second output"]);
  expect(nextAutomationEvent(list, 300)?.id).toBe("enable");
  expect(compareAutomationCues(cue("a"), cue("b"))).toBe(0);
});
it.each([
  { fired: true }, { enabled: false }, { skipped: true },
  { executionStatus: "failed" as const }, { executionStatus: "dispatching" as const },
])("does not relabel unavailable cues as missed or Next: %j", patch => {
  const event = cue("unavailable", patch);
  expect(cueTimingStatus(event, 999)).toBeNull();
  expect(nextAutomationEvent([event], 0)).toBeUndefined();
});
it.each([
  [269, "upcoming"], [270, "upcoming"], [271, "overdue"], [275, "overdue"], [276, "missed"],
])("classifies the dispatch boundary at frame %s as %s", (frame, expected) => {
  expect(cueTimingStatus(cue("early", { dispatchFrame: 270, toleranceFrames: 5 }), Number(frame))).toBe(expected);
});
it("supports legacy zero-offset cues and zero tolerance without inventing lead", () => {
  expect(scheduledDispatchFrame(cue("legacy"))).toBe(300);
  expect(cueTimingStatus(cue("legacy"), 305)).toBe("overdue");
  expect(cueTimingStatus(cue("legacy"), 306)).toBe("missed");
  expect(cueTimingStatus(cue("strict", { toleranceFrames: 0 }), 301)).toBe("missed");
  expect(scheduledDispatchFrame(cue("start", { dispatchFrame: 0 }))).toBe(0);
});
it("does not require a running clock to select a due or future cue", () => {
  expect(nextAutomationEvent([cue("future"), cue("past", { triggerFrame: 20 })], 25)?.id).toBe("future");
  expect(nextAutomationEvent([cue("due")], 300)?.id).toBe("due");
  expect(nextAutomationEvent([cue("past")], 301)).toBeUndefined();
  expect(nextAutomationEvent([], 0)).toBeUndefined();
});
it("preserves future native action data and legacy routing for readable summaries", () => {
  const parsed = parseMobileTimecodeEvent(cue("device", { action: "device-action", timingDeviceId: "resolved", targetDeviceId: "other", payload: {
    targetActionId: "set_program_input", input: 2, apiKey: "must-not-appear", authorization: "must-not-appear",
  } }));
  expect(deviceCueSummary(parsed!, { status: "ready", value: [{ id: "resolved", label: "Stage switcher", enabled: false }] })).toEqual({ target: "Stage switcher (disabled)", details: "set program input · input: 2" });
  expect(webhookCueSummary(cue("hook", { action: "custom-webhook", payload: { url: "https://user:secret@example.com/private?token=hidden" } }))).toBe("POST https://example.com");
  expect(parseMobileTimecodeEvent(cue("future", { action: "future-action" }))?.action).toBe("future-action");
});
it.each([{ dispatchFrame: -1 }, { dispatchFrame: 1.5 }, { deviceLatencyMs: -1 }, { timingDeviceId: 12 }])("rejects malformed native timing metadata: %j", patch => {
  expect(parseMobileTimecodeEvent({ ...cue("bad"), ...patch })).toBeNull();
});
