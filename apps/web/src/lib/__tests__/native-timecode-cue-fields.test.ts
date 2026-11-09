import { expect, it } from "vitest";
import { AUTOMATION_ACTIONS } from "@showpilot/shared";
import { cueFieldText, structuredCuePayload, cueDeviceParams } from "../../../../mobile/src/lib/timecode-cue-fields";
import { prepareCueCreation } from "../../../../mobile/src/lib/timecode-cue-recovery";
import { draftCueEdit, prepareCueEdit } from "../../../../mobile/src/lib/timecode-cue-edit-recovery";
const examples: Record<string, Record<string, unknown>> = {
  "stage-message": { message: "Stand by\nCameras" }, "crew-message": { message: "Ready" }, "rundown-adjust": { deltaMs: "-30.125" },
  "timer-start": { name: "Speaker", durationMs: "5:00" }, "timer-stop": { name: "Speaker" }, "media-play": { output: "Program", mediaId: "abcdefghijklmnop", etag: "version", volume: "75" }, "media-stop": { output: "Program" },
  "lower-third-show": { line1: "Welcome" }, "rundown-start-item": { itemId: "item" }, "rundown-goto-item": { itemId: "item" },
  "device-action": { deviceId: "device", actionId: "mute", params: { mute: true } }, "lighting-scene": { deviceId: "light", actionId: "recall_scene", params: { scene: 2 } }, "lighting-blackout": { deviceId: "light" },
  "lyrics-goto": { songId: "song", sectionId: "verse", lyrics: "Line one\nLine two" }, "pp-trigger-slide": { presentationUuid: "presentation", slideIndex: 0 },
  "pp-trigger-prop": { propName: "Logo" }, "custom-webhook": { url: "https://hooks.example.com/show" },
};
it.each(AUTOMATION_ACTIONS)("provides structured details for $value", ({ value }) => {
  expect(() => structuredCuePayload(value, examples[value] ?? {})).not.toThrow();
});
it("converts operator units without changing already saved numeric values", () => {
  expect(structuredCuePayload("rundown-adjust", examples["rundown-adjust"])).toEqual({ deltaMs: -30125 });
  expect(structuredCuePayload("rundown-adjust", { deltaMs: -30125 })).toEqual({ deltaMs: -30125 });
  expect(structuredCuePayload("timer-start", examples["timer-start"])).toEqual({ name: "Speaker", durationMs: 300000 });
  expect(structuredCuePayload("media-play", examples["media-play"])).toMatchObject({ volume: 0.75 });
  expect(cueFieldText({ key: "durationMs", label: "Duration", kind: "duration" }, 300000)).toBe("5:00");
});
it.each(["", "00:00", "4:99", "1440:01", "-1:00"])("rejects invalid duration %s", durationMs => {
  expect(() => structuredCuePayload("timer-start", { name: "Speaker", durationMs })).toThrow();
});
it.each(["http://example.com", "https://localhost", "https://10.0.0.1", "https://user:secret@example.com"])("retains the webhook destination boundary for %s", url => {
  expect(() => structuredCuePayload("custom-webhook", { url })).toThrow(/public HTTPS/);
});
it("requires mapped lyrics, device, media and rundown targets", () => {
  for (const action of ["lyrics-goto", "pp-trigger-slide", "device-action", "lighting-blackout", "rundown-goto-item", "media-play"])
    expect(() => structuredCuePayload(action, {})).toThrow();
});
const scope = { orgId: "org", userId: "user", showId: "show", serviceDate: "2026-11-08", requestId: "a13a0e94-843a-414b-87ba-e2615d56f28c" };
it("validates lead, tolerance and timecode before creating a cue", () => {
  const draft = { showId: "show", label: "Cue", action: "lyrics-clear", payload: "{}", timecode: "00:01:00;02", format: { frameRate: 29.97 as const, dropFrame: "df" as const }, lead: "60000", tolerance: "9000" };
  expect(prepareCueCreation(scope, draft).event).toMatchObject({ leadMs: 60000, toleranceFrames: 9000 });
  for (const patch of [{ lead: "60001" }, { lead: "-1" }, { tolerance: "1.5" }, { tolerance: "" }, { timecode: "00:01:00;00" }])
    expect(() => prepareCueCreation(scope, { ...draft, ...patch })).toThrow();
});
it("metadata-only edits preserve unsupported action data and route aliases", () => {
  const draft = draftCueEdit("show", { id: "cue", label: "Future cue", action: "future-action", payload: { future: true }, fired: true, skipped: false, enabled: true,
    triggerTimecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 }, triggerFrame: 30, targetDeviceId: "saved-device" }, { frameRate: 30, dropFrame: "ndf" });
  expect(prepareCueEdit(scope, draft).updates).not.toHaveProperty("payload");
  expect(JSON.parse(draft.definition.payload)).toMatchObject({ deviceId: "saved-device", future: true });
});

it("reads legacy device fields without silently replacing them with catalog defaults", () => {
  expect(cueDeviceParams({ deviceId: "switcher", actionId: "set_program_input", input: 7 })).toEqual({ input: 7 });
  expect(cueDeviceParams({ deviceId: "switcher", input: 7, params: { input: 2 } })).toEqual({ input: 2 });
});

it("matches crew, output-name and ProPresenter limits", () => {
  expect(structuredCuePayload("crew-message", { message: "a".repeat(4000) })).toHaveProperty("message.length", 4000);
  expect(() => structuredCuePayload("crew-message", { message: "a".repeat(4001) })).toThrow();
  expect(() => structuredCuePayload("timer-stop", { name: "Speaker\nTimer" })).toThrow(/control/);
  expect(() => structuredCuePayload("pp-trigger-next", { target: "wrong-target" })).toThrow(/ProPresenter/);
});
