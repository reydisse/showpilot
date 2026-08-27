export const RUNDOWN_ITEM_TYPES = [
  "segment",
  "song",
  "header",
  "prayer",
  "announcement",
  "offering",
  "custom",
] as const;

export type RelayItemType = (typeof RUNDOWN_ITEM_TYPES)[number];
export type RelayItemStatus = "upcoming" | "live" | "complete";

export interface RelayRundownItem {
  id: string;
  title: string;
  type: RelayItemType;
  duration: number;
  notes: string;
  assignee: string;
  cue: string;
  status: RelayItemStatus;
  sortOrder: number;
  hardStop: boolean;
  lowerThirdId?: string;
  scheduledStart?: string | null;
  expectedEnd?: string | null;
  actualStart?: string | null;
  actualEnd?: string | null;
}

export interface RelayTimerState {
  playback: "stop" | "play" | "pause";
  currentItemId: string | null;
  elapsed: number;
  startedAt: number | null;
  pausedAt: number | null;
  mode: "count-up" | "count-down" | "clock";
}

export interface RelayPPSlide {
  text: string;
  notes: string;
  presentationName: string;
  isScripture: boolean;
}

export type RelayItemUpdates = Pick<
  RelayRundownItem,
  | "title"
  | "type"
  | "duration"
  | "notes"
  | "assignee"
  | "cue"
  | "hardStop"
  | "lowerThirdId"
  | "scheduledStart"
  | "expectedEnd"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum;
}

function isId(value: unknown): value is string {
  return isBoundedString(value, 128) && value.trim().length > 0;
}

function optionalTimestamp(value: unknown): string | null | undefined | false {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return isBoundedString(value, 64) ? value : false;
}

function isItemType(value: unknown): value is RelayItemType {
  return typeof value === "string"
    && (RUNDOWN_ITEM_TYPES as readonly string[]).includes(value);
}

function isItemStatus(value: unknown): value is RelayItemStatus {
  return value === "upcoming" || value === "live" || value === "complete";
}

function isDuration(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= 7 * 24 * 60 * 60 * 1_000;
}

export function parseRelayRundownItem(value: unknown, sortOrder: number): RelayRundownItem | null {
  if (!isRecord(value)) return null;
  if (
    !isId(value.id)
    || !isBoundedString(value.title, 500)
    || !isItemType(value.type)
    || !isDuration(value.duration)
    || !isBoundedString(value.notes, 20_000)
    || !isBoundedString(value.assignee, 500)
    || !isBoundedString(value.cue, 2_000)
    || !isItemStatus(value.status)
    || typeof value.hardStop !== "boolean"
  ) return null;

  const lowerThirdId = value.lowerThirdId === undefined
    ? undefined
    : isBoundedString(value.lowerThirdId, 128)
      ? value.lowerThirdId
      : false;
  const scheduledStart = optionalTimestamp(value.scheduledStart);
  const expectedEnd = optionalTimestamp(value.expectedEnd);
  const actualStart = optionalTimestamp(value.actualStart);
  const actualEnd = optionalTimestamp(value.actualEnd);
  if (
    lowerThirdId === false
    || scheduledStart === false
    || expectedEnd === false
    || actualStart === false
    || actualEnd === false
  ) return null;

  return {
    id: value.id,
    title: value.title,
    type: value.type,
    duration: value.duration,
    notes: value.notes,
    assignee: value.assignee,
    cue: value.cue,
    status: value.status,
    sortOrder,
    hardStop: value.hardStop,
    ...(lowerThirdId === undefined ? {} : { lowerThirdId }),
    ...(scheduledStart === undefined ? {} : { scheduledStart }),
    ...(expectedEnd === undefined ? {} : { expectedEnd }),
    ...(actualStart === undefined ? {} : { actualStart }),
    ...(actualEnd === undefined ? {} : { actualEnd }),
  };
}

export function parseRelayRundownItems(value: unknown): RelayRundownItem[] | null {
  if (!Array.isArray(value) || value.length > 500) return null;
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 1_500_000) return null;
  const parsed = value.map((item, index) => parseRelayRundownItem(item, index));
  if (parsed.some((item) => item === null)) return null;
  const items = parsed as RelayRundownItem[];
  if (new Set(items.map((item) => item.id)).size !== items.length) return null;
  return items;
}

export function parseRelayTimer(value: unknown): RelayTimerState | null {
  if (!isRecord(value)) return null;
  if (
    value.playback !== "stop" && value.playback !== "play" && value.playback !== "pause"
    || value.currentItemId !== null && !isId(value.currentItemId)
    || typeof value.elapsed !== "number" || !Number.isFinite(value.elapsed)
    || value.startedAt !== null && (typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt))
    || value.pausedAt !== null && (typeof value.pausedAt !== "number" || !Number.isFinite(value.pausedAt))
    || value.mode !== "count-up" && value.mode !== "count-down" && value.mode !== "clock"
  ) return null;
  return {
    playback: value.playback,
    currentItemId: value.currentItemId,
    elapsed: value.elapsed,
    startedAt: value.startedAt,
    pausedAt: value.pausedAt,
    mode: value.mode,
  };
}

export function parseRelayPPSlide(value: unknown): RelayPPSlide | null {
  if (!isRecord(value)) return null;
  if (
    !isBoundedString(value.text, 20_000)
    || !isBoundedString(value.notes, 20_000)
    || !isBoundedString(value.presentationName, 500)
    || typeof value.isScripture !== "boolean"
  ) return null;
  return {
    text: value.text,
    notes: value.notes,
    presentationName: value.presentationName,
    isScripture: value.isScripture,
  };
}

export function parseRelayItemUpdates(value: unknown): Partial<RelayItemUpdates> | null {
  if (!isRecord(value)) return null;
  const updates: Partial<RelayItemUpdates> = {};
  if ("title" in value) {
    if (!isBoundedString(value.title, 500)) return null;
    updates.title = value.title;
  }
  if ("type" in value) {
    if (!isItemType(value.type)) return null;
    updates.type = value.type;
  }
  if ("duration" in value) {
    if (!isDuration(value.duration)) return null;
    updates.duration = value.duration;
  }
  for (const [key, maximum] of [["notes", 20_000], ["assignee", 500], ["cue", 2_000]] as const) {
    if (key in value) {
      if (!isBoundedString(value[key], maximum)) return null;
      updates[key] = value[key];
    }
  }
  if ("hardStop" in value) {
    if (typeof value.hardStop !== "boolean") return null;
    updates.hardStop = value.hardStop;
  }
  if ("lowerThirdId" in value) {
    if (value.lowerThirdId !== undefined && !isBoundedString(value.lowerThirdId, 128)) return null;
    updates.lowerThirdId = value.lowerThirdId;
  }
  for (const key of ["scheduledStart", "expectedEnd"] as const) {
    if (key in value) {
      const timestamp = optionalTimestamp(value[key]);
      if (timestamp === false || timestamp === undefined) return null;
      updates[key] = timestamp;
    }
  }
  return Object.keys(updates).length > 0 ? updates : null;
}

export function parseExactRelayOrder(value: unknown, currentIds: readonly string[]): string[] | null {
  if (!Array.isArray(value) || value.length !== currentIds.length || !value.every(isId)) return null;
  if (new Set(value).size !== value.length) return null;
  const current = new Set(currentIds);
  return value.every((id) => current.has(id)) ? value : null;
}
