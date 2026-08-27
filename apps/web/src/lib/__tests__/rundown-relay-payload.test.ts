import { describe, expect, it } from "vitest";
import {
  parseExactRelayOrder,
  parseRelayItemUpdates,
  parseRelayPPSlide,
  parseRelayRundownItems,
  parseRelayTimer,
} from "../rundown-relay-payload";

const item = {
  id: "item-1",
  title: "Welcome",
  type: "segment",
  duration: 300_000,
  notes: "",
  assignee: "Host",
  cue: "GO",
  status: "upcoming",
  sortOrder: 99,
  hardStop: false,
};

describe("rundown relay payload parsing", () => {
  it("normalizes order while preserving valid operational fields", () => {
    expect(parseRelayRundownItems([{ ...item, scheduledStart: "2026-08-30T09:00:00Z" }]))
      .toEqual([{ ...item, sortOrder: 0, scheduledStart: "2026-08-30T09:00:00Z" }]);
  });

  it("rejects duplicate IDs and unbounded or invalid items", () => {
    expect(parseRelayRundownItems([item, item])).toBeNull();
    expect(parseRelayRundownItems([{ ...item, duration: Number.NaN }])).toBeNull();
    expect(parseRelayRundownItems([{ ...item, title: "x".repeat(501) }])).toBeNull();
  });

  it("limits edits to editorial fields", () => {
    expect(parseRelayItemUpdates({ title: "Opening", duration: 60_000 })).toEqual({
      title: "Opening",
      duration: 60_000,
    });
    expect(parseRelayItemUpdates({ status: "complete" })).toBeNull();
  });

  it("accepts only an exact permutation for reorder", () => {
    expect(parseExactRelayOrder(["item-2", "item-1"], ["item-1", "item-2"]))
      .toEqual(["item-2", "item-1"]);
    expect(parseExactRelayOrder(["item-1"], ["item-1", "item-2"])).toBeNull();
    expect(parseExactRelayOrder(["item-1", "missing"], ["item-1", "item-2"])).toBeNull();
  });

  it("rejects malformed timer snapshots", () => {
    expect(parseRelayTimer({
      playback: "stop",
      currentItemId: null,
      elapsed: 0,
      startedAt: null,
      pausedAt: null,
      mode: "count-down",
    })).not.toBeNull();
    expect(parseRelayTimer({ playback: "warp" })).toBeNull();
  });

  it("accepts only bounded ProPresenter slide fields", () => {
    expect(parseRelayPPSlide({
      text: "Amazing grace",
      notes: "Verse 1",
      presentationName: "Worship",
      isScripture: false,
      ignored: "not persisted",
    })).toEqual({
      text: "Amazing grace",
      notes: "Verse 1",
      presentationName: "Worship",
      isScripture: false,
    });
    expect(parseRelayPPSlide({ text: "x".repeat(20_001), notes: "", presentationName: "", isScripture: false })).toBeNull();
    expect(parseRelayPPSlide("slide")).toBeNull();
  });
});
