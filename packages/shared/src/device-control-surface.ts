export type DeviceControlSurfaceKind =
  | "switcher"
  | "mixer"
  | "display"
  | "streaming"
  | "lighting"
  | "automation"
  | "generic";

const SURFACE_SIGNATURES = [
  { kind: "mixer", required: ["set_channel_fader", "mute_channel"] },
  { kind: "switcher", required: ["set_program_input", "set_preview_input"] },
  { kind: "display", required: ["power_on", "power_off"] },
  { kind: "streaming", required: ["start_streaming", "stop_streaming"] },
  { kind: "lighting", required: ["blackout", "restore"] },
] satisfies Array<{
  kind: Exclude<DeviceControlSurfaceKind, "automation" | "generic">;
  required: string[];
}>;

export function resolveDeviceControlSurface(
  actions: Array<{ id: string }>,
  category: string,
): DeviceControlSurfaceKind {
  const actionIds = new Set(actions.map((action) => action.id));
  for (const signature of SURFACE_SIGNATURES) {
    if (signature.required.every((actionId) => actionIds.has(actionId))) return signature.kind;
  }
  return category === "automation" ? "automation" : "generic";
}

export function parseNumberArrayFeedback(value: unknown): Array<number | null> {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((candidate) => typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null);
  } catch {
    return [];
  }
}

export function parseBooleanArrayFeedback(value: unknown): Array<boolean | null> {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((candidate) => typeof candidate === "boolean" ? candidate : null);
  } catch {
    return [];
  }
}

export function parseStringArrayFeedback(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
  } catch {
    return [];
  }
}
