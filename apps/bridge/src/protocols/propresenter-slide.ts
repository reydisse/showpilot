/** ProPresenter's /v1/status/slide returns an atomic current/next pair. */
export interface SlidePair {
  text: string;
  notes: string;
  presentationName: string;
  isScripture: boolean;
  slideId: string;
  nextText: string;
  nextSlideId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function isScriptureSlide(value: string): boolean {
  return /\b(?:[1-3]\s*)?(?:Genesis|Exodus|Leviticus|Numbers|Deuteronomy|Joshua|Judges|Ruth|Samuel|Kings|Chronicles|Ezra|Nehemiah|Esther|Job|Psalms?|Proverbs|Ecclesiastes|Song of (?:Solomon|Songs)|Isaiah|Jeremiah|Lamentations|Ezekiel|Daniel|Hosea|Joel|Amos|Obadiah|Jonah|Micah|Nahum|Habakkuk|Zephaniah|Haggai|Zechariah|Malachi|Matthew|Mark|Luke|John|Acts|Romans|Corinthians|Galatians|Ephesians|Philippians|Colossians|Thessalonians|Timothy|Titus|Philemon|Hebrews|James|Peter|Jude|Revelation)\s+\d+(?::\d+)?\b/i.test(
    value,
  );
}

/** undefined means this is not a status pair; null means the slide was cleared. */
export function parseSlidePair(value: unknown): SlidePair | null | undefined {
  const data = record(value);
  if (!data || !("current" in data)) return undefined;
  const current = record(data.current);
  if (data.current === null) return null;
  if (!current || typeof current.text !== "string") return undefined;
  if (current.text.trim() === "") return null;
  const next = record(data.next);
  const notes = text(current.notes);
  const presentationName =
    text(data.presentation_name) || text(data.presentation);
  return {
    text: current.text,
    notes,
    presentationName,
    isScripture: isScriptureSlide(
      `${presentationName}\n${notes}\n${current.text}`,
    ),
    slideId: text(current.uuid),
    nextText: text(next?.text),
    nextSlideId: text(next?.uuid),
  };
}
