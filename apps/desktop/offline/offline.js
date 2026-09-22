const CLOUD_ORIGIN = "https://showpilot.tech";
const app = document.getElementById("app");
let snapshot = null;
let timer = null;
let timerTick = null;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function validSnapshot(value) {
  return value && typeof value === "object" && value.version === 1
    && typeof value.orgId === "string" && typeof value.orgSlug === "string"
    && typeof value.serviceDate === "string" && Array.isArray(value.items)
    && value.items.length <= 1000 && value.items.every((item) => item && typeof item === "object" && typeof item.id === "string" && typeof item.title === "string" && typeof item.duration === "number");
}

async function cloudAvailable() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    await fetch(`${CLOUD_ORIGIN}/favicon.ico?desktop-probe=${Date.now()}`, { mode: "no-cors", cache: "no-store", signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function reconnect(button, error) {
  button.disabled = true;
  button.textContent = "Checking…";
  error.textContent = "";
  if (await cloudAvailable()) {
    window.location.replace(CLOUD_ORIGIN);
    return;
  }
  button.disabled = false;
  button.textContent = "Retry connection";
  error.textContent = "ShowPilot Cloud is still unreachable. Local rehearsal remains available.";
}

function formatDuration(milliseconds) {
  const negative = milliseconds < 0;
  const total = Math.max(0, Math.floor(Math.abs(milliseconds) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${negative ? "+" : ""}${hours ? `${String(hours).padStart(2, "0")}:` : ""}${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function playableItems() {
  return snapshot.items.filter((item) => item.type !== "header" && item.type !== "heading" && item.type !== "section");
}

function currentItem() {
  return snapshot.items.find((item) => item.id === timer.currentItemId) || playableItems()[0] || null;
}

function elapsedNow() {
  return timer.playback === "play" && timer.startedAt ? timer.elapsed + (Date.now() - timer.startedAt) : timer.elapsed;
}

function selectItem(id) {
  timer.currentItemId = id;
  timer.elapsed = 0;
  timer.startedAt = timer.playback === "play" ? Date.now() : null;
  renderWorkspace();
}

function moveCue(direction) {
  const items = playableItems();
  const current = Math.max(0, items.findIndex((item) => item.id === timer.currentItemId));
  const next = items[Math.min(items.length - 1, Math.max(0, current + direction))];
  if (next) selectItem(next.id);
}

function renderWorkspace() {
  clearInterval(timerTick);
  app.replaceChildren();
  const shell = element("div", "shell");
  const topbar = element("header", "topbar");
  const pill = element("span", "offline-pill");
  pill.append(element("span", "offline-dot"), document.createTextNode("OFFLINE LOCAL"));
  const heading = element("div", "heading");
  heading.append(element("h1", "", snapshot.serviceName || "Cached service"), element("p", "", `${snapshot.serviceDate} · Cached ${snapshot.cachedAt ? new Date(snapshot.cachedAt).toLocaleString() : "on this Mac"}`));
  const retry = element("button", "button", "Retry connection");
  const retryError = element("span", "error");
  retry.addEventListener("click", () => reconnect(retry, retryError));
  topbar.append(pill, heading, retry, retryError);

  const workspace = element("div", "workspace");
  const listPanel = element("section", "panel");
  const listHead = element("div", "panel-head");
  listHead.append(element("h2", "", "Cached rundown"), element("span", "", `${snapshot.items.length} items`));
  const notice = element("p", "notice", "Local rehearsal mode. These controls run only on this Mac and do not update ShowPilot Cloud, venue devices, kiosks, lyrics, or teammates.");
  const rundown = element("div", "rundown");
  snapshot.items.forEach((item, index) => {
    const header = item.type === "header" || item.type === "heading" || item.type === "section";
    const cue = element("button", `cue${item.id === timer.currentItemId ? " active" : ""}${header ? " header" : ""}`);
    cue.type = "button";
    cue.disabled = header;
    if (!header) cue.addEventListener("click", () => selectItem(item.id));
    cue.append(element("span", "cue-num", header ? "—" : String(index + 1).padStart(2, "0")));
    const copy = element("span");
    copy.append(element("span", "cue-title", item.title), element("span", "cue-note", item.notes || item.cue || item.type || "Rundown item"));
    cue.append(copy, element("span", "cue-time", header ? "" : formatDuration(item.duration)));
    rundown.append(cue);
  });
  listPanel.append(listHead, notice, rundown);

  const engine = element("aside", "panel engine");
  const engineHead = element("div", "panel-head");
  engineHead.append(element("h2", "", "Local timer"), element("span", "", "REHEARSAL ONLY"));
  const clock = element("div", "clock");
  const current = element("div", "current");
  const controls = element("div", "controls");
  const play = element("button", "button primary", timer.playback === "play" ? "Pause local timer" : "Start local timer");
  play.addEventListener("click", () => {
    if (timer.playback === "play") { timer.elapsed = elapsedNow(); timer.startedAt = null; timer.playback = "pause"; }
    else { timer.startedAt = Date.now(); timer.playback = "play"; }
    renderWorkspace();
  });
  const previous = element("button", "button", "Previous cue");
  previous.addEventListener("click", () => moveCue(-1));
  const next = element("button", "button", "Next cue");
  next.addEventListener("click", () => moveCue(1));
  const reset = element("button", "button", "Reset timer");
  reset.addEventListener("click", () => { timer.elapsed = 0; timer.startedAt = timer.playback === "play" ? Date.now() : null; updateClock(); });
  controls.append(play, previous, next, reset);
  engine.append(engineHead, clock, current, controls);

  function updateClock() {
    const item = currentItem();
    current.textContent = item?.title || "No playable cue in this snapshot";
    const elapsed = elapsedNow();
    clock.textContent = timer.mode === "count-up" ? formatDuration(elapsed) : formatDuration((item?.duration || 0) - elapsed);
  }
  updateClock();
  timerTick = setInterval(updateClock, 200);
  workspace.append(listPanel, engine);
  shell.append(topbar, workspace);
  app.append(shell);
}

function renderEmpty(message) {
  app.replaceChildren();
  const wrapper = element("div", "empty");
  const panel = element("section", "panel");
  panel.append(element("div", "brand-mark", "SP"), element("p", "eyebrow", "SHOWPILOT DESKTOP · OFFLINE"), element("h1", "", "No local show is available"), element("p", "", message));
  const retry = element("button", "button primary", "Retry connection");
  const error = element("p", "error");
  retry.addEventListener("click", () => reconnect(retry, error));
  panel.append(retry, error);
  wrapper.append(panel);
  app.append(wrapper);
}

async function start() {
  const online = await cloudAvailable();
  if (online) { window.location.replace(CLOUD_ORIGIN); return; }
  try {
    const payload = await window.__TAURI__.core.invoke("get_cached_service");
    const parsed = payload ? JSON.parse(payload) : null;
    if (!validSnapshot(parsed)) { renderEmpty("Connect once and open a rundown to save a bounded offline snapshot on this Mac."); return; }
    snapshot = parsed;
    const cachedAt = snapshot.cachedAt ? new Date(snapshot.cachedAt).getTime() : Date.now();
    const sourceTimer = snapshot.timer && typeof snapshot.timer === "object" ? snapshot.timer : {};
    const elapsedAtCache = Number(sourceTimer.elapsed) || 0;
    const wasRunning = sourceTimer.playback === "play" && Number.isFinite(sourceTimer.startedAt);
    timer = { playback: "pause", currentItemId: typeof sourceTimer.currentItemId === "string" ? sourceTimer.currentItemId : null, elapsed: Math.max(0, elapsedAtCache + (wasRunning ? Math.max(0, cachedAt - sourceTimer.startedAt) : 0)), startedAt: null, mode: sourceTimer.mode === "count-up" ? "count-up" : "count-down" };
    renderWorkspace();
  } catch {
    renderEmpty("The saved snapshot could not be read. Reconnect to ShowPilot Cloud to refresh it.");
  }
}

void start();
