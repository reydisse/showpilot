import { describe, it, expect } from "vitest";
import type { RundownItem } from "@/types/rundown";
import {
  ONBOARDING_TEMPLATES,
  buildTemplateRundownItems,
  getOnboardingTemplate,
  runTemplateSeed,
  templateBadge,
  templateRuntimeSec,
  type OnboardingTemplate,
  type TemplateSeedStore,
} from "../templates";

const sunday = getOnboardingTemplate("sunday")!;
const blank = getOnboardingTemplate("blank")!;

describe("template definitions", () => {
  it("every template's items sum to the advertised runtime", () => {
    for (const template of ONBOARDING_TEMPLATES) {
      if (template.items.length === 0) {
        expect(templateBadge(template)).toBe("YOUR CALL");
        continue;
      }
      const minutes = Math.round(templateRuntimeSec(template) / 60);
      expect(templateBadge(template)).toBe(`~${minutes} MIN · ${template.items.length} ITEMS`);
    }
  });

  it("matches the approved runtimes", () => {
    expect(templateBadge(sunday)).toBe("~92 MIN · 9 ITEMS");
    expect(templateBadge(getOnboardingTemplate("youth")!)).toBe("~72 MIN · 6 ITEMS");
    expect(templateBadge(getOnboardingTemplate("special")!)).toBe("~73 MIN · 7 ITEMS");
  });

  it("builds rundown items with ms durations and stable ordering", () => {
    const items = buildTemplateRundownItems(sunday);
    expect(items).toHaveLength(sunday.items.length);
    items.forEach((item, index) => {
      expect(item.duration).toBe(sunday.items[index].durationSec * 1000);
      expect(item.sortOrder).toBe(index);
      expect(item.status).toBe("upcoming");
      expect(item.id).toBeTruthy();
    });
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  });

  it("blank template seeds nothing", () => {
    expect(buildTemplateRundownItems(blank)).toEqual([]);
    expect(blank.checklist).toEqual([]);
    expect(blank.cueRows).toEqual([]);
  });
});

function makeFakeStore() {
  const state = {
    marker: null as string | null,
    persisted: [] as RundownItem[][],
    checklistRows: [] as { label: string; category: string; sortOrder: number }[][],
    cueRows: [] as unknown[][],
    existing: [] as RundownItem[],
  };
  const store: TemplateSeedStore = {
    getSeedMarker: async () => state.marker,
    setSeedMarker: async (value) => {
      state.marker = value;
    },
    persistRundownItems: async (items) => {
      state.persisted.push(items);
      state.existing = items;
    },
    createChecklistTemplates: async (rows) => {
      state.checklistRows.push(rows);
    },
    createCueRows: async (rows) => {
      state.cueRows.push(rows);
    },
    getExistingItems: async () => state.existing,
  };
  return { store, state };
}

describe("runTemplateSeed", () => {
  it("seeds expected counts on first run", async () => {
    const { store, state } = makeFakeStore();
    const result = await runTemplateSeed(store, sunday);

    expect(result.alreadySeeded).toBe(false);
    expect(result.items).toHaveLength(9);
    expect(state.persisted).toHaveLength(1);
    expect(state.checklistRows[0]).toHaveLength(5);
    expect(state.cueRows[0]).toHaveLength(2);
    expect(state.marker).not.toBeNull();
  });

  it("re-running for an already-seeded org does not duplicate", async () => {
    const { store, state } = makeFakeStore();
    const first = await runTemplateSeed(store, sunday);
    const second = await runTemplateSeed(store, sunday);

    expect(second.alreadySeeded).toBe(true);
    expect(second.items).toEqual(first.items);
    expect(state.persisted).toHaveLength(1);
    expect(state.checklistRows).toHaveLength(1);
    expect(state.cueRows).toHaveLength(1);
  });

  it("blank template writes only the marker", async () => {
    const { store, state } = makeFakeStore();
    const result = await runTemplateSeed(store, blank);

    expect(result.items).toEqual([]);
    expect(state.persisted).toHaveLength(0);
    expect(state.checklistRows).toHaveLength(0);
    expect(state.cueRows).toHaveLength(0);
    expect(state.marker).not.toBeNull();
  });

  it("marker survives even if a later template differs (no cross-template reseed)", async () => {
    const { store, state } = makeFakeStore();
    await runTemplateSeed(store, sunday);
    const youth = getOnboardingTemplate("youth") as OnboardingTemplate;
    const rerun = await runTemplateSeed(store, youth);

    expect(rerun.alreadySeeded).toBe(true);
    expect(state.persisted).toHaveLength(1);
  });
});
