const CLOUD_ORIGIN = "https://app.showpilot.tech";
const app = document.getElementById("app");
let state = null;
let view = null;
let polling = false;
let pendingRead = null;
let healthy = false;
let controlPending = false;
let serverOffset = 0;
let lastFailure = null;
const deviceRequests = new Set();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text, action, className = "button") {
  const node = element("button", className, text);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, limit) =>
  typeof value === "string" && value.length <= limit;
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const id = (value) =>
  typeof value === "string" && /^[A-Za-z0-9:_-]{1,100}$/.test(value);

function parseStatus(value) {
  if (
    !record(value) ||
    !["empty", "prepared", "active", "finished", "reconciled"].includes(
      value.mode,
    ) ||
    ![
      "cloud",
      "entering-local",
      "local",
      "local-held",
      "leaving-local",
      "stopped",
    ].includes(value.commandSource) ||
    (value.storageError != null && !text(value.storageError, 2000))
  )
    throw new Error(
      "The local engine returned an unreadable show. Update Desktop and retry.",
    );
  if (value.mode === "empty") return value;
  if (
    !id(value.sessionId) ||
    !id(value.orgId) ||
    !id(value.showId) ||
    !text(value.title, 500) ||
    !text(value.serviceDate, 10) ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 0 ||
    !Number.isSafeInteger(value.baseRevision) ||
    value.baseRevision < 0 ||
    !finite(value.preparedAt) ||
    !finite(value.expiresAt) ||
    !finite(value.serverTime) ||
    typeof value.ready !== "boolean" ||
    !Array.isArray(value.items) ||
    value.items.length > 1000 ||
    !value.items.every(
      (item) =>
        record(item) &&
        id(item.id) &&
        text(item.title, 1000) &&
        text(item.type, 50) &&
        text(item.notes, 10000) &&
        text(item.cue, 1000) &&
        finite(item.duration) &&
        item.duration >= 0 &&
        ["upcoming", "live", "complete"].includes(item.status),
    ) ||
    !record(value.timer) ||
    !["play", "pause", "stop"].includes(value.timer.playback) ||
    !["count-up", "count-down", "clock"].includes(value.timer.mode) ||
    !finite(value.timer.elapsed) ||
    !(
      value.timer.currentItemId === null ||
      value.items.some((item) => item.id === value.timer.currentItemId)
    ) ||
    !(value.timer.startedAt === null || finite(value.timer.startedAt)) ||
    !Array.isArray(value.actions) ||
    value.actions.length > 500 ||
    !value.actions.every(
      (action) =>
        record(action) &&
        id(action.id) &&
        id(action.deviceId) &&
        text(action.label, 500),
    ) ||
    !Array.isArray(value.results) ||
    value.results.length > 2000 ||
    !value.results.every(
      (result) =>
        record(result) &&
        id(result.requestId) &&
        id(result.actionId) &&
        ["pending", "acknowledged", "sent", "failed", "unknown"].includes(
          result.result,
        ),
    )
  )
    throw new Error(
      "The saved local show is incomplete. Keep its journal and reconnect to refresh the show.",
    );
  return value;
}

async function invokeNative(command, args) {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke)
    throw new Error(
      "Local show control requires the current ShowPilot Desktop app.",
    );
  let timeout;
  try {
    return await Promise.race([
      invoke(command, args),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                "The local engine has not replied. Refresh its status before retrying; a device action may already have been sent.",
              ),
            ),
          18000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function native(request) {
  return invokeNative("local_show_command", { request });
}

async function cloudAvailable() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    await fetch(`${CLOUD_ORIGIN}/favicon.ico?desktop-probe=${Date.now()}`, {
      mode: "no-cors",
      cache: "no-store",
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
function errorText(cause) {
  return cause instanceof Error
    ? cause.message
    : typeof cause === "string"
      ? cause
      : "The local action could not be confirmed. Refresh its status before retrying.";
}
function formatDuration(milliseconds) {
  const total = Math.floor(Math.abs(milliseconds) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${milliseconds < 0 ? "+" : ""}${hours ? `${String(hours).padStart(2, "0")}:` : ""}${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
function showFailure(cause, request = null) {
  lastFailure = { message: errorText(cause), request };
  update();
}
function confirmation(title, message, label, action) {
  if (document.querySelector("dialog")) return;
  const dialog = element("dialog", "confirm-dialog");
  const heading = element("h2", "", title);
  heading.id = "confirm-heading";
  dialog.setAttribute("aria-labelledby", heading.id);
  const controls = element("div", "dialog-actions");
  const previousFocus = document.activeElement;
  const close = () => {
    dialog.close();
    dialog.remove();
    previousFocus?.focus();
  };
  const cancel = button("Cancel", close);
  const confirm = button(
    label,
    () => {
      close();
      void action();
    },
    "button primary",
  );
  controls.append(cancel, confirm);
  dialog.append(heading, element("p", "", message), controls);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  document.body.append(dialog);
  dialog.showModal();
  cancel.focus();
}

function accept(value) {
  state = parseStatus(value);
  healthy = true;
  if (state.mode !== "empty") serverOffset = state.serverTime - Date.now();
  if (
    view?.sessionId !== (state.mode === "empty" ? null : state.sessionId) ||
    view?.preparedAt !== state.preparedAt ||
    view?.unavailable === true
  )
    render();
  update();
}
async function refresh(fresh = false) {
  if (pendingRead) {
    await pendingRead;
    if (fresh) return refresh();
    return;
  }
  polling = true;
  pendingRead = (async () => {
    try {
      accept(await native({ operation: "status" }));
    } catch (cause) {
      healthy = false;
      if (!lastFailure?.request) showFailure(cause);
      if (!view) render();
    }
  })();
  try {
    await pendingRead;
  } finally {
    pendingRead = null;
    polling = false;
    update();
  }
}
async function send(request) {
  const device = request.operation === "device";
  if (device) deviceRequests.add(request.actionId);
  else controlPending = true;
  lastFailure = null;
  update();
  try {
    // Mutations can finish out of order. Read a fresh snapshot after completion
    // instead of replacing the screen with a delayed command response.
    await native(request);
    await refresh(true);
  } catch (cause) {
    showFailure(cause, request);
    await refresh(true);
  } finally {
    if (device) deviceRequests.delete(request.actionId);
    else controlPending = false;
    update();
  }
}
async function transport(action, payload) {
  if (!canControl()) return;
  const sessionId = state.sessionId;
  controlPending = true;
  update();
  try {
    // A device receipt may advance the journal while its output is still waiting.
    // Read that sequence before issuing timer controls, without waiting for output.
    await refresh(true);
    if (
      !healthy ||
      state?.mode !== "active" ||
      !state.ready ||
      state.sessionId !== sessionId ||
      state.storageError
    )
      return;
    if (action === "timer-start" && !payload?.itemId) {
      const item =
        state.items.find((item) => item.id === state.timer.currentItemId) ||
        state.items.find((item) => item.type !== "header");
      if (!item) {
        showFailure(new Error("This rundown has no playable items."));
        return;
      }
      payload = { itemId: item.id };
    }
    await send({
      operation: "transport",
      sessionId,
      requestId: crypto.randomUUID(),
      expectedSequence: state.sequence,
      action,
      payload,
    });
  } finally {
    controlPending = false;
    update();
  }
}
function canControl() {
  return (
    healthy &&
    state?.mode === "active" &&
    state.ready &&
    state.commandSource === "local" &&
    !state.storageError &&
    !controlPending
  );
}
function latestResult(actionId) {
  return state.results.findLast((result) => result.actionId === actionId);
}
function fire(action) {
  if (!canControl()) return;
  const request = {
    operation: "device",
    sessionId: state.sessionId,
    requestId: crypto.randomUUID(),
    expectedSequence: state.sequence,
    actionId: action.id,
  };
  const previous = latestResult(action.id);
  confirmation(
    previous ? "Fire this cue again?" : "Send this device cue?",
    `${action.label}. This controls real venue equipment. ${previous?.result === "unknown" ? "The previous result is unknown. Check the equipment before sending it again." : "The saved device action will be sent once."}`,
    previous ? "Fire again" : "Send cue",
    async () => {
      await refresh(true);
      if (!canControl() || state.sessionId !== request.sessionId) return;
      await send({ ...request, expectedSequence: state.sequence });
    },
  );
}
async function reconnect() {
  if (
    state?.mode === "active" ||
    controlPending ||
    deviceRequests.size ||
    (state && state.commandSource !== "cloud")
  ) {
    showFailure(
      new Error(
        "Finish local control before returning to the cloud. Your device results and timer journal will stay saved.",
      ),
    );
    return;
  }
  view.cloud.disabled = true;
  view.cloud.textContent = "Checking connection…";
  if (await cloudAvailable()) window.location.replace(CLOUD_ORIGIN);
  else
    showFailure(
      new Error(
        "ShowPilot Cloud is still unreachable. Your prepared show and local journal remain on this computer.",
      ),
    );
  update();
}
function begin() {
  confirmation(
    "Enable local show control?",
    "This computer will stop accepting cloud commands. Its local timer and prepared device cues will control the show. Other computers and cloud displays will not follow local timer changes.",
    "Enable local control",
    () =>
      send({ operation: "begin", sessionId: state.sessionId, confirmed: true }),
  );
}
function finish() {
  confirmation(
    "Return control to the cloud?",
    "The local timer will pause and local device connections will close. Your timer journal and device results stay saved for review. Devices will never be replayed during synchronization.",
    "Finish local control",
    () =>
      send({
        operation: "finish",
        sessionId: state.sessionId,
        expectedSequence: state.sequence,
      }),
  );
}
function retryLast() {
  const request = lastFailure?.request;
  if (!request) {
    lastFailure = null;
    void refresh();
    return;
  }
  if (state?.sessionId !== request.sessionId) {
    showFailure(
      new Error(
        "The prepared session changed. Review the current show before sending another action.",
      ),
    );
    return;
  }
  // Keep the original request ID and revision. The engine can return its saved
  // receipt, but this retry can never create a second equipment command.
  void send(request);
}

function render() {
  const sessionId = state && state.mode !== "empty" ? state.sessionId : null;
  app.replaceChildren();
  app.removeAttribute("aria-live");
  const shell = element("div", "shell");
  const topbar = element("header", "topbar");
  const pill = element("span", "offline-pill", "LOCAL SHOW");
  const heading = element("div", "heading");
  const title = element(
    "h1",
    "",
    sessionId
      ? state.title
      : state
        ? "No prepared local show"
        : "Local engine unavailable",
  );
  const subtitle = element("p");
  heading.append(title, subtitle);
  const cloud = button("Open ShowPilot Cloud", reconnect);
  const refreshButton = button("Refresh local status", () => {
    lastFailure = null;
    void refresh();
  });
  topbar.append(pill, heading, refreshButton, cloud);
  const feedback = element("section", "feedback");
  const error = element("p", "error");
  error.setAttribute("role", "alert");
  const retry = button("Retry request", retryLast);
  retry.hidden = true;
  feedback.append(error, retry);
  shell.append(topbar, feedback);
  view = {
    unavailable: state === null,
    sessionId,
    preparedAt: state?.preparedAt,
    shell,
    title,
    subtitle,
    pill,
    cloud,
    refreshButton,
    error,
    retry,
  };
  if (!sessionId) {
    const empty = element("section", "empty panel");
    empty.append(
      element(
        "h2",
        "",
        state
          ? "Prepare this computer before going offline"
          : "Your saved show could not be read",
      ),
      element(
        "p",
        "",
        state
          ? "While connected, open the saved show in ShowPilot Desktop and prepare local control. Preparation saves its rundown and approved device cues securely on this computer."
          : "Refresh the local engine status to recover its saved show. Your local journal has not been cleared.",
      ),
    );
    shell.append(empty);
    app.append(shell);
    update();
    return;
  }
  const workspace = element("div", "workspace");
  const listPanel = element("section", "panel");
  const listHead = element("div", "panel-head");
  listHead.append(
    element("h2", "", "Prepared rundown"),
    element("span", "", `${state.items.length} items`),
  );
  const notice = element("p", "notice");
  const rundown = element("div", "rundown");
  const rows = state.items.map((item, index) => {
    const row = button(
      "",
      () => transport("timer-start", { itemId: item.id }),
      "cue",
    );
    const number = element(
      "span",
      "cue-num",
      String(index + 1).padStart(2, "0"),
    );
    const copy = element("span", "cue-copy");
    const itemStatus = element("span", "cue-note");
    copy.append(element("span", "cue-title", item.title), itemStatus);
    row.append(
      number,
      copy,
      element("span", "cue-time", formatDuration(item.duration)),
    );
    row.setAttribute("aria-label", `Start ${item.title}`);
    rundown.append(row);
    return { id: item.id, row, itemStatus };
  });
  listPanel.append(listHead, notice, rundown);
  const engine = element("aside", "panel engine");
  const engineHead = element("div", "panel-head");
  const mode = element("span");
  engineHead.append(element("h2", "", "Venue control"), mode);
  const clock = element("div", "clock");
  clock.setAttribute("aria-label", "Local timer");
  const current = element("div", "current");
  const controls = element("div", "controls");
  const enable = button("Enable local control", begin, "button primary");
  const play = button(
    "Start timer",
    () =>
      transport(
        state.timer.playback === "play"
          ? "timer-pause"
          : state.timer.playback === "pause"
            ? "timer-resume"
            : "timer-start",
      ),
    "button primary",
  );
  const previous = button("Previous item", () => transport("timer-prev"));
  const next = button("Next item", () => transport("timer-next"));
  const stop = button("Stop timer", () =>
    confirmation(
      "Stop the local timer?",
      "The current item will stop. The recorded local progress remains available for review.",
      "Stop timer",
      () => transport("timer-stop"),
    ),
  );
  const finishButton = button("Finish local control", finish);
  controls.append(enable, play, previous, next, stop, finishButton);
  engine.append(engineHead, clock, current, controls);
  const devicePanel = element("section", "panel devices");
  const deviceHead = element("div", "panel-head");
  deviceHead.append(
    element("h2", "", "Prepared device cues"),
    element(
      "span",
      "",
      `${state.actions.length} ${state.actions.length === 1 ? "cue" : "cues"}`,
    ),
  );
  const deviceList = element("div", "device-list");
  const actions = state.actions.map((action) => {
    const row = element("div", "device-cue");
    const result = element("span", "device-result");
    result.setAttribute("role", "status");
    const fireButton = button(action.label, () => fire(action));
    row.append(fireButton, result);
    deviceList.append(row);
    return { id: action.id, fireButton, result };
  });
  if (!actions.length)
    deviceList.append(
      element(
        "p",
        "muted",
        "No device cues were included in this preparation. Add device actions to this show's timecode cues and prepare it again while connected.",
      ),
    );
  devicePanel.append(deviceHead, deviceList);
  workspace.append(listPanel, engine, devicePanel);
  shell.append(workspace);
  Object.assign(view, {
    notice,
    rows,
    mode,
    clock,
    current,
    enable,
    play,
    previous,
    next,
    stop,
    finishButton,
    actions,
  });
  app.append(shell);
  update();
}
function updateClock() {
  if (!view?.clock || !state || state.mode === "empty") return;
  const now = Date.now() + serverOffset;
  const item = state.items.find(
    (item) => item.id === state.timer.currentItemId,
  );
  const elapsed =
    state.timer.elapsed +
    (state.timer.playback === "play" && state.timer.startedAt !== null
      ? Math.max(0, now - state.timer.startedAt)
      : 0);
  view.clock.textContent =
    state.timer.mode === "clock"
      ? new Date(now).toLocaleTimeString()
      : formatDuration(
          state.timer.mode === "count-up"
            ? elapsed
            : (item?.duration ?? 0) - elapsed,
        );
  view.current.textContent = item?.title || "Timer stopped";
}
function update() {
  if (!view) return;
  view.error.textContent = state?.storageError || lastFailure?.message || "";
  view.retry.hidden = !lastFailure || Boolean(state?.storageError);
  view.retry.textContent = lastFailure?.request
    ? "Check saved result / retry request"
    : "Retry status check";
  view.retry.disabled =
    controlPending ||
    Boolean(
      lastFailure?.request?.actionId &&
      deviceRequests.has(lastFailure.request.actionId),
    );
  view.refreshButton.disabled = polling;
  view.cloud.disabled =
    state?.mode === "active" ||
    controlPending ||
    deviceRequests.size > 0 ||
    Boolean(state && state.commandSource !== "cloud");
  view.cloud.textContent =
    state?.mode === "finished"
      ? "Open cloud to review progress"
      : "Open ShowPilot Cloud";
  if (!state || state.mode === "empty") return;
  const expired = Date.now() + serverOffset >= state.expiresAt;
  view.subtitle.textContent = `${state.serviceDate} · Prepared ${new Date(state.preparedAt).toLocaleString()} · Revision ${state.baseRevision}`;
  view.pill.textContent = !healthy
    ? "ENGINE UNAVAILABLE"
    : state.mode === "active"
      ? state.ready
        ? "LOCAL CONTROL"
        : "LOCAL CONTROL HELD"
      : state.mode === "finished"
        ? "AWAITING REVIEW"
        : state.mode === "reconciled"
          ? "PROGRESS SYNCED"
          : "PREPARED";
  view.mode.textContent =
    state.mode === "active" && state.ready
      ? state.timer.playback.toUpperCase()
      : "HELD";
  view.notice.textContent =
    state.mode === "finished"
      ? "Local control has ended. Your timer progress and device results are saved. Review the exact cloud revision before applying timer progress. Device commands are never replayed."
      : state.mode === "reconciled"
        ? "Timer progress has been accepted by the cloud. Prepare the show again before another local session."
        : expired
          ? "This preparation has expired. Device commands are blocked. Finish local control and reconnect to refresh device approvals."
          : state.mode === "active"
            ? "Timer changes stay on this computer until reviewed. Only the prepared device cues control venue equipment. Cloud displays and teammates do not follow this local timer."
            : "This show is saved securely on this computer. Enable local control to run its timer and prepared device cues when the cloud is unavailable.";
  view.enable.hidden =
    !["prepared", "active"].includes(state.mode) || state.ready;
  view.enable.textContent =
    state.mode === "active" ? "Resume local control" : "Enable local control";
  view.enable.disabled =
    !healthy || expired || controlPending || Boolean(state.storageError);
  view.play.textContent =
    state.timer.playback === "play"
      ? "Pause timer"
      : state.timer.playback === "pause"
        ? "Resume timer"
        : "Start timer";
  for (const node of [view.play, view.previous, view.next, view.stop])
    node.disabled = !canControl();
  view.finishButton.hidden =
    state.mode !== "active" &&
    !(state.mode === "finished" && state.commandSource !== "cloud");
  view.finishButton.disabled =
    !healthy ||
    controlPending ||
    deviceRequests.size > 0 ||
    state.results.some((result) => result.result === "pending") ||
    Boolean(state.storageError);
  for (const { id, row, itemStatus } of view.rows) {
    const item = state.items.find((item) => item.id === id);
    row.disabled = !canControl() || item.type === "header";
    row.classList.toggle("active", state.timer.currentItemId === id);
    row.setAttribute("aria-pressed", String(state.timer.currentItemId === id));
    itemStatus.textContent = `${item.status} · ${item.notes || item.cue || item.type}`;
  }
  const labels = {
    pending: "Waiting for device result",
    acknowledged: "Device acknowledged",
    sent: "Sent · device does not acknowledge",
    failed: "Device reported failure",
    unknown: "Result unknown · check equipment",
  };
  for (const { id, fireButton, result } of view.actions) {
    const latest = latestResult(id);
    fireButton.disabled =
      !canControl() ||
      expired ||
      deviceRequests.has(id) ||
      latest?.result === "pending";
    result.textContent = deviceRequests.has(id)
      ? "Request pending · not confirmed"
      : latest
        ? labels[latest.result]
        : "Not sent";
    result.dataset.result = latest?.result ?? "idle";
  }
  updateClock();
}
async function start() {
  // Restored active/finished sessions always remain visible, even if the cloud
  // has returned. A network probe must never hide unsynchronized local progress.
  await refresh();
  const deliberate =
    new URLSearchParams(window.location.search).get("local") === "1";
  let safeToOpenCloud = Boolean(
    state &&
    ["empty", "prepared", "reconciled"].includes(state.mode) &&
    state.commandSource === "cloud",
  );
  if (!deliberate && !state) {
    try {
      const bridge = await invokeNative("bridge_status");
      // A disabled engine has no running local controller. A starting, unknown
      // or failed engine must remain visible until its local journal is read.
      safeToOpenCloud =
        bridge?.running === false && bridge?.localDevicesEnabled === false;
    } catch {
      safeToOpenCloud = false;
    }
  }
  if (
    !deliberate &&
    !state?.storageError &&
    safeToOpenCloud &&
    (await cloudAvailable())
  ) {
    window.location.replace(CLOUD_ORIGIN);
    return;
  }
  if (!view) render();
  setInterval(() => {
    void refresh();
  }, 1000);
  setInterval(updateClock, 100);
}
void start();
