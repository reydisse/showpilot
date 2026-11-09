import { automationDeviceId } from "@showpilot/shared";
import type { AutomationEvent, TimecodeFormat } from "@/types/timecode";

export const MAX_AUTOMATION_LEAD_MS = 60_000;
export const MAX_DEVICE_LATENCY_MS = 60_000;

export function isValidTimingMs(
  value: number,
  maximum = MAX_AUTOMATION_LEAD_MS,
): boolean {
  return Number.isInteger(value) && value >= 0 && value <= maximum;
}

/** Device latency and cue lead both send early. Never wrap before show start. */
export function automationDispatchFrame(
  event: Pick<AutomationEvent, "triggerFrame" | "leadMs" | "deviceLatencyMs">,
  format: TimecodeFormat,
): number {
  const advanceFrames = Math.ceil(
    (((event.leadMs ?? 0) + (event.deviceLatencyMs ?? 0)) * format.frameRate) /
      1_000,
  );
  return Math.max(0, event.triggerFrame - advanceFrames);
}

export interface DeviceTiming {
  id: string;
  category: string;
  latencyMs: number;
}

export function deviceTimingForEvent(
  event: AutomationEvent,
  devices: readonly DeviceTiming[],
): DeviceTiming | undefined {
  if (event.action !== "device-action" && event.action !== "lighting-scene" && event.action !== "lighting-blackout")
    return undefined;
  const id = automationDeviceId(event);
  if (id) return devices.find((device) => device.id === id);
  const lighting = devices.filter((device) => device.category === "lighting");
  return (event.action === "lighting-scene" || event.action === "lighting-blackout") && lighting.length === 1
    ? lighting[0]
    : undefined;
}
