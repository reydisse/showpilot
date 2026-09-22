export interface ImportedSongSlide {
  index: number;
  sourceId?: string;
  text: string;
  label: string;
  notes: string;
}

export interface ExistingImportedSection {
  id: string;
  label: string;
  lyrics: string;
  sortOrder: number;
  sourceSlideIndex: number | null;
  sourceSlideId: string;
  cueCount: number;
}

export type SongImportWrite =
  | { kind: "create"; slide: ImportedSongSlide; sortOrder: number }
  | { kind: "update"; sectionId: string; slide: ImportedSongSlide; sortOrder: number }
  | { kind: "delete"; sectionId: string };

export interface SongImportPlan {
  writes: SongImportWrite[];
  preservedMappedSections: Array<{ sectionId: string; label: string; reason: string }>;
}

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function signature(label: string, lyrics: string): string {
  return `${normalized(label)}\u0000${normalized(lyrics)}`;
}

/**
 * Reconciles a ProPresenter snapshot without ever changing the content behind
 * an existing timed cue. Changed mapped sections are retained for review and
 * the incoming content is created as a new section.
 */
export function planProPresenterMerge(
  existing: ExistingImportedSection[],
  incoming: ImportedSongSlide[],
): SongImportPlan {
  const unused = new Map(existing.map((section) => [section.id, section]));
  const writes: SongImportWrite[] = [];
  const preservedMappedSections: SongImportPlan["preservedMappedSections"] = [];
  const warnedSectionIds = new Set<string>();

  for (const [sortOrder, slide] of incoming.entries()) {
    const slideSignature = signature(slide.label, slide.text);
    const stableMatch = slide.sourceId
      ? [...unused.values()].find((section) => section.sourceSlideId === slide.sourceId)
      : undefined;
    const contentMatch = stableMatch ?? [...unused.values()].find(
      (section) => signature(section.label, section.lyrics) === slideSignature,
    );

    if (contentMatch) {
      const contentChanged = signature(contentMatch.label, contentMatch.lyrics) !== slideSignature;
      if (!contentChanged || contentMatch.cueCount === 0) {
        unused.delete(contentMatch.id);
        writes.push({ kind: "update", sectionId: contentMatch.id, slide, sortOrder });
        continue;
      }
      preservedMappedSections.push({
        sectionId: contentMatch.id,
        label: contentMatch.label,
        reason: "ProPresenter changed the content of a section used by a timed cue.",
      });
      warnedSectionIds.add(contentMatch.id);
    }

    const positionalMatch = [...unused.values()].find(
      (section) => section.sourceSlideIndex === slide.index && section.cueCount === 0,
    );
    if (positionalMatch) {
      unused.delete(positionalMatch.id);
      writes.push({ kind: "update", sectionId: positionalMatch.id, slide, sortOrder });
    } else {
      writes.push({ kind: "create", slide, sortOrder });
    }
  }

  let retainedOrder = incoming.length;
  for (const section of unused.values()) {
    if (section.cueCount === 0) {
      writes.push({ kind: "delete", sectionId: section.id });
      continue;
    }
    if (!warnedSectionIds.has(section.id)) {
      preservedMappedSections.push({
        sectionId: section.id,
        label: section.label,
        reason: "This timed section was not present in the latest ProPresenter presentation.",
      });
    }
    writes.push({
      kind: "update",
      sectionId: section.id,
      sortOrder: retainedOrder,
      slide: {
        index: section.sourceSlideIndex ?? retainedOrder,
        sourceId: section.sourceSlideId,
        label: section.label,
        text: section.lyrics,
        notes: "",
      },
    });
    retainedOrder += 1;
  }

  return { writes, preservedMappedSections };
}
