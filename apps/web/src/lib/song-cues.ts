import { DEFAULT_TIMECODE_TOLERANCE_FRAMES, MAX_TIMECODE_TOLERANCE_FRAMES } from "@/types/timecode";
import { framesToTimecode, timecodeToString, isValidTimecode, isValidTimecodeFormat, isValidTimecodeTolerance } from "@/lib/timecode";
import type { AutomationEvent, TimecodeFormat } from "@/types/timecode";

export interface SongCueSource {
  id: string;
  triggerFrame: number;
  section: { id: string; label: string; lyrics: string };
  ppSlideIndex: number | null;
}

/** Do not reinterpret a stored cue map at a different frame rate. */
export function readSongCueFormat(stored: string, current: TimecodeFormat): { format: TimecodeFormat } | { error: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(stored); } catch { parsed = null; }
  if (!isValidTimecodeFormat(parsed)) return { error: "This cue map has an invalid frame rate. Edit its format in Songs before loading it." };
  if (parsed.frameRate !== current.frameRate || parsed.dropFrame !== current.dropFrame) {
    return { error: `Cue map format ${parsed.frameRate}fps ${parsed.dropFrame.toUpperCase()} does not match the timeline (${current.frameRate}fps ${current.dropFrame.toUpperCase()}). Match the formats before loading.` };
  }
  return { format: parsed };
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
  const offset = input.offsetFrames ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Cue offset must be a whole number of frames, zero or greater.");
  if (input.clearAfterFrames != null && (!Number.isSafeInteger(input.clearAfterFrames) || input.clearAfterFrames < 0)) {
    throw new Error("Clear hold must be a whole number of frames, zero or greater.");
  }
  const toleranceFrames = input.toleranceFrames ?? DEFAULT_TIMECODE_TOLERANCE_FRAMES;
  if (!isValidTimecodeTolerance(toleranceFrames)) throw new Error(`Tolerance must be a whole number from 0 to ${MAX_TIMECODE_TOLERANCE_FRAMES} frames.`);
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
      enabled: true,
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

  if (events.length > 0 && input.clearAfterFrames != null) {
    const hasNativeCues = events.some(event => event.action === "lyrics-goto");
    const hasProPresenterCues = events.some(event => event.action === "pp-trigger-slide");
    const clearFrame = events[events.length - 1].triggerFrame + input.clearAfterFrames;
    const triggerTimecode = framesToTimecode(clearFrame, input.format);
    if (!isValidTimecode(triggerTimecode, input.format)) throw new Error("The clear cue falls after the end of the timecode day. Reduce the hold or song offset.");
    const commonClear = {
      triggerTimecode,
      triggerFrame: clearFrame,
      fired: false,
      enabled: true,
      toleranceFrames,
      category: "lyrics",
      sourceKey,
    };
    if (hasNativeCues) {
      events.push({
        ...commonClear,
        id: crypto.randomUUID(),
        action: "lyrics-clear",
        payload: { generationKey: sourceKey },
        label: `${input.song.title} · Clear lyrics`,
      });
    }
    if (hasProPresenterCues) {
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
