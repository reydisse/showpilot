import { describe, expect, it } from "vitest";
import { applyRundownTransport, parseRundownTransport, type RundownTimer } from "@showpilot/shared/rundown-transport";

const start = Date.parse("2026-11-06T12:00:00Z");
function fixture() {
  const timer: RundownTimer = { playback: "stop", currentItemId: null, elapsed: 0, startedAt: null, pausedAt: null, mode: "count-down" };
  return { items: [
    { id: "heading", title: "Opening", type: "header", status: "upcoming" as const, duration: 0 },
    { id: "welcome", title: "Welcome", type: "segment", status: "upcoming" as const, duration: 60_000 },
    { id: "middle-heading", title: "Main", type: "header", status: "upcoming" as const, duration: 0 },
    { id: "message", title: "Message", type: "segment", status: "upcoming" as const, duration: 120_000 },
  ], timer };
}

describe("shared cloud and local rundown transport", () => {
  it("resumes only the same paused item and starts a different item from zero", () => {
    const paused = { ...fixture(), timer: { ...fixture().timer, playback: "pause" as const, currentItemId: "welcome", elapsed: 42000, pausedAt: start } };
    expect(applyRundownTransport(paused, { type: "timer-start", itemId: "welcome" }, start + 1000)?.timer.elapsed).toBe(42000);
    expect(applyRundownTransport(paused, { type: "timer-start", itemId: "message" }, start + 1000)?.timer.elapsed).toBe(0);
  });

  it("jumps to a completed named item with fresh timing and preserves skipped rows", () => {
    const state = fixture();
    const playing = applyRundownTransport(state, { type: "timer-start", itemId: "message" }, start)!;
    playing.items[1] = { ...playing.items[1], status: "complete", actualStart: "old-start", actualEnd: "old-end" };
    const result = applyRundownTransport(playing, { type: "timer-goto", itemId: "welcome" }, start + 2000)!;
    expect(result.timer).toMatchObject({ currentItemId: "welcome", playback: "play", elapsed: 0, startedAt: start + 2000 });
    expect(result.items[1]).toMatchObject({ status: "live", actualStart: new Date(start + 2000).toISOString(), actualEnd: null });
    expect(result.items[3].status).toBe("complete");
    expect(result.items[0]).toEqual(state.items[0]);
    expect(result.items[2]).toEqual(state.items[2]);
    expect(playing.items[1].actualStart).toBe("old-start");
  });

  it("requires a valid explicit item for a jump, including when a current item exists", () => {
    for (const itemId of [undefined, "", " ", 7, "x".repeat(201)]) expect(parseRundownTransport("timer-goto", { itemId })).toBeNull();
    expect(parseRundownTransport("timer-goto", { itemId: " welcome " })).toEqual({ type: "timer-goto", itemId: "welcome" });
    for (const itemId of ["heading", "missing"]) expect(applyRundownTransport(fixture(), { type: "timer-goto", itemId }, start)).toBeNull();
  });

  it("preserves held time and adjustments through pause, resume, next, previous and show completion", () => {
    let state: { items: Array<{ id: string; title: string; type: string; status: "upcoming" | "live" | "complete"; duration: number; actualStart?: string | null; actualEnd?: string | null }>; timer: RundownTimer } = fixture();
    const command = (action: string, seconds: number, payload?: unknown) => {
      const parsed = parseRundownTransport(action, payload);
      if (!parsed) throw new Error("Invalid test command");
      const next = applyRundownTransport(state, parsed, start + seconds * 1000);
      if (!next) throw new Error("Invalid test transition");
      state = next;
    };
    command("timer-next", 0);
    expect(state.timer).toMatchObject({ currentItemId: "welcome", playback: "play", elapsed: 0 });
    command("timer-pause", 12);
    expect(state.timer).toMatchObject({ playback: "pause", elapsed: 12_000, startedAt: null });
    command("timer-adjust", 15, { deltaMs: 5000 });
    command("timer-resume", 20);
    command("timer-pause", 23);
    expect(state.timer.elapsed).toBe(10_000);
    command("timer-next", 25);
    expect(state.timer).toMatchObject({ currentItemId: "message", playback: "play", elapsed: 0 });
    expect(state.items[1]).toMatchObject({ status: "complete", actualStart: new Date(start).toISOString(), actualEnd: new Date(start + 25_000).toISOString() });
    command("timer-prev", 28);
    expect(state.timer.currentItemId).toBe("welcome");
    expect(state.items[3]).toMatchObject({ status: "upcoming", actualStart: null, actualEnd: null });
    command("timer-next", 31);
    command("timer-next", 35);
    expect(state.timer).toMatchObject({ playback: "stop", currentItemId: null, elapsed: 0 });
    expect(state.items.filter(item => item.type === "header").map(item => item.status)).toEqual(["upcoming", "upcoming"]);
    expect(state.items.filter(item => item.type !== "header").map(item => item.status)).toEqual(["complete", "complete"]);
  });

  it("keeps the original snapshot unchanged, including item metadata", () => {
    const state = fixture();
    const before = structuredClone(state);
    Object.freeze(state.timer);
    state.items.forEach(Object.freeze);
    Object.freeze(state.items);
    const next = applyRundownTransport(state, { type: "timer-start", itemId: "welcome" }, start);
    expect(state).toEqual(before);
    expect(next?.items[1]).toMatchObject({ title: "Welcome", duration: 60_000, status: "live" });
    expect(next?.items[1]).not.toBe(state.items[1]);
  });

  it("rejects invalid destinations and adjustments while stopped", () => {
    for (const itemId of ["heading", "missing"]) expect(applyRundownTransport(fixture(), { type: "timer-start", itemId }, start)).toBeNull();
    expect(applyRundownTransport(fixture(), { type: "timer-adjust", deltaMs: 1000 }, start)).toBeNull();
    for (const deltaMs of [NaN, Infinity, -Infinity, 86_400_001, "1000"]) expect(parseRundownTransport("timer-adjust", { deltaMs })).toBeNull();
    expect(parseRundownTransport("timer-start", { itemId: {} })).toBeNull();
    expect(parseRundownTransport("timer-mode", { mode: "invalid" })).toBeNull();
    expect(parseRundownTransport("replace-entire-show", {})).toBeNull();
  });
});
