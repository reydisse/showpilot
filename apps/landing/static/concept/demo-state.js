/** Local demonstration only. This module never connects to a show or device. */
export const cues = Object.freeze([
  { name: "Opening", scene: "opening", durationMs: 300_000 },
  { name: "Welcome", scene: "welcome", durationMs: 300_000 },
  { name: "Keynote", scene: "keynote", durationMs: 480_000 },
  { name: "Closing", scene: "closing", durationMs: 300_000 },
]);

export function initialState(now) {
  return { cueIndex: 1, mode: "playing", remainingMs: 272_000, anchorMs: now };
}

export function selectCue(index, now) {
  return {
    cueIndex: index,
    mode: "playing",
    remainingMs: cues[index].durationMs,
    anchorMs: now,
  };
}

export function tick(state, now) {
  if (state.mode !== "playing") return state;
  let remainingMs = state.remainingMs - Math.max(0, now - state.anchorMs);
  let cueIndex = state.cueIndex;
  while (remainingMs <= 0) {
    if (cueIndex === cues.length - 1) {
      return { cueIndex, mode: "complete", remainingMs: 0, anchorMs: now };
    }
    cueIndex += 1;
    remainingMs += cues[cueIndex].durationMs;
  }
  return { cueIndex, mode: "playing", remainingMs, anchorMs: now };
}

export function togglePlayback(state, now) {
  const current = tick(state, now);
  if (current.mode === "complete") return selectCue(0, now);
  return {
    ...current,
    mode: current.mode === "playing" ? "paused" : "playing",
    anchorMs: now,
  };
}

export function nextCue(state, now) {
  if (state.cueIndex === cues.length - 1) {
    return {
      cueIndex: state.cueIndex,
      mode: "complete",
      remainingMs: 0,
      anchorMs: now,
    };
  }
  return selectCue(state.cueIndex + 1, now);
}

export function formatClock(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
