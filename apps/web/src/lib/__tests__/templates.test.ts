import { describe, it, expect } from "vitest";
import {
  ONBOARDING_TEMPLATES,
  buildTemplateRundownItems,
  getOnboardingTemplate,
  templateBadge,
  templateRuntimeSec,
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
      expect(templateBadge(template)).toBe(
        `~${minutes} MIN · ${template.items.length} ITEMS`,
      );
    }
  });

  it("matches the approved runtimes", () => {
    expect(templateBadge(sunday)).toBe("~92 MIN · 9 ITEMS");
    expect(templateBadge(getOnboardingTemplate("youth")!)).toBe(
      "~72 MIN · 6 ITEMS",
    );
    expect(templateBadge(getOnboardingTemplate("special")!)).toBe(
      "~73 MIN · 7 ITEMS",
    );
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
