import { AUTOMATION_ACTIONS, isSafeAutomationWebhookUrl } from "@showpilot/shared";
export type CueField = { key: string; label: string; kind?: "multiline" | "number" | "duration" | "seconds" | "percent"; optional?: boolean; maxLength?: number; min?: number; max?: number; default?: string };
export function cueFields(action: string, payload: Record<string, unknown>): CueField[] {
  if (action === "stage-message" || action === "crew-message") return [{ key: "message", label: action === "stage-message" ? "Stage message" : "Crew message", kind: "multiline", maxLength: action === "crew-message" ? 4000 : 2000 }];
  if (action === "rundown-adjust") return [{ key: "deltaMs", label: "Seconds to add or subtract", kind: "seconds", min: -86400, max: 86400, default: "30" }];
  if (action === "timer-start" || action === "timer-stop") return [{ key: "name", label: "Timer name", maxLength: 80 },
    ...(action === "timer-start" ? [{ key: "durationMs", label: "Duration (m:ss)", kind: "duration" as const, default: "5:00" }] : [])];
  if (action === "media-play" || action === "media-stop") return [{ key: "output", label: "Media output", maxLength: 80, default: "Program" },
    ...(action === "media-play" ? [{ key: "volume", label: "Volume (%)", kind: "percent" as const, min: 0, max: 100, default: "100" }] : [])];
  if (action.startsWith("pp-")) return [...(action === "pp-trigger-prop" ? [{ key: "propName", label: "Prop name", maxLength: 200 }] : []),
    { key: "target", label: "ProPresenter target (optional)", optional: true, maxLength: 300 }];
  if (action === "custom-webhook") return [{ key: "url", label: "Webhook URL", maxLength: 2048 }];
  if (action === "lower-third-show") {
    const kind = payload.type ?? "freetext";
    return kind === "person" ? [{ key: "name", label: "Person name" }, { key: "title", label: "Person title (optional)", optional: true }]
      : kind === "scripture" ? [{ key: "scripture", label: "Scripture text", kind: "multiline", maxLength: 10000 }, { key: "translation", label: "Translation (optional)", optional: true }]
      : kind === "style" ? [] : [{ key: "line1", label: "First line" }, { key: "line2", label: "Second line (optional)", optional: true }];
  }
  return [];
}
export function cueFieldText(field: CueField, value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    if (field.kind === "duration") return `${Math.floor(value / 60000)}:${String(value / 1000 % 60).padStart(2, "0")}`;
    return String(field.kind === "seconds" ? value / 1000 : field.kind === "percent" ? value * 100 : value);
  }
  return field.default ?? "";
}
export function structuredCuePayload(action: string, source: Record<string, unknown>): Record<string, unknown> {
  if (!AUTOMATION_ACTIONS.some(option => option.value === action)) throw new Error("Choose a supported cue action.");
  const payload = { ...source };
  for (const field of cueFields(action, source)) {
    const text = cueFieldText(field, source[field.key]).trim();
    if (field.optional && !text) { delete payload[field.key]; continue; }
    if (!text) throw new Error(`${field.label} is required.`);
    if (field.kind === "duration") {
      const match = /^(\d{1,4}):([0-5]\d)$/.exec(text);
      const ms = match ? (Number(match[1]) * 60 + Number(match[2])) * 1000 : 0;
      if (ms < 1000 || ms > 86400000) throw new Error("Enter a duration from 0:01 to 1440:00.");
      payload[field.key] = ms;
    } else if (field.kind === "number" || field.kind === "seconds" || field.kind === "percent") {
      const number = Number(text);
      if (!/^[+-]?(?:\d+(?:\.\d{0,3})?|\.\d{1,3})$/.test(text) || !Number.isFinite(number) || number < (field.min ?? 0) || number > (field.max ?? Infinity))
        throw new Error(`${field.label} must be between ${field.min ?? 0} and ${field.max}.`);
      payload[field.key] = field.kind === "seconds" ? Math.round(number * 1000) : field.kind === "percent" ? number / 100 : number;
    } else {
      if (text.length > (field.maxLength ?? 2000)) throw new Error(`${field.label} is too long.`);
      payload[field.key] = text;
    }
  }
  if (action.startsWith("pp-") && typeof payload.target === "string" && !payload.target.startsWith("propresenter:")) throw new Error("Enter a connected ProPresenter target address, or leave it blank.");
  if (action === "timer-start" || action === "timer-stop" || action === "media-play" || action === "media-stop") {
    const key = action.startsWith("timer-") ? "name" : "output";
    if (typeof payload[key] === "string") {
      if (/[\u0000-\u001f\u007f]/u.test(payload[key])) throw new Error("Names cannot contain control characters.");
      payload[key] = payload[key].normalize("NFC");
    }
  }
  if (action === "custom-webhook" && !isSafeAutomationWebhookUrl(payload.url)) throw new Error("Enter a public HTTPS webhook URL without credentials or a custom port.");
  if (action === "lower-third-show") { payload.type ??= "freetext"; payload.style ??= "default"; }
  const required = action === "rundown-goto-item" || action === "rundown-start-item" ? ["itemId"]
    : action === "device-action" || action === "lighting-scene" ? ["deviceId", "actionId"]
    : action === "lighting-blackout" ? ["deviceId"] : action === "lyrics-goto" ? ["songId", "sectionId", "lyrics"]
    : action === "media-play" ? ["mediaId", "etag"] : action === "pp-trigger-slide" ? ["presentationUuid"] : [];
  if (required.some(key => typeof payload[key] !== "string" || !String(payload[key]).trim())) throw new Error("Choose the action's target and complete its required fields.");
  if (action === "pp-trigger-slide" && (!Number.isSafeInteger(payload.slideIndex) || Number(payload.slideIndex) < 0)) throw new Error("Choose a mapped ProPresenter section.");
  return payload;
}

/** Older device cues store parameters alongside routing keys. */
export function cueDeviceParams(payload: Record<string, unknown>): Record<string, unknown> {
  const source = payload.params;
  return source && typeof source === "object" && !Array.isArray(source) ? Object.fromEntries(Object.entries(source))
    : Object.fromEntries(Object.entries(payload).filter(([key]) => !["deviceId", "targetDeviceId", "actionId", "targetActionId"].includes(key)));
}
