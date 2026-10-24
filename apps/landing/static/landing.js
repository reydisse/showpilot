import {
  cues,
  initialState,
  selectCue,
  nextCue,
  togglePlayback,
  tick,
  formatClock,
} from "./concept/demo-state.js";

// This demonstration is entirely local. No controls connect to a real show.
const $ = (selector) => document.querySelector(selector);
let state = { ...initialState(performance.now()), mode: "paused" };
const rows = [...document.querySelectorAll("[data-demo-cue]")];
let timer;
function paint(announce = false) {
  const complete = state.mode === "complete";
  const name = complete ? "Show complete" : cues[state.cueIndex].name;
  $("#demo-cue").textContent = name;
  $("#demo-clock").textContent = formatClock(state.remainingMs);
  $("[data-stage-clock]").textContent = formatClock(state.remainingMs);
  $("[data-stage-next]").textContent =
    cues[state.cueIndex + 1]?.name ?? "Show complete";
  $("#panel-live .stage-preview > .micro").textContent = name.toUpperCase();
  $("#demo-status").textContent = complete
    ? "COMPLETE"
    : state.mode === "playing"
      ? "LIVE"
      : "STAND BY";
  $("#demo-play").textContent = complete
    ? "Replay"
    : state.mode === "playing"
      ? "Pause"
      : "Play";
  $("#demo-next").disabled = complete;
  rows.forEach((row, index) =>
    row.setAttribute(
      "aria-current",
      String(!complete && index === state.cueIndex),
    ),
  );
  if (announce)
    $("#demo-announcement").textContent =
      `${name}. ${$("#demo-status").textContent.toLowerCase()}.`;
}
$("#demo-go").addEventListener("click", () => {
  state =
    state.mode === "playing"
      ? nextCue(state, performance.now())
      : togglePlayback(state, performance.now());
  paint(true);
  if (matchMedia("(max-width: 620px)").matches)
    $(".show-console").scrollIntoView({
      block: "center",
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
});
$("#demo-play").addEventListener("click", () => {
  state = togglePlayback(state, performance.now());
  paint(true);
});
$("#demo-next").addEventListener("click", () => {
  state = nextCue(state, performance.now());
  paint(true);
});
$("#demo-reset").addEventListener("click", () => {
  state = { ...initialState(performance.now()), mode: "paused" };
  paint(true);
});
rows.forEach((row, index) =>
  row.addEventListener("click", () => {
    state = selectCue(index, performance.now());
    paint(true);
  }),
);
function updateClock() {
  clearInterval(timer);
  if (document.hidden) return;
  state = tick(state, performance.now());
  paint();
  timer = setInterval(() => {
    state = tick(state, performance.now());
    paint();
  }, 250);
}
document.addEventListener("visibilitychange", updateClock);
window.addEventListener("pagehide", () => clearInterval(timer));
window.addEventListener("pageshow", updateClock);
updateClock();

const tabs = [...document.querySelectorAll("[data-workflow]")];
function selectTab(tab, focus = false) {
  tabs.forEach((item) => {
    const selected = item === tab;
    item.setAttribute("aria-selected", String(selected));
    item.tabIndex = selected ? 0 : -1;
    document.getElementById(item.getAttribute("aria-controls")).hidden =
      !selected;
  });
  if (focus) tab.focus();
}
tabs.forEach((tab, index) => {
  tab.addEventListener("click", () => selectTab(tab));
  tab.addEventListener("keydown", (event) => {
    const next =
      event.key === "ArrowDown"
        ? (index + 1) % tabs.length
        : event.key === "ArrowUp"
          ? (index + tabs.length - 1) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    selectTab(tabs[next], true);
  });
});

const menu = $(".menu-toggle");
function closeMenu() {
  menu.setAttribute("aria-expanded", "false");
  menu.setAttribute("aria-label", "Open menu");
  $("#navigation").classList.remove("is-open");
}
menu.addEventListener("click", () => {
  const open = menu.getAttribute("aria-expanded") !== "true";
  menu.setAttribute("aria-expanded", String(open));
  menu.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  $("#navigation").classList.toggle("is-open", open);
});
$("#navigation").addEventListener("click", (event) => {
  if (event.target.closest("a")) closeMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && menu.getAttribute("aria-expanded") === "true") {
    closeMenu();
    menu.focus();
  }
});
matchMedia("(max-width: 620px)").addEventListener("change", closeMenu);
$("#copyright-year").textContent = new Date().getFullYear();

const campaign = new URLSearchParams(location.search);
document.querySelectorAll("a[data-cta]").forEach((link) => {
  const url = new URL(link.href);
  for (const [key, value] of campaign)
    if (key === "ref" || key.startsWith("utm_"))
      url.searchParams.set(key, value);
  link.href = url.href;
});
