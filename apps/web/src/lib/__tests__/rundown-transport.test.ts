import { describe, it, expect } from "vitest";
import { start, pause, stop, next, previous, adjustTime } from "../rundown-transport";
import type { RundownItem, NativeTimerState } from "@/types/rundown";

function item(id: string, overrides: Partial<RundownItem> = {}): RundownItem {
  return {
    id,
    title: id,
    type: "segment",
    duration: 300000,
    notes: "",
    assignee: "",
    cue: "",
    status: "upcoming",
    sortOrder: 0,
    hardStop: false,
    ...overrides,
  };
}

const STOPPED: NativeTimerState = {
  playback: "stop",
  currentItemId: null,
  elapsed: 0,
  startedAt: null,
  pausedAt: null,
  mode: "count-down",
  serverTime: 0,
};

const items3 = () => [item("a"), item("b"), item("c")];

describe("start", () => {
  it("marks the target live and runs the timer from zero", () => {
    const r = start(items3(), STOPPED, "b", 1000);
    expect(r.timer).toMatchObject({
      playback: "play",
      currentItemId: "b",
      elapsed: 0,
      startedAt: 1000,
      pausedAt: null,
      serverTime: 1000,
    });
    expect(r.items.find((i) => i.id === "b")?.status).toBe("live");
  });

  it("marks the previously-current item complete", () => {
    const playingA = start(items3(), STOPPED, "a", 1000);
    const r = start(playingA.items, playingA.timer, "b", 2000);
    expect(r.items.find((i) => i.id === "a")?.status).toBe("complete");
    expect(r.items.find((i) => i.id === "b")?.status).toBe("live");
  });

  it("preserves the timer mode", () => {
    const r = start(items3(), { ...STOPPED, mode: "count-up" }, "a", 1000);
    expect(r.timer.mode).toBe("count-up");
  });

  it("does not mutate its inputs", () => {
    const items = items3();
    const timer = { ...STOPPED };
    start(items, timer, "b", 1000);
    expect(items.every((i) => i.status === "upcoming")).toBe(true);
    expect(timer.playback).toBe("stop");
  });
});

describe("pause", () => {
  it("banks elapsed time and switches to pause", () => {
    const playing = start(items3(), STOPPED, "a", 1000);
    const r = pause(playing.items, playing.timer, 4000);
    expect(r.timer).toMatchObject({ playback: "pause", elapsed: 3000, pausedAt: 4000 });
  });

  it("is a no-op when not playing", () => {
    const r = pause(items3(), STOPPED, 4000);
    expect(r.timer).toBe(STOPPED);
  });
});

describe("stop", () => {
  it("resets the timer and returns the current item to upcoming", () => {
    const playing = start(items3(), STOPPED, "b", 1000);
    const r = stop(playing.items, playing.timer);
    expect(r.timer).toMatchObject({ playback: "stop", currentItemId: null, elapsed: 0 });
    expect(r.items.find((i) => i.id === "b")?.status).toBe("upcoming");
  });

  it("preserves the timer mode", () => {
    const playing = start(items3(), { ...STOPPED, mode: "count-up" }, "a", 1000);
    expect(stop(playing.items, playing.timer).timer.mode).toBe("count-up");
  });
});

describe("next", () => {
  it("advances to the following item", () => {
    const playing = start(items3(), STOPPED, "a", 1000);
    const r = next(playing.items, playing.timer, 2000);
    expect(r.timer.currentItemId).toBe("b");
    expect(r.items.find((i) => i.id === "a")?.status).toBe("complete");
  });

  it("stops when on the last item", () => {
    const playing = start(items3(), STOPPED, "c", 1000);
    const r = next(playing.items, playing.timer, 2000);
    expect(r.timer.playback).toBe("stop");
    expect(r.timer.currentItemId).toBeNull();
  });

  it("starts the first item when nothing is live", () => {
    const r = next(items3(), STOPPED, 1000);
    expect(r.timer.currentItemId).toBe("a");
  });
});

describe("previous", () => {
  it("steps back to the prior item", () => {
    const playing = start(items3(), STOPPED, "b", 1000);
    const r = previous(playing.items, playing.timer, 2000);
    expect(r.timer.currentItemId).toBe("a");
    expect(r.timer.playback).toBe("play");
  });

  it("is a no-op at the first item (never wraps)", () => {
    const playing = start(items3(), STOPPED, "a", 1000);
    const r = previous(playing.items, playing.timer, 2000);
    expect(r.timer.currentItemId).toBe("a");
    expect(r.timer).toBe(playing.timer);
  });

  it("is a no-op when nothing is live", () => {
    const r = previous(items3(), STOPPED, 2000);
    expect(r.timer).toBe(STOPPED);
  });
});

describe("adjustTime", () => {
  it("adds time to a running timer by pushing startedAt forward", () => {
    const playing = start(items3(), STOPPED, "a", 1000); // startedAt 1000
    const r = adjustTime(playing.items, playing.timer, 60, 5000);
    // +60s → startedAt + 60000, clamped to now (5000) since that would be future
    expect(r.timer.startedAt).toBe(5000);
  });

  it("subtracting time on a running timer moves startedAt earlier (more elapsed)", () => {
    const playing = start(items3(), STOPPED, "a", 10000);
    const r = adjustTime(playing.items, playing.timer, -60, 12000);
    expect(r.timer.startedAt).toBe(10000 - 60000);
    expect(r.timer.playback).toBe("play");
  });

  it("adds time to a paused timer by reducing banked elapsed", () => {
    const playing = start(items3(), STOPPED, "a", 1000);
    const paused = pause(playing.items, playing.timer, 100000); // elapsed 99000
    const r = adjustTime(paused.items, paused.timer, 60, 120000);
    expect(r.timer.elapsed).toBe(99000 - 60000);
    expect(r.timer.playback).toBe("pause");
  });

  it("clamps paused elapsed so it never goes negative", () => {
    const playing = start(items3(), STOPPED, "a", 1000);
    const paused = pause(playing.items, playing.timer, 4000); // elapsed 3000
    const r = adjustTime(paused.items, paused.timer, 600, 5000); // +600s ≫ elapsed
    expect(r.timer.elapsed).toBe(0);
  });

  it("is a no-op when stopped", () => {
    const r = adjustTime(items3(), STOPPED, 60, 5000);
    expect(r.timer).toBe(STOPPED);
  });
});
