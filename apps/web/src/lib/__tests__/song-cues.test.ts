import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSongAutomationEvents } from "@/lib/song-cues";
import { replaceAutomationEventGroup } from "@/lib/timecode";

afterEach(() => vi.restoreAllMocks());

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
      "lyrics-goto", "pp-trigger-slide", "lyrics-goto", "pp-trigger-slide",
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
      clearAfterFrames: 90,
    });
    expect(events).toEqual([]);
  });

  it("times a ProPresenter clear from its last mapped slide", () => {
    const section = { id: "verse", label: "Verse", lyrics: "Text" };
    const events = buildSongAutomationEvents({ song: { id: "song", title: "Song" },
      cues: [{ id: "mapped", triggerFrame: 30, section, ppSlideIndex: 1 }, { id: "unmapped", triggerFrame: 300, section, ppSlideIndex: null }],
      format: { frameRate: 30, dropFrame: "ndf" }, target: "propresenter", clearAfterFrames: 90 });
    expect(events.map(event => [event.action, event.triggerFrame])).toEqual([["pp-trigger-slide", 30], ["pp-trigger-clear", 120]]);
  });

  it("replaces a previously loaded cue map instead of duplicating it", () => {
    const events = buildSongAutomationEvents({
      song: { id: "song-1", title: "Repeatable Song" },
      cueMapId: "map-1",
      cues: [{ id: "cue-1", triggerFrame: 30, section: { id: "verse", label: "Verse", lyrics: "Sing" }, ppSlideIndex: null }],
      format: { frameRate: 30, dropFrame: "ndf" },
      target: "native",
    });
    const sourceKey = events[0]?.sourceKey;
    expect(sourceKey).toBe("song:song-1:map:map-1:target:native:offset:0");
    if (!sourceKey) throw new Error("Expected a song event source key");

    const once = replaceAutomationEventGroup([], sourceKey, events);
    const twice = replaceAutomationEventGroup(once, sourceKey, events);
    expect(twice).toHaveLength(events.length);
    expect(twice.map((event) => event.action)).toEqual(["lyrics-goto"]);
  });

  it("holds the final lyric by default and only clears both outputs when explicitly scheduled", () => {
    const base = {
      song: { id: "song-1", title: "Hold Me" },
      cueMapId: "map-1",
      cues: [{ id: "cue-1", triggerFrame: 300, section: { id: "chorus", label: "Chorus", lyrics: "Hold" }, ppSlideIndex: 2 }],
      format: { frameRate: 30, dropFrame: "ndf" } as const,
      target: "both" as const,
      ppPresentationUuid: "presentation-1",
    };
    expect(buildSongAutomationEvents(base).map((event) => event.action)).toEqual([
      "lyrics-goto", "pp-trigger-slide",
    ]);
    const withClear = buildSongAutomationEvents({ ...base, clearAfterFrames: 90 });
    expect(withClear.map((event) => event.action)).toEqual([
      "lyrics-goto", "pp-trigger-slide", "lyrics-clear", "pp-trigger-clear",
    ]);
    expect(withClear[2].triggerFrame).toBe(390);
    expect(withClear[2].payload.generationKey).toBe(withClear[0].sourceKey);
  });
});

it.each([-1, 1.5, NaN, Infinity])("rejects unsafe cue offset %s instead of piling cues at frame zero", (offsetFrames) => {
  expect(() => buildSongAutomationEvents({
    song: { id: "song-1", title: "Offset" }, cues: [], format: { frameRate: 30, dropFrame: "ndf" },
    target: "native", offsetFrames,
  })).toThrow("zero or greater");
});

it.each([-1, 1.5, 9001, NaN, Infinity])("rejects invalid song tolerance %s instead of silently changing it", toleranceFrames => {
  expect(() => buildSongAutomationEvents({ song: { id: "song", title: "Song" }, cues: [],
    format: { frameRate: 30, dropFrame: "ndf" }, target: "native", toleranceFrames })).toThrow("Tolerance must be a whole number");
});

it.each([-1, 1.5, NaN, Infinity])("rejects an invalid clear hold: %s", clearAfterFrames => {
  expect(() => buildSongAutomationEvents({ song: { id: "song", title: "Song" }, cues: [],
    format: { frameRate: 30, dropFrame: "ndf" }, target: "native", clearAfterFrames })).toThrow("Clear hold");
});

it("does not schedule a clear beyond the valid timecode day", () => {
  expect(() => buildSongAutomationEvents({ song: { id: "song", title: "Song" },
    cues: [{ id: "last", triggerFrame: 2_591_999, section: { id: "verse", label: "Verse", lyrics: "Last" }, ppSlideIndex: null }],
    format: { frameRate: 30, dropFrame: "ndf" }, target: "native", clearAfterFrames: 1 })).toThrow("end of the timecode day");
});
