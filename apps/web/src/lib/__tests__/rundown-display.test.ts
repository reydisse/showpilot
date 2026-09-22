import { describe, expect, it } from "vitest";
import { projectRundownDisplayState } from "../rundown-display";
import type { RundownState } from "@/types/rundown";

describe("public rundown display projection", () => {
  it("removes operator notes, assignments and cue automation", () => {
    const state: RundownState = {
      items: [{
        id: "item-1",
        title: "Welcome",
        type: "segment",
        duration: 60_000,
        notes: "Private operator note",
        assignee: "Private Person",
        cue: "Trigger private automation",
        status: "live",
        sortOrder: 0,
        hardStop: false,
        lowerThirdId: "graphic-1",
      }],
      timer: {
        playback: "play",
        currentItemId: "item-1",
        elapsed: 2_000,
        startedAt: 100,
        pausedAt: null,
        mode: "count-down",
        serverTime: 100,
      },
    };

    const result = projectRundownDisplayState(state);

    expect(result.items).toEqual([{
      id: "item-1",
      title: "Welcome",
      type: "segment",
      duration: 60_000,
      status: "live",
      sortOrder: 0,
      hardStop: false,
    }]);
    expect(result.items[0]).not.toHaveProperty("notes");
    expect(result.items[0]).not.toHaveProperty("assignee");
    expect(result.items[0]).not.toHaveProperty("cue");
    expect(result.items[0]).not.toHaveProperty("lowerThirdId");
  });
});
