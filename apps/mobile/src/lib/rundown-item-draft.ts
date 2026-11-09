import type { RundownItem } from "./mobile-api";
export type RundownItemDraft = {
  id: string;
  showId: string;
  base: {
    item: RundownItem | null;
    revision: number;
    order: string[];
    serviceDate: string;
  };
  fields: {
    title: string;
    type: RundownItem["type"];
    duration: string;
    assignee: string;
    cue: string;
    notes: string;
    hardStop: boolean;
  };
};
export function itemDraftFields(
  item: RundownItem | null,
): RundownItemDraft["fields"] {
  return {
    title: item?.title ?? "",
    type: item?.type ?? "segment",
    duration: durationInput(item?.duration ?? 300000),
    assignee: item?.assignee ?? "",
    cue: item?.cue ?? "",
    notes: item?.notes ?? "",
    hardStop: item?.hardStop ?? false,
  };
}
export function durationInput(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function parseRundownDuration(value: string): number | null {
  const parts = value.trim().split(":");
  if (
    parts.length < 1 ||
    parts.length > 3 ||
    parts.some((part) => !/^\d+$/.test(part))
  )
    return null;
  const numbers = parts.map(Number);
  // Colon-separated components are clock fields, so seconds (and minutes in
  // H:MM:SS) must remain within their normal ranges. This prevents inputs
  // such as 1:99 from silently becoming 2:39.
  if (parts.length >= 2 && numbers.at(-1)! >= 60) return null;
  if (parts.length === 3 && numbers[1] >= 60) return null;
  const seconds =
    parts.length === 3
      ? numbers[0] * 3_600 + numbers[1] * 60 + numbers[2]
      : parts.length === 2
        ? numbers[0] * 60 + numbers[1]
        : numbers[0] * 60;
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 7 * 24 * 3_600)
    return null;
  return seconds * 1_000;
}
