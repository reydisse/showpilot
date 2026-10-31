import { describe, expect, it } from "vitest";
import {
  confidenceLayoutSchema,
  DEFAULT_CONFIDENCE_LAYOUT,
  isConfidenceAdvance,
  readConfidenceLayout,
} from "../confidence-layout";
import { parseRelayPPSlide } from "../rundown-relay-payload";
import { projectRundownDisplayState } from "../rundown-display";
import { preferredDeckLinkMode } from "../confidence-output";

const slide = {
  text: "Current",
  notes: "",
  presentationName: "Song",
  isScripture: false,
  slideId: "a",
  nextText: "Upcoming",
  nextSlideId: "b",
};
describe("confidence screen contracts", () => {
  it("preserves existing colors and fonts when adding next-text controls to saved layouts", () => {
    const old = { ...DEFAULT_CONFIDENCE_LAYOUT, lyrics: { ...DEFAULT_CONFIDENCE_LAYOUT.lyrics, font: "serif", color: "#ffaa00", nextSize: undefined } };
    const saved = readConfidenceLayout(JSON.stringify(old));
    expect(saved.lyrics.font).toBe("serif");
    expect(saved.lyrics.color).toBe("#ffaa00");
    expect(saved.lyrics.nextSize).toBe(1);
    expect(saved.lyrics.nextColor).toBeUndefined();
  });
  it("moves the next slide only on an actual advance, never a heartbeat, edit, or jump", () => {
    expect(isConfidenceAdvance(slide, { ...slide })).toBe(false);
    expect(
      isConfidenceAdvance(slide, { ...slide, nextText: "Edited upcoming" }),
    ).toBe(false);
    expect(
      isConfidenceAdvance(slide, { ...slide, slideId: "b", text: "Upcoming" }),
    ).toBe(true);
    expect(
      isConfidenceAdvance(slide, {
        ...slide,
        slideId: "unrelated",
        text: "Upcoming",
      }),
    ).toBe(false);
    expect(
      isConfidenceAdvance(
        { ...slide, nextSlideId: undefined },
        { ...slide, slideId: undefined, text: "Upcoming" },
      ),
    ).toBe(true);
  });
  it("keeps scripture and lyric settings independent, with the existing message style by default", () => {
    const parsed = confidenceLayoutSchema.parse(DEFAULT_CONFIDENCE_LAYOUT);
    expect(parsed.stageMessage.useDefault).toBe(true);
    expect(parsed.lyrics.showNext).toBe(true);
    expect(parsed.scripture.showNext).toBe(false);
    expect(readConfidenceLayout("invalid JSON")).toEqual(
      DEFAULT_CONFIDENCE_LAYOUT,
    );
    expect(
      confidenceLayoutSchema.safeParse({
        ...parsed,
        lyrics: { ...parsed.lyrics, color: "red; display:none" },
      }).success,
    ).toBe(false);
  });
  it("bounds new public slide fields and preserves them through projection", () => {
    expect(
      parseRelayPPSlide({ ...slide, nextText: "x".repeat(20001) }),
    ).toBeNull();
    expect(parseRelayPPSlide({ ...slide, nextSlideId: 2 })).toBeNull();
    const parsed = parseRelayPPSlide(slide);
    expect(parsed).toEqual(slide);
    expect(
      projectRundownDisplayState({
        items: [],
        timer: {
          playback: "stop",
          currentItemId: null,
          elapsed: 0,
          startedAt: null,
          pausedAt: null,
          mode: "count-down",
        },
        ppSlide: { ...slide, updatedAt: 1 },
      }).ppSlide,
    ).toEqual({ ...slide, updatedAt: 1 });
  });
  it("accepts old Bridge payloads without fabricating a next slide", () => {
    expect(
      parseRelayPPSlide({
        text: "Legacy",
        notes: "",
        presentationName: "",
        isScripture: false,
      }),
    ).toEqual({
      text: "Legacy",
      notes: "",
      presentationName: "",
      isScripture: false,
    });
  });
  it("prefers the user's exact default without limiting other hardware formats", () => {
    const hd60 = {
      id: 1,
      name: "1080p60",
      width: 1920,
      height: 1080,
      frameDuration: 1,
      timeScale: 60,
    };
    const hd5994 = {
      ...hd60,
      id: 2,
      name: "1080p59.94",
      frameDuration: 1001,
      timeScale: 60000,
    };
    const uhd = {
      ...hd60,
      id: 3,
      name: "2160p50",
      width: 3840,
      height: 2160,
      timeScale: 50,
    };
    expect(preferredDeckLinkMode([hd60, uhd, hd5994])).toEqual(hd5994);
    expect(preferredDeckLinkMode([uhd])).toEqual(uhd);
    expect(preferredDeckLinkMode([])).toBeUndefined();
  });
});
