/**
 * The department vocabulary, in one place.
 *
 * Checklists, incidents and equipment each grew their own category
 * strings. The dashboard folds all three into these five keys so a
 * department chip can roll up every source at once — and the checklist
 * page uses the same list so what an operator picks is exactly what the
 * dashboard reads back. Two lists that drift is how "visuals" ended up
 * invisible.
 */

/** Display order. General last: it is the bucket, not a department. */
export const DEPARTMENT_ORDER = [
  "audio",
  "video",
  "lighting",
  "stream",
  "general",
] as const;

export type DepartmentKey = (typeof DEPARTMENT_ORDER)[number];

export const DEPARTMENT_LABELS: Record<DepartmentKey, string> = {
  audio: "Audio",
  video: "Video",
  lighting: "Lighting",
  stream: "Stream",
  general: "General",
};

/**
 * Fold any category string onto a department key. Unknown values become
 * "general" rather than being dropped — an uncategorised item is still
 * an item someone has to do.
 */
export function normalizeCategory(raw: string): DepartmentKey {
  const value = raw.toLowerCase().trim();
  if (value === "audio") return "audio";
  // The onboarding templates seed "visuals" for ProPresenter work, which
  // belongs with video rather than in the general bucket.
  if (value === "video" || value === "visuals") return "video";
  if (value === "lighting") return "lighting";
  if (value === "stream" || value === "streaming") return "stream";
  return "general";
}
