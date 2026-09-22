import { describe, expect, it } from "vitest";
import { planProPresenterMerge, type ExistingImportedSection } from "../song-import";

function section(overrides: Partial<ExistingImportedSection>): ExistingImportedSection {
  return {
    id: "section",
    label: "Verse",
    lyrics: "Verse words",
    sortOrder: 0,
    sourceSlideIndex: 0,
    sourceSlideId: "",
    cueCount: 0,
    ...overrides,
  };
}

describe("planProPresenterMerge", () => {
  it("preserves section identity when unchanged slides are reordered", () => {
    const plan = planProPresenterMerge([
      section({ id: "verse", sourceSlideIndex: 0 }),
      section({ id: "chorus", label: "Chorus", lyrics: "Chorus words", sourceSlideIndex: 1, cueCount: 1 }),
    ], [
      { index: 0, label: "Intro", text: "Welcome", notes: "" },
      { index: 1, label: "Verse", text: "Verse words", notes: "" },
      { index: 2, label: "Chorus", text: "Chorus words", notes: "" },
    ]);

    expect(plan.writes).toContainEqual(expect.objectContaining({ kind: "update", sectionId: "chorus", sortOrder: 2 }));
    expect(plan.preservedMappedSections).toEqual([]);
  });

  it("never overwrites changed lyrics behind a timed cue", () => {
    const plan = planProPresenterMerge([
      section({ id: "chorus", label: "Chorus", lyrics: "Old words", sourceSlideId: "slide-1", cueCount: 2 }),
    ], [
      { index: 0, sourceId: "slide-1", label: "Chorus", text: "New words", notes: "" },
    ]);

    expect(plan.writes).toContainEqual(expect.objectContaining({ kind: "create", sortOrder: 0 }));
    expect(plan.writes).not.toContainEqual(expect.objectContaining({ kind: "update", sectionId: "chorus", sortOrder: 0 }));
    expect(plan.preservedMappedSections).toEqual([expect.objectContaining({ sectionId: "chorus" })]);
  });
});
