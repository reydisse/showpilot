import { framesToTimecode, timecodeToString } from "@/lib/timecode";
import type { AutomationEvent, TimecodeFormat } from "@/types/timecode";

export interface SongCueSource {
  id: string;
  triggerFrame: number;
  section: { id: string; label: string; lyrics: string };
  ppSlideIndex: number | null;
}

export function buildSongAutomationEvents(input: {
  song: { id: string; title: string };
  cues: SongCueSource[];
  format: TimecodeFormat;
  target: "native" | "propresenter" | "both";
  offsetFrames?: number;
  toleranceFrames?: number;
  ppPresentationUuid?: string;
  cueMapId?: string;
  /** Optional deliberate hold duration. Omitted means hold until the next lyric or a manual clear. */
  clearAfterFrames?: number | null;
}): AutomationEvent[] {
  const offset = Math.trunc(input.offsetFrames ?? 0);
  const toleranceFrames = Math.max(0, Math.trunc(input.toleranceFrames ?? 5));
  const sorted = [...input.cues].sort((a, b) => a.triggerFrame - b.triggerFrame);
  const events: AutomationEvent[] = [];
  const sourceKey = `song:${input.song.id}:map:${input.cueMapId ?? "default"}:target:${input.target}:offset:${offset}`;

  sorted.forEach((cue, index) => {
    const triggerFrame = Math.max(0, cue.triggerFrame + offset);
    const triggerTimecode = framesToTimecode(triggerFrame, input.format);
    const common = {
      triggerTimecode,
      triggerFrame,
      fired: false,
      toleranceFrames,
      category: "lyrics",
      sourceKey,
    };
    if (input.target === "native" || input.target === "both") {
      events.push({
        ...common,
        id: crypto.randomUUID(),
        action: "lyrics-goto",
        label: `${input.song.title} · ${cue.section.label}`,
        payload: {
          songId: input.song.id,
          songTitle: input.song.title,
          sectionId: cue.section.id,
          sectionLabel: cue.section.label,
          lyrics: cue.section.lyrics,
          nextLabel: sorted[index + 1]?.section.label ?? "",
        },
      });
    }
    if ((input.target === "propresenter" || input.target === "both") && cue.ppSlideIndex !== null) {
      events.push({
        ...common,
        id: crypto.randomUUID(),
        action: "pp-trigger-slide",
        label: `${input.song.title} · ProPresenter ${cue.section.label}`,
        payload: {
          presentationUuid: input.ppPresentationUuid ?? "",
          slideIndex: cue.ppSlideIndex,
        },
      });
    }
  });

  if (sorted.length > 0 && input.clearAfterFrames != null && input.clearAfterFrames >= 0) {
    const clearFrame = Math.max(0, sorted[sorted.length - 1].triggerFrame + offset + Math.trunc(input.clearAfterFrames));
    const triggerTimecode = framesToTimecode(clearFrame, input.format);
    const commonClear = {
      triggerTimecode,
      triggerFrame: clearFrame,
      fired: false,
      toleranceFrames,
      category: "lyrics",
      sourceKey,
    };
    if (input.target === "native" || input.target === "both") {
      events.push({
        ...commonClear,
        id: crypto.randomUUID(),
        action: "lyrics-clear",
        payload: { generationKey: sourceKey },
        label: `${input.song.title} · Clear lyrics`,
      });
    }
    if (input.target === "propresenter" || input.target === "both") {
      events.push({
        ...commonClear,
        id: crypto.randomUUID(),
        action: "pp-trigger-clear",
        payload: {},
        label: `${input.song.title} · Clear ProPresenter`,
      });
    }
  }

  // Array.sort is stable: paired native/ProPresenter actions retain their
  // deliberate insertion order when they share one trigger frame.
  return events.sort((a, b) => a.triggerFrame - b.triggerFrame);
}

export function formatCueFrame(frame: number, format: TimecodeFormat): string {
  return timecodeToString(framesToTimecode(frame, format), format.dropFrame === "df");
}
