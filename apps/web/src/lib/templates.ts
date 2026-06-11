import type { ItemType, RundownItem } from "@/types/rundown";

// ─────────────────────────────────────────────────────────────
// Onboarding show templates — single source of truth for both the
// Scene 3 client-side rundown previews and the server-side seed.
// Pure data + pure builders: safe to import from client and server.
// ─────────────────────────────────────────────────────────────

export type OnboardingTemplateId = "sunday" | "youth" | "special" | "blank";

export interface OnboardingTemplateItem {
  title: string;
  durationSec: number;
  type: ItemType;
}

export interface OnboardingTemplateCueRow {
  cueNumber: number;
  rundownItem: string;
  cameraAssignments: string;
  notes: string;
}

export interface OnboardingTemplate {
  id: OnboardingTemplateId;
  name: string;
  items: OnboardingTemplateItem[];
  checklist: { label: string; category: string }[];
  cueRows: OnboardingTemplateCueRow[];
}

export const ONBOARDING_TEMPLATES: readonly OnboardingTemplate[] = [
  {
    id: "sunday",
    name: "Sunday Service",
    items: [
      { title: "Pre-service loop", durationSec: 900, type: "segment" },
      { title: "Walk-in", durationSec: 300, type: "segment" },
      { title: "Opener", durationSec: 270, type: "segment" },
      { title: "Welcome", durationSec: 120, type: "segment" },
      { title: "Worship set", durationSec: 1080, type: "song" },
      { title: "Announcements", durationSec: 180, type: "announcement" },
      { title: "Message", durationSec: 2100, type: "segment" },
      { title: "Response / Worship", durationSec: 360, type: "song" },
      { title: "Outro", durationSec: 180, type: "segment" },
    ],
    checklist: [
      { label: "Camera checks", category: "video" },
      { label: "Audio line check", category: "audio" },
      { label: "ProPresenter loaded", category: "visuals" },
      { label: "Stream key verified", category: "streaming" },
      { label: "Comms check", category: "comms" },
    ],
    cueRows: [
      {
        cueNumber: 1,
        rundownItem: "Opener",
        cameraAssignments: "Cam 1 wide · Cam 2 center",
        notes: "Roll opener video, lights to 50%",
      },
      {
        cueNumber: 2,
        rundownItem: "Worship set",
        cameraAssignments: "Cam 2 lead vocal · Cam 3 keys",
        notes: "Lyrics live on lyrics layer",
      },
    ],
  },
  {
    id: "youth",
    name: "Youth Night",
    items: [
      { title: "Doors / music", durationSec: 600, type: "segment" },
      { title: "Hype opener", durationSec: 300, type: "segment" },
      { title: "Game segment", durationSec: 600, type: "segment" },
      { title: "Worship", durationSec: 720, type: "song" },
      { title: "Message", durationSec: 1200, type: "segment" },
      { title: "Hang time", durationSec: 900, type: "segment" },
    ],
    checklist: [
      { label: "Audio line check", category: "audio" },
      { label: "Slides loaded", category: "visuals" },
      { label: "Comms check", category: "comms" },
    ],
    cueRows: [],
  },
  {
    id: "special",
    name: "Special Event",
    items: [
      { title: "Walk-in", durationSec: 600, type: "segment" },
      { title: "Welcome", durationSec: 180, type: "segment" },
      { title: "Segment A", durationSec: 900, type: "segment" },
      { title: "Segment B", durationSec: 900, type: "segment" },
      { title: "Intermission", durationSec: 600, type: "segment" },
      { title: "Segment C", durationSec: 900, type: "segment" },
      { title: "Close", durationSec: 300, type: "segment" },
    ],
    checklist: [
      { label: "Camera checks", category: "video" },
      { label: "Audio line check", category: "audio" },
      { label: "Comms check", category: "comms" },
    ],
    cueRows: [],
  },
  {
    id: "blank",
    name: "Start Blank",
    items: [],
    checklist: [],
    cueRows: [],
  },
];

export function getOnboardingTemplate(id: string): OnboardingTemplate | null {
  return ONBOARDING_TEMPLATES.find((template) => template.id === id) ?? null;
}

export function templateRuntimeSec(template: OnboardingTemplate): number {
  return template.items.reduce((total, item) => total + item.durationSec, 0);
}

/** Poster badge, e.g. "~92 MIN · 9 ITEMS". Blank gets "YOUR CALL". */
export function templateBadge(template: OnboardingTemplate): string {
  if (template.items.length === 0) return "YOUR CALL";
  const minutes = Math.round(templateRuntimeSec(template) / 60);
  return `~${minutes} MIN · ${template.items.length} ITEMS`;
}

/** Materialize template items as RundownItems (durations in ms). */
export function buildTemplateRundownItems(template: OnboardingTemplate): RundownItem[] {
  return template.items.map((item, index) => ({
    id: crypto.randomUUID(),
    title: item.title,
    type: item.type,
    duration: item.durationSec * 1000,
    notes: "",
    assignee: "",
    cue: "",
    status: "upcoming",
    sortOrder: index,
    hardStop: false,
  }));
}

// ─── Seed orchestration ──────────────────────────────────────
// The store interface keeps the seed logic unit-testable; the server
// function in onboarding.ts supplies the Prisma-backed implementation.

export interface TemplateSeedStore {
  getSeedMarker(): Promise<string | null>;
  setSeedMarker(value: string): Promise<void>;
  persistRundownItems(items: RundownItem[]): Promise<void>;
  createChecklistTemplates(rows: { label: string; category: string; sortOrder: number }[]): Promise<void>;
  createCueRows(rows: OnboardingTemplateCueRow[]): Promise<void>;
  getExistingItems(): Promise<RundownItem[]>;
}

export interface TemplateSeedResult {
  items: RundownItem[];
  alreadySeeded: boolean;
}

/**
 * Seed an org from a template, exactly once. A marker recorded after the
 * first successful seed makes re-runs (double click, refresh replay) return
 * the existing rundown instead of duplicating rows.
 */
export async function runTemplateSeed(
  store: TemplateSeedStore,
  template: OnboardingTemplate,
): Promise<TemplateSeedResult> {
  const marker = await store.getSeedMarker();
  if (marker !== null) {
    return { items: await store.getExistingItems(), alreadySeeded: true };
  }

  const items = buildTemplateRundownItems(template);
  if (items.length > 0) {
    await store.persistRundownItems(items);
  }
  if (template.checklist.length > 0) {
    await store.createChecklistTemplates(
      template.checklist.map((row, index) => ({ ...row, sortOrder: index })),
    );
  }
  if (template.cueRows.length > 0) {
    await store.createCueRows(template.cueRows);
  }
  await store.setSeedMarker(template.id);

  return { items, alreadySeeded: false };
}
