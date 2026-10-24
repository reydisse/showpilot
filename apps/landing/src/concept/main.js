import {
  cues,
  initialState,
  selectCue,
  nextCue,
  togglePlayback,
  tick,
  formatClock,
} from "../../static/concept/demo-state.js";

const $ = (selector) => document.querySelector(selector);
const rows = [...document.querySelectorAll("[data-cue]")];
const phases = [...document.querySelectorAll("[data-phase]")];
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
let paused = reduced.matches;
let state = { ...initialState(performance.now()), mode: "paused" };
let desk = null;
let phase = 0;
let interval;
function announce(message) {
  $("#announcement").textContent = message;
}
function paint() {
  $("#timer").textContent = formatClock(state.remainingMs);
  $("#current-cue").textContent =
    state.mode === "complete" ? "Show complete" : cues[state.cueIndex].name;
  $("#live-status").textContent =
    state.mode === "playing"
      ? "ON AIR"
      : state.mode === "complete"
        ? "COMPLETE"
        : "STAND BY";
  $("#playback").textContent =
    state.mode === "playing"
      ? "Pause"
      : state.mode === "complete"
        ? "Replay"
        : "Play";
  $("#next").disabled = state.mode === "complete";
  rows.forEach((row, i) =>
    row.setAttribute("aria-current", String(i === state.cueIndex)),
  );
  $("#world").dataset.live = String(state.mode === "playing");
}
function sync() {
  paint();
  desk?.setCue(state.cueIndex, state.mode === "playing");
  announce(
    state.mode === "complete"
      ? "Show complete"
      : `${cues[state.cueIndex].name}, ${state.mode === "playing" ? "on air" : "stand by"}`,
  );
}
function setPhase(value) {
  phase = value;
  phases.forEach((button, i) =>
    button.setAttribute("aria-pressed", String(i === value)),
  );
  desk?.setPhase(value);
}
function go() {
  state =
    state.mode === "paused"
      ? togglePlayback(state, performance.now())
      : state.mode === "complete"
        ? selectCue(0, performance.now())
        : nextCue(state, performance.now());
  setPhase(2);
  sync();
}
$("#call-cue").addEventListener("click", go);
$("#playback").addEventListener("click", () => {
  state = togglePlayback(state, performance.now());
  sync();
});
$("#next").addEventListener("click", () => {
  state = nextCue(state, performance.now());
  setPhase(2);
  sync();
});
$("#reset").addEventListener("click", () => {
  state = { ...initialState(performance.now()), mode: "paused" };
  setPhase(0);
  sync();
});
rows.forEach((row, i) =>
  row.addEventListener("click", () => {
    state = selectCue(i, performance.now());
    setPhase(2);
    sync();
  }),
);
phases.forEach((button, i) =>
  button.addEventListener("click", () => {
    setPhase(i);
    if (i === 2 && state.mode === "paused") {
      state = togglePlayback(state, performance.now());
      sync();
    } else if (i < 2 && state.mode === "playing") {
      state = togglePlayback(state, performance.now());
      sync();
    }
  }),
);
function updateMotion() {
  document.documentElement.classList.toggle("motion-paused", paused);
  $("#motion").textContent = paused ? "Resume motion" : "Pause motion";
  $("#motion").setAttribute("aria-pressed", String(paused));
  desk?.setPaused(paused);
}
$("#motion").addEventListener("click", () => {
  paused = !paused;
  updateMotion();
});
reduced.addEventListener("change", () => {
  paused = reduced.matches;
  updateMotion();
});
let scheduled = false;
window.addEventListener(
  "scroll",
  () => {
    if (scheduled || paused) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const length = $(".experience").offsetHeight - $(".stage").offsetHeight;
      const progress = Math.max(0, Math.min(1, scrollY / Math.max(1, length)));
      const nextPhase = Math.min(2, Math.floor(progress * 3));
      if (nextPhase !== phase) {
        setPhase(nextPhase);
        if (nextPhase === 2 && state.mode === "paused") {
          state = togglePlayback(state, performance.now());
          sync();
        }
      }
    });
  },
  { passive: true },
);
function startClock() {
  clearInterval(interval);
  if (!document.hidden)
    interval = setInterval(() => {
      const previous = state.cueIndex;
      const previousMode = state.mode;
      state = tick(state, performance.now());
      paint();
      if (previous !== state.cueIndex || previousMode !== state.mode)
        desk?.setCue(state.cueIndex, state.mode === "playing");
    }, 250);
}
document.addEventListener("visibilitychange", startClock);
window.addEventListener("pagehide", () => clearInterval(interval));
window.addEventListener("pageshow", startClock);
function fallback() {
  document.documentElement.classList.add("no-webgl");
  $("#scene").replaceChildren();
  $("#screen-layer").replaceChildren($("#rundown"));
  $("#rundown").style.cssText = "";
  $(".fallback-note").hidden = false;
  $("#motion").hidden = true;
}
paint();
updateMotion();
startClock();
try {
  const { createDesk } = await import("./scene.js");
  desk = createDesk({
    host: $("#scene"),
    layer: $("#screen-layer"),
    screen: $("#rundown"),
    crew: $("#crew-card"),
    onGo: go,
    onFailure: fallback,
  });
  desk.setPhase(phase);
  desk.setPaused(paused);
  desk.setCue(state.cueIndex, state.mode === "playing");
  document.documentElement.dataset.scene = "ready";
} catch (error) {
  fallback();
  document.documentElement.dataset.scene = "fallback";
  console.warn(
    "3D preview unavailable; using the accessible rundown.",
    error.message,
  );
}
// Preserve the same referral and campaign behavior as the current landing page.
const query = new URLSearchParams(location.search);
for (const link of document.querySelectorAll(
  'a[href*="showpilot.tech/login"]',
)) {
  const url = new URL(link.href);
  for (const [key, value] of query)
    if (key === "ref" || key.startsWith("utm_"))
      url.searchParams.set(key, value);
  link.href = url.href;
}
