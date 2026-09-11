export interface FormattedLyricsSection {
  label: string;
  lyrics: string;
}

interface LogicalLyricsSection {
  label: string;
  lines: string[];
}

const SECTION_HEADING = /^(verse|chorus|bridge|pre[ -]?chorus|intro|outro|tag|refrain|vamp|ending|instrumental)(?:\s+([0-9]+|[a-z]))?(?:\s+x[0-9]+)?\s*:?$/i;

export function normalizeLyricsText(input: string): string {
  return input
    .replace(/\r\n?|\u2028|\u2029/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function readHeading(line: string): string | null {
  const bracketed = /^\[([^\]\n]{1,80})\]$/.exec(line);
  const candidate = bracketed?.[1].trim() ?? line;
  const match = SECTION_HEADING.exec(candidate);
  if (!match) return null;

  const kind = match[1].toLowerCase().replace(/[ -]+/g, " ");
  const name = kind === "pre chorus"
    ? "Pre-Chorus"
    : kind.charAt(0).toUpperCase() + kind.slice(1);
  return match[2] ? `${name} ${match[2].toUpperCase()}` : name;
}

function splitIntoSlides(lines: string[]): string[][] {
  const slides: string[][] = [];
  let paragraph: string[] = [];

  const flush = () => {
    for (let index = 0; index < paragraph.length; index += 4) {
      slides.push(paragraph.slice(index, index + 4));
    }
    paragraph = [];
  };

  for (const line of lines) {
    if (line) paragraph.push(line);
    else flush();
  }
  flush();
  return slides;
}

export function formatSongLyrics(input: string): FormattedLyricsSection[] {
  const normalized = normalizeLyricsText(input);
  if (!normalized) return [];

  const logicalSections: LogicalLyricsSection[] = [];
  let current: LogicalLyricsSection = { label: "", lines: [] };

  const flush = () => {
    if (current.lines.some(Boolean)) logicalSections.push(current);
  };

  for (const line of normalized.split("\n")) {
    const heading = readHeading(line);
    if (heading) {
      flush();
      current = { label: heading, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  flush();

  const sectionSlides = logicalSections.flatMap((section) => {
    const slides = splitIntoSlides(section.lines);
    return slides.map((lines, index) => ({
      baseLabel: section.label,
      slideIndex: index,
      slideCount: slides.length,
      lyrics: lines.join("\n"),
    }));
  });

  return sectionSlides.map((section, index) => {
    const fallbackLabel = sectionSlides.length === 1 ? "Verse 1" : `Section ${index + 1}`;
    return {
      label: section.baseLabel
        ? section.slideCount > 1 ? `${section.baseLabel} ${section.slideIndex + 1}/${section.slideCount}` : section.baseLabel
        : fallbackLabel,
      lyrics: section.lyrics,
    };
  });
}

export function insertPastedLyrics({ value, pastedText, selectionStart, selectionEnd }: { value: string; pastedText: string; selectionStart: number; selectionEnd: number }): string {
  const pasted = normalizeLyricsText(pastedText);
  const before = value.slice(0, selectionStart);
  const after = value.slice(selectionEnd);
  return `${before}${pasted}${after}`;
}
