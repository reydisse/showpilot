import { expect, it } from "vitest";
import type { AutomationEvent } from "@/types/timecode";
import { cueCountdown, deviceCueSummary, webhookCueSummary } from "./automation-summary";

const cue: AutomationEvent = {
  id: "cue", label: "Camera", action: "device-action", enabled: true, fired: false,
  triggerTimecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 }, triggerFrame: 30,
  toleranceFrames: 5, payload: {},
};
it("summarizes legacy routing and limits parameter detail without leaking credential fields", () => {
  const result = deviceCueSummary({ ...cue, payload: {
    targetDeviceId: "atem", targetActionId: "set_program_input", input: 2,
    password: "hidden-password", apiKey: "hidden-key", token: "hidden-token",
    callback: "https://user:password@example.com/private?secret=value", active: true, fourth: "extra",
  } }, { status: "ready", value: [{ id: "atem", label: "Stage switcher", enabled: true }] });
  expect(result).toEqual({ target: "Stage switcher", details: "set program input · input: 2 · callback: https://example.com · active: true · …" });
});
it("distinguishes loading, missing, disabled and implicit lighting targets", () => {
  const event = { ...cue, targetDeviceId: "missing" };
  expect(deviceCueSummary(event, { status: "loading" })?.target).toBe("Loading device name…");
  expect(deviceCueSummary(event, { status: "error", message: "unavailable" })?.target).toBe("Device name unavailable");
  expect(deviceCueSummary(event, { status: "ready", value: [{ id: "missing", label: "Console", enabled: false }] })?.target).toBe("Console (disabled)");
  expect(deviceCueSummary({ ...cue, action: "lighting-blackout" })).toEqual({ target: "Automatic lighting target", details: "Blackout" });
});
it("shows only the webhook origin and rejects malformed or insecure URLs", () => {
  expect(webhookCueSummary(cue)).toBeNull();
  expect(deviceCueSummary({ ...cue, action: "custom-webhook" })).toBeNull();
  expect(webhookCueSummary({ ...cue, action: "custom-webhook" })).toBe("Webhook URL missing");
  for (const url of ["oops", "http://example.com", "javascript:alert(1)"]) {
    expect(webhookCueSummary({ ...cue, action: "custom-webhook", payload: { url } })).toBe("Invalid webhook URL");
  }
  expect(webhookCueSummary({ ...cue, action: "custom-webhook", payload: { url: "https://name:password@example.com:8443/private?key=secret" } })).toBe("POST https://example.com:8443");
});
it("counts down in elapsed time at the actual frame rate, rounding up to a tenth", () => {
  const ndf = { frameRate: 30, dropFrame: "ndf" } as const;
  expect(cueCountdown(-1, ndf)).toBe("Due now");
  expect(cueCountdown(0, ndf)).toBe("Due now");
  expect(cueCountdown(1, ndf)).toBe("0.1s");
  expect(cueCountdown(45, ndf)).toBe("1.5s");
  expect(cueCountdown(1830, ndf)).toBe("1m 1.0s");
  expect(cueCountdown(109830, ndf)).toBe("1h 1m 1.0s");
  expect(cueCountdown(1800, { frameRate: 29.97, dropFrame: "df" })).toBe("1m 0.1s");
});

it("names the device captured for dispatch when a lighting target was resolved at source start", () => {
  expect(deviceCueSummary({ ...cue, action: "lighting-blackout", timingDeviceId: "resolved" }, { status: "ready", value: [{ id: "resolved", label: "Lighting console", enabled: true }] })).toEqual({ target: "Lighting console", details: "Blackout" });
});
