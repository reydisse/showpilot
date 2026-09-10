import { describe, expect, it, vi } from "vitest";
import { buildSongAutomationEvents } from "@/lib/song-cues";

describe("buildSongAutomationEvents", () => {
  it("builds native and ProPresenter events from one repeated-section cue map", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValueOnce("00000000-0000-4000-8000-000000000001").mockReturnValueOnce("00000000-0000-4000-8000-000000000002").mockReturnValueOnce("00000000-0000-4000-8000-000000000003").mockReturnValueOnce("00000000-0000-4000-8000-000000000004").mockReturnValueOnce("00000000-0000-4000-8000-000000000005");
    const verse = { id: "verse", label: "Verse 1", lyrics: "Line one\nLine two" };
    const events = buildSongAutomationEvents({
      song: { id: "song-1", title: "Test Song" },
      cues: [
        { id: "cue-1", triggerFrame: 300, section: verse, ppSlideIndex: 0 },
        { id: "cue-2", triggerFrame: 600, section: verse, ppSlideIndex: 2 },
      ],
      format: { frameRate: 30, dropFrame: "ndf" },
      target: "both",
      offsetFrames: 15,
    });
    expect(events.map((event) => event.action)).toEqual([
      "lyrics-goto", "pp-trigger-slide", "lyrics-goto", "pp-trigger-slide", "lyrics-clear",
    ]);
    expect(events[0].triggerFrame).toBe(315);
    expect(events[0].toleranceFrames).toBe(5);
    expect(events[2].payload.sectionId).toBe("verse");
    expect(events[3].payload.slideIndex).toBe(2);
  });

  it("does not create ProPresenter events for unmapped slides", () => {
    const events = buildSongAutomationEvents({
      song: { id: "song-1", title: "Manual Song" },
      cues: [{ id: "cue-1", triggerFrame: 0, section: { id: "chorus", label: "Chorus", lyrics: "Sing" }, ppSlideIndex: null }],
      format: { frameRate: 25, dropFrame: "ndf" },
      target: "propresenter",
    });
    expect(events).toEqual([]);
  });
});
