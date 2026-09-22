import { describe, expect, it } from "vitest";
import {
  isSongDraftDirty,
  reconcileSavedSection,
  type SongDraft,
} from "@/lib/song-draft";

function draft(): SongDraft {
  return {
    metadata: {
      title: "Song",
      artist: "Artist",
      ccliNumber: "",
      bpm: "120",
      keySignature: "C",
    },
    sections: [
      { id: "verse", label: "Verse", lyrics: "Old verse", sourceSlideIndex: 0 },
      { id: "chorus", label: "Chorus", lyrics: "Old chorus", sourceSlideIndex: 1 },
    ],
    cueMap: {
      id: "map",
      name: "Default",
      format: { frameRate: 30, dropFrame: "ndf" },
      cues: [],
    },
  };
}

describe("song draft reconciliation", () => {
  it("marks any metadata, section, or cue-map change as unsaved", () => {
    const saved = draft();
    expect(isSongDraftDirty(saved, saved)).toBe(false);
    expect(
      isSongDraftDirty(
        { ...saved, metadata: { ...saved.metadata, artist: "New artist" } },
        saved,
      ),
    ).toBe(true);
    expect(
      isSongDraftDirty(
        { ...saved, cueMap: { ...saved.cueMap, name: "Broadcast" } },
        saved,
      ),
    ).toBe(true);
  });

  it("accepts one saved section without clearing unrelated drafts", () => {
    const saved = draft();
    const current = structuredClone(saved);
    current.metadata.artist = "Unsaved artist";
    current.sections[0].lyrics = "Saved verse";
    current.sections[1].lyrics = "Unsaved chorus";
    current.cueMap.name = "Unsaved map";

    const nextSaved = reconcileSavedSection(saved, current.sections[0]);
    expect(isSongDraftDirty(current, nextSaved)).toBe(true);
    expect(current.metadata.artist).toBe("Unsaved artist");
    expect(current.sections[1].lyrics).toBe("Unsaved chorus");
    expect(current.cueMap.name).toBe("Unsaved map");
    expect(nextSaved.sections[0].lyrics).toBe("Saved verse");
  });
});
