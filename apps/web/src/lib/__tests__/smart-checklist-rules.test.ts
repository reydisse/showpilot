import { describe, expect, it } from "vitest";
import { deriveChecklistSuggestions, normalizeChecklistLabel } from "@/lib/smart-checklist-rules";
import type { RundownItem } from "@/types/rundown";

function item(id: string, title: string, overrides: Partial<RundownItem> = {}): RundownItem {
  return {
    id,
    title,
    type: "segment",
    duration: 300_000,
    notes: "",
    assignee: "",
    cue: "",
    status: "upcoming",
    sortOrder: 0,
    hardStop: false,
    ...overrides,
  };
}

describe("deriveChecklistSuggestions", () => {
  it("always includes the standard show-readiness checks", () => {
    const result = deriveChecklistSuggestions([]);
    expect(result.map((candidate) => candidate.id)).toEqual(expect.arrayContaining([
      "baseline-crew-checkin",
      "baseline-comms",
      "baseline-audio",
      "baseline-cameras",
      "baseline-presenter",
      "baseline-confidence",
      "baseline-led-screens",
      "baseline-lighting",
      "baseline-stream",
      "baseline-recording",
      "baseline-backup",
    ]));
    expect(result.every((candidate) => candidate.sourceItemIds.length === 0)).toBe(true);
  });

  it("combines duplicate rule matches into one explained suggestion", () => {
    const result = deriveChecklistSuggestions([
      item("song-1", "Opening worship", { type: "song" }),
      item("song-2", "Closing song", { type: "song" }),
    ]);
    const suggestion = result.find((candidate) => candidate.id === "audio-song-inputs");
    expect(suggestion?.sourceItemIds).toEqual(["song-1", "song-2"]);
  });

  it("reads titles, notes, cues, and assignments", () => {
    const result = deriveChecklistSuggestions([
      item("remote", "Guest conversation", { notes: "Guest joins over Zoom" }),
      item("media", "Welcome", { cue: "Roll video package" }),
    ]);
    expect(result.map((candidate) => candidate.id)).toEqual(
      expect.arrayContaining(["stream-remote-guest", "video-playback"]),
    );
  });

  it("ignores section headers", () => {
    const result = deriveChecklistSuggestions([item("header", "Livestream", { type: "header" })]);
    expect(result.some((candidate) => candidate.id === "stream-destinations")).toBe(false);
  });

  it("flags structural readiness gaps and hard stops", () => {
    const result = deriveChecklistSuggestions([
      item("sermon", "Message", { duration: 0, hardStop: true, assignee: "" }),
    ]);
    expect(result.map((candidate) => candidate.id)).toEqual(expect.arrayContaining([
      "general-unassigned-items",
      "general-missing-timing",
      "general-hard-stops",
    ]));
  });
});

describe("normalizeChecklistLabel", () => {
  it("normalizes punctuation and casing for deduplication", () => {
    expect(normalizeChecklistLabel(" Test VIDEO playback! ")).toBe("test video playback");
  });
});
