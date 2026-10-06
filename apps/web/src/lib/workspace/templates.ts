import type { WorkspaceType } from "@showpilot/shared";
import type { ItemType, RundownItem } from "@/types/rundown";

// ─────────────────────────────────────────────────────────────
// Onboarding show templates — single source of truth for both the
// Scene 3 client-side rundown previews and the server-side seed.
// Pure data + pure builders: safe to import from client and server.
// ─────────────────────────────────────────────────────────────

export type OnboardingTemplateId =
  | "sunday"
  | "youth"
  | "special"
  | "blank"
  | "keynote"
  | "concert"
  | "assembly"
  | "graduation"
  | "two-act"
  | "rehearsal";

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
  return (
    ALL_ONBOARDING_TEMPLATES.find((template) => template.id === id) ?? null
  );
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
export function buildTemplateRundownItems(
  template: OnboardingTemplate,
): RundownItem[] {
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
  itemId(templateId: OnboardingTemplateId, index: number): string;
  checklistId(index: number): string;
  persistRundownItems(items: RundownItem[]): Promise<void>;
  createChecklistTemplates(
    rows: { id: string; label: string; category: string; sortOrder: number }[],
  ): Promise<void>;
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

  const items = buildTemplateRundownItems(template).map((item, index) => ({
    ...item,
    id: store.itemId(template.id, index),
  }));
  if (items.length > 0) {
    await store.persistRundownItems(items);
  }
  if (template.checklist.length > 0) {
    await store.createChecklistTemplates(
      template.checklist.map((row, index) => ({
        ...row,
        id: store.checklistId(index),
        sortOrder: index,
      })),
    );
  }
  if (template.cueRows.length > 0) {
    await store.createCueRows(template.cueRows);
  }
  await store.setSeedMarker(template.id);

  return { items, alreadySeeded: false };
}

const EXTRA_TEMPLATES: readonly OnboardingTemplate[] = [
  {
    id: "keynote",
    name: "Corporate Keynote",
    items: [
      {
        title: "Doors & walk-in",
        durationSec: 900,
        type: "segment",
      },
      {
        title: "Opening video",
        durationSec: 120,
        type: "segment",
      },
      {
        title: "Host welcome",
        durationSec: 180,
        type: "segment",
      },
      {
        title: "Keynote",
        durationSec: 1800,
        type: "segment",
      },
      {
        title: "Panel",
        durationSec: 1500,
        type: "segment",
      },
      {
        title: "Q&A",
        durationSec: 600,
        type: "segment",
      },
      {
        title: "Sponsor thank-you",
        durationSec: 120,
        type: "segment",
      },
      {
        title: "Close & walkout",
        durationSec: 300,
        type: "segment",
      },
    ],
    checklist: [
      {
        label: "Audio line check",
        category: "audio",
      },
      {
        label: "Lighting cues checked",
        category: "visuals",
      },
      {
        label: "Comms check",
        category: "comms",
      },
      {
        label: "Stage and exits clear",
        category: "general",
      },
    ],
    cueRows: [],
  },
  {
    id: "concert",
    name: "Concert",
    items: [
      {
        title: "Doors",
        durationSec: 1800,
        type: "segment",
      },
      {
        title: "Support act",
        durationSec: 1800,
        type: "segment",
      },
      {
        title: "Changeover",
        durationSec: 1200,
        type: "segment",
      },
      {
        title: "Headliner",
        durationSec: 4500,
        type: "segment",
      },
      {
        title: "Encore",
        durationSec: 600,
        type: "segment",
      },
      {
        title: "House lights",
        durationSec: 300,
        type: "segment",
      },
    ],
    checklist: [
      {
        label: "Audio line check",
        category: "audio",
      },
      {
        label: "Lighting cues checked",
        category: "visuals",
      },
      {
        label: "Comms check",
        category: "comms",
      },
      {
        label: "Stage and exits clear",
        category: "general",
      },
    ],
    cueRows: [],
  },
  {
    id: "assembly",
    name: "Assembly",
    items: [
      {
        title: "Walk-in",
        durationSec: 300,
        type: "segment",
      },
      {
        title: "Welcome & announcements",
        durationSec: 300,
        type: "segment",
      },
      {
        title: "Anthem / opening",
        durationSec: 180,
        type: "segment",
      },
      {
        title: "Student performance",
        durationSec: 480,
        type: "segment",
      },
      {
        title: "Guest speaker",
        durationSec: 900,
        type: "segment",
      },
      {
        title: "Awards",
        durationSec: 600,
        type: "segment",
      },
      {
        title: "Closing remarks",
        durationSec: 180,
        type: "segment",
      },
    ],
    checklist: [
      {
        label: "Audio line check",
        category: "audio",
      },
      {
        label: "Lighting cues checked",
        category: "visuals",
      },
      {
        label: "Comms check",
        category: "comms",
      },
      {
        label: "Stage and exits clear",
        category: "general",
      },
    ],
    cueRows: [],
  },
  {
    id: "graduation",
    name: "Graduation",
    items: [
      {
        title: "Processional",
        durationSec: 600,
        type: "segment",
      },
      {
        title: "Welcome",
        durationSec: 300,
        type: "segment",
      },
      {
        title: "Address",
        durationSec: 900,
        type: "segment",
      },
      {
        title: "Valedictorian",
        durationSec: 480,
        type: "segment",
      },
      {
        title: "Diplomas",
        durationSec: 2700,
        type: "segment",
      },
      {
        title: "Recessional",
        durationSec: 480,
        type: "segment",
      },
    ],
    checklist: [
      {
        label: "Audio line check",
        category: "audio",
      },
      {
        label: "Lighting cues checked",
        category: "visuals",
      },
      {
        label: "Comms check",
        category: "comms",
      },
      {
        label: "Stage and exits clear",
        category: "general",
      },
    ],
    cueRows: [],
  },
  {
    id: "two-act",
    name: "Two-Act Performance",
    items: [
      {
        title: "House open",
        durationSec: 1800,
        type: "segment",
      },
      {
        title: "Pre-show announcement",
        durationSec: 120,
        type: "segment",
      },
      {
        title: "Act 1",
        durationSec: 3300,
        type: "segment",
      },
      {
        title: "Intermission",
        durationSec: 900,
        type: "segment",
      },
      {
        title: "Act 2",
        durationSec: 3000,
        type: "segment",
      },
      {
        title: "Curtain call",
        durationSec: 300,
        type: "segment",
      },
      {
        title: "House lights",
        durationSec: 300,
        type: "segment",
      },
    ],
    checklist: [
      {
        label: "Audio line check",
        category: "audio",
      },
      {
        label: "Lighting cues checked",
        category: "visuals",
      },
      {
        label: "Comms check",
        category: "comms",
      },
      {
        label: "Stage and exits clear",
        category: "general",
      },
    ],
    cueRows: [],
  },
  {
    id: "rehearsal",
    name: "Rehearsal",
    items: [
      {
        title: "Warm-up",
        durationSec: 1200,
        type: "segment",
      },
      {
        title: "Notes",
        durationSec: 900,
        type: "segment",
      },
      {
        title: "Run",
        durationSec: 5400,
        type: "segment",
      },
      {
        title: "Notes",
        durationSec: 1200,
        type: "segment",
      },
    ],
    checklist: [
      {
        label: "Audio line check",
        category: "audio",
      },
      {
        label: "Lighting cues checked",
        category: "visuals",
      },
      {
        label: "Comms check",
        category: "comms",
      },
      {
        label: "Stage and exits clear",
        category: "general",
      },
    ],
    cueRows: [],
  },
];
export const ALL_ONBOARDING_TEMPLATES = [
  ...ONBOARDING_TEMPLATES,
  ...EXTRA_TEMPLATES,
];
const TEMPLATE_IDS_BY_TYPE: Record<
  WorkspaceType,
  readonly OnboardingTemplateId[]
> = {
  church: ["sunday", "youth", "special", "blank"],
  live_events: ["keynote", "concert", "special", "blank"],
  school: ["assembly", "graduation", "blank"],
  theatre: ["two-act", "rehearsal", "blank"],
  custom: ["special", "blank"],
};
export function templatesForWorkspace(
  type: WorkspaceType,
): readonly OnboardingTemplate[] {
  return TEMPLATE_IDS_BY_TYPE[type].flatMap((id) => {
    const template = getOnboardingTemplate(id);
    return template ? [template] : [];
  });
}
