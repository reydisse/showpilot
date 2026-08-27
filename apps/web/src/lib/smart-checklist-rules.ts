import type { DepartmentKey } from "@/lib/departments";
import type { RundownItem } from "@/types/rundown";

export interface ChecklistSuggestion {
  id: string;
  label: string;
  category: DepartmentKey;
  reason: string;
  sourceItemIds: string[];
}

type Rule = {
  id: string;
  label: string;
  category: DepartmentKey;
  reason: string;
  matches: (item: ChecklistRundownItem, searchable: string) => boolean;
};

type BaselineCheck = Omit<ChecklistSuggestion, "sourceItemIds">;

export type ChecklistRundownItem = Pick<
  RundownItem,
  "id" | "title" | "type" | "duration" | "notes" | "assignee" | "cue" | "hardStop"
>;

/**
 * The boring checks are the valuable ones under pressure. These apply to
 * every show; rundown rules below only add the exceptional work.
 * Some labels deliberately match onboarding templates so existing installs
 * reuse those templates instead of creating near-duplicates.
 */
const EVERY_SHOW_CHECKS: BaselineCheck[] = [
  {
    id: "baseline-crew-checkin",
    label: "Confirm all scheduled crew have checked in",
    category: "general",
    reason: "Every show needs the expected technical crew accounted for.",
  },
  {
    id: "baseline-comms",
    label: "Comms check",
    category: "general",
    reason: "Every show needs working communication between operators.",
  },
  {
    id: "baseline-audio",
    label: "Audio line check",
    category: "audio",
    reason: "Every show needs verified audio signal paths before doors.",
  },
  {
    id: "baseline-cameras",
    label: "Camera checks",
    category: "video",
    reason: "Every show needs cameras powered, framed, focused, and matched.",
  },
  {
    id: "baseline-presenter",
    label: "ProPresenter loaded",
    category: "video",
    reason: "Every show needs the presentation file loaded and outputting correctly.",
  },
  {
    id: "baseline-confidence",
    label: "Confidence monitors on and showing the correct feed",
    category: "video",
    reason: "Every show needs stage confidence displays verified from the room.",
  },
  {
    id: "baseline-led-screens",
    label: "LED wall and venue screens on and showing the correct feed",
    category: "video",
    reason: "Every show needs audience displays powered and visually verified.",
  },
  {
    id: "baseline-lighting",
    label: "Lighting console and show file ready",
    category: "lighting",
    reason: "Every show needs control, fixtures, and the correct show file ready.",
  },
  {
    id: "baseline-stream",
    label: "Stream key verified",
    category: "stream",
    reason: "Every show needs the configured stream destination verified.",
  },
  {
    id: "baseline-recording",
    label: "Recording armed and storage space confirmed",
    category: "stream",
    reason: "Every show should have its recording path and remaining storage checked.",
  },
  {
    id: "baseline-backup",
    label: "Backup playback and emergency content ready",
    category: "general",
    reason: "Every show needs a safe fallback if primary playback fails.",
  },
];

const contains = (pattern: RegExp) => (_item: ChecklistRundownItem, searchable: string) => pattern.test(searchable);

const RULES: Rule[] = [
  {
    id: "audio-song-inputs",
    label: "Line-check all music inputs and monitor mixes",
    category: "audio",
    reason: "The rundown includes live music.",
    matches: (item, text) => item.type === "song" || /\b(worship|choir|band|music|praise)\b/.test(text),
  },
  {
    id: "audio-speaking-mics",
    label: "Test speaking microphones and confirm assignments",
    category: "audio",
    reason: "The rundown includes spoken segments.",
    matches: (item, text) =>
      ["prayer", "announcement", "offering"].includes(item.type) ||
      /\b(sermon|message|speaker|host|mc|interview|panel|testimony)\b/.test(text),
  },
  {
    id: "video-presentations",
    label: "Load and verify slides, lyrics, and presentation cues",
    category: "video",
    reason: "The rundown calls for presentation content.",
    matches: (item, text) =>
      item.type === "song" ||
      /\b(slide|slides|lyrics|scripture|presentation|pro ?presenter|lower third|graphic|media)\b/.test(text),
  },
  {
    id: "video-playback",
    label: "Test video playback, audio routing, and backup file",
    category: "video",
    reason: "The rundown includes video playback.",
    matches: contains(/\b(video|vt|playback|roll in|package|film|clip)\b/),
  },
  {
    id: "stream-destinations",
    label: "Verify stream destinations, title, and privacy settings",
    category: "stream",
    reason: "The rundown references a live or streamed segment.",
    matches: contains(/\b(stream|livestream|live stream|youtube|facebook live|broadcast|online)\b/),
  },
  {
    id: "stream-remote-guest",
    label: "Test remote guest connection and return audio",
    category: "stream",
    reason: "The rundown includes a remote contributor.",
    matches: contains(/\b(zoom|remote guest|remote speaker|video call|teams call|skype)\b/),
  },
  {
    id: "lighting-scenes",
    label: "Review lighting looks and transitions against the rundown",
    category: "lighting",
    reason: "The rundown includes lighting-specific cues.",
    matches: contains(/\b(light|lighting|blackout|spotlight|stage look|colour|color)\b/),
  },
  {
    id: "general-baptism",
    label: "Protect and test equipment around the baptism area",
    category: "general",
    reason: "The rundown includes a baptism or water segment.",
    matches: contains(/\b(baptism|baptize|water tank|immersion)\b/),
  },
  {
    id: "general-recording",
    label: "Confirm recording destinations and available storage",
    category: "general",
    reason: "The rundown requests a recording.",
    matches: contains(/\b(record|recording|iso record|archive)\b/),
  },
  {
    id: "general-unassigned-items",
    label: "Confirm owners for every unassigned rundown item",
    category: "general",
    reason: "One or more rundown items do not have an assignee.",
    matches: (item) => item.assignee.trim().length === 0,
  },
  {
    id: "general-missing-timing",
    label: "Resolve missing durations before technical rehearsal",
    category: "general",
    reason: "One or more rundown items do not have a duration.",
    matches: (item) => item.duration <= 0,
  },
  {
    id: "general-hard-stops",
    label: "Rehearse hard-stop cues and the following transitions",
    category: "general",
    reason: "The rundown contains a hard stop.",
    matches: (item) => item.hardStop,
  },
];

function searchableText(item: ChecklistRundownItem): string {
  return `${item.title} ${item.notes} ${item.cue} ${item.assignee}`.toLowerCase();
}

/** Pure, deterministic generation so a draft is explainable and works without an AI service. */
export function deriveChecklistSuggestions(items: ChecklistRundownItem[]): ChecklistSuggestion[] {
  const realItems = items.filter((item) => item.type !== "header");

  const rundownSuggestions = RULES.flatMap((rule) => {
    const matches = realItems.filter((item) => rule.matches(item, searchableText(item)));
    if (matches.length === 0) return [];
    return [{
      id: rule.id,
      label: rule.label,
      category: rule.category,
      reason: rule.reason,
      sourceItemIds: matches.map((item) => item.id),
    }];
  });

  return [
    ...EVERY_SHOW_CHECKS.map((check) => ({ ...check, sourceItemIds: [] })),
    ...rundownSuggestions,
  ];
}

export function normalizeChecklistLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
