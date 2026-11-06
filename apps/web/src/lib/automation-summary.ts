import type { AutomationEvent, TimecodeFormat } from "@/types/timecode";
import { automationDeviceId } from "./automation-timing";
import type { AutomationDeviceNames } from "./automation-catalog";

export const isDeviceCue = (event: AutomationEvent) => event.action === "device-action" || event.action === "lighting-scene" || event.action === "lighting-blackout";
const short = (value: string, limit = 60) => value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
const words = (value: string) => value.replace(/[-_]/g, " ");
const privateField = /password|secret|token|authorization|credential|api.?key/i;
const routingFields = new Set(["deviceId", "targetDeviceId", "actionId", "targetActionId"]);
function describeValue(value: unknown): string | null {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "string") return null;
  if (/^https?:\/\//i.test(value)) {
    try { return new URL(value).origin; } catch { return "Invalid URL"; }
  }
  return short(value.replace(/\s+/g, " "));
}

export function deviceCueSummary(event: AutomationEvent, names?: AutomationDeviceNames): { target: string; details: string } | null {
  if (!isDeviceCue(event)) return null;
  const deviceId = event.timingDeviceId ?? automationDeviceId(event);
  const device = names?.status === "ready" ? names.value.find(device => device.id === deviceId) : null;
  const target = device ? `${device.label}${device.enabled ? "" : " (disabled)"}`
    : names?.status === "loading" ? "Loading device name…"
    : deviceId ? "Device name unavailable" : "Automatic lighting target";
  const actionId = event.targetActionId ?? event.payload.actionId ?? event.payload.targetActionId;
  const action = event.action === "lighting-blackout" ? "Blackout" : typeof actionId === "string" ? words(actionId) : event.action === "lighting-scene" ? "Recall scene" : "Action not selected";
  const raw = event.payload.params;
  const params = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : event.payload;
  const fields = Object.entries(params).filter(([key]) => !routingFields.has(key) && !privateField.test(key))
    .flatMap(([key, value]) => { const text = describeValue(value); return text === null ? [] : [`${words(key)}: ${text}`]; });
  const summary = fields.slice(0, 3).join(" · ");
  return { target, details: `${short(action)}${summary ? ` · ${summary}` : ""}${fields.length > 3 ? " · …" : ""}` };
}

export function webhookCueSummary(event: AutomationEvent): string | null {
  if (event.action !== "custom-webhook") return null;
  if (typeof event.payload.url !== "string") return "Webhook URL missing";
  try {
    const url = new URL(event.payload.url);
    return url.protocol === "https:" ? `POST ${url.origin}` : "Invalid webhook URL";
  } catch { return "Invalid webhook URL"; }
}

/** Remaining time is based on dispatch frames, including cue lead and device latency. */
export function cueCountdown(frames: number, format: TimecodeFormat): string {
  if (frames <= 0) return "Due now";
  const tenths = Math.ceil(frames * 10 / format.frameRate);
  const hours = Math.floor(tenths / 36000);
  const minutes = Math.floor(tenths / 600) % 60;
  const seconds = (tenths % 600) / 10;
  return `${hours ? `${hours}h ` : ""}${minutes || hours ? `${minutes}m ` : ""}${seconds.toFixed(1)}s`;
}
