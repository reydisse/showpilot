import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import test from "node:test";
import { LocalShowManager } from "../../bridge/dist/local-show-manager.js";
import { parseLocalShowRequest } from "../../bridge/dist/local-show-control.js";
const root = new URL("../", import.meta.url);
const source = await readFile(new URL("offline/offline.js", root), "utf8");
const html = await readFile(new URL("offline/index.html", root), "utf8");

async function waitFor(check) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw Error("UI did not reach expected state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function preparation() {
  const now = Date.now();
  return {
    version: 1,
    sessionId: "offline-fixture-session",
    orgId: "fixture-org",
    installationId: "fixture-installation",
    showId: "fixture-show",
    serviceDate: "2026-11-06",
    title: "Venue rehearsal",
    baseRevision: 7,
    preparedAt: now - 1000,
    expiresAt: now + 3600000,
    items: ["a", "b"].map((id) => ({
      id,
      title: `Cue ${id}`,
      type: "segment",
      duration: 60000,
      notes: "",
      assignee: "",
      cue: "",
      status: "upcoming",
    })),
    timer: {
      playback: "stop",
      currentItemId: null,
      elapsed: 0,
      startedAt: null,
      pausedAt: null,
      mode: "count-down",
    },
    actions: [
      {
        id: "fixture-action",
        deviceId: "fixture-device",
        label: "Camera cue",
        protocol: "http-command",
        target: "http://127.0.0.1:9999",
        command: "POST /cue {}",
        settings: {},
      },
    ],
    approvedTargets: [
      { protocol: "http-command", host: "127.0.0.1", port: 9999 },
    ],
  };
}
async function fixture(t, options = {}) {
  let saved = null,
    outputCount = 0,
    loseReply = false,
    unavailable = false;
  const store = {
    load: () => structuredClone(saved),
    save: (value) => {
      saved = structuredClone(value);
    },
  };
  const dependencies = {
    store,
    scope: { orgId: "fixture-org", installationId: "fixture-installation" },
    activate: async () => {},
    deactivate: async () => {},
    execute: async () => {
      outputCount++;
      return options.execute ? options.execute() : "acknowledged";
    },
  };
  let cloudProbes = 0;
  let manager = new LocalShowManager(dependencies);
  if (!options.empty) {
    const prepared = preparation();
    manager.prepare(prepared, prepared.approvedTargets);
  }
  if (options.active) {
    await manager.handle({
      operation: "begin",
      sessionId: "offline-fixture-session",
      confirmed: true,
    });
    await manager.handle({
      operation: "transport",
      sessionId: "offline-fixture-session",
      requestId: "initial-start",
      expectedSequence: 0,
      command: { type: "timer-start", itemId: "a" },
    });
    if (options.held) manager = new LocalShowManager(dependencies);
    if (options.finished)
      await manager.handle({
        operation: "finish",
        sessionId: "offline-fixture-session",
        expectedSequence: 1,
      });
  }
  const dom = new JSDOM(html, {
    url: `https://tauri.localhost/index.html${options.startup ? "" : "?local=1"}`,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  window.fetch = async () => {
    cloudProbes++;
    if (!options.cloud) throw Error("Offline fixture");
    return {};
  };
  window.__TAURI__ = {
    core: {
      invoke: async (name, { request } = {}) => {
        assert.equal(name, "local_show_command");
        if (unavailable) throw Error("Fixture engine unavailable");
        const parsed = parseLocalShowRequest(request);
        assert.ok(parsed, "UI sends a valid native request");
        const result = await manager.handle(parsed);
        if (parsed.operation === "device" && loseReply) {
          loseReply = false;
          throw Error("Fixture reply lost after dispatch");
        }
        return structuredClone({
          ...result,
          installationId: "fixture-installation",
          commandSource:
            result.mode === "active"
              ? result.ready
                ? "local"
                : "local-held"
              : "cloud",
        });
      },
    },
  };
  window.eval(source);
  const text = () => window.document.body.textContent;
  const find = (label) =>
    [...window.document.querySelectorAll("button")].find(
      (node) => node.textContent === label,
    );
  const click = (label) => {
    const node = find(label);
    assert.ok(node, `Missing button ${label}`);
    assert.equal(node.disabled, false, `${label} is enabled`);
    node.click();
  };
  await waitFor(() => find("Refresh local status"));
  return {
    window,
    text,
    find,
    click,
    manager,
    outputCount: () => outputCount,
    cloudProbes: () => cloudProbes,
    loseReply: () => {
      loseReply = true;
    },
    unavailable: (value) => {
      unavailable = value;
    },
  };
}
async function begin(ui) {
  ui.click("Enable local control");
  // Select the dialog's explicit confirmation, not the original button.
  ui.window.document.querySelector("dialog .primary").click();
  await waitFor(
    () =>
      ui.manager.status().mode === "active" &&
      ui.find("Start timer")?.disabled === false,
  );
}

test("release desktop bundles its offline shell and scripts have no HTML injection", async () => {
  const config = JSON.parse(
    await readFile(new URL("src-tauri/tauri.conf.json", root), "utf8"),
  );
  assert.equal(config.build.frontendDist, "../offline");
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /offline\.js/);
  assert.doesNotMatch(source, /innerHTML/);
});

test("rendered offline controls advance the real persisted timer and require confirmation before local handoff", async (t) => {
  const ui = await fixture(t);
  assert.equal(ui.find("Start timer").disabled, true);
  ui.click("Enable local control");
  assert.equal(ui.manager.status().mode, "prepared");
  ui.click("Cancel");
  assert.equal(ui.manager.status().mode, "prepared");
  await begin(ui);
  ui.click("Start timer");
  await waitFor(
    () =>
      ui.manager.status().timer.currentItemId === "a" &&
      !ui.find("Next item").disabled,
  );
  ui.click("Next item");
  await waitFor(
    () =>
      ui.manager.status().timer.currentItemId === "b" &&
      ui.text().includes("complete"),
  );
  assert.equal(ui.manager.status().sequence, 2);
  ui.click("Stop timer");
  assert.equal(ui.manager.status().timer.playback, "play");
  ui.click("Cancel");
  assert.equal(ui.manager.status().timer.playback, "play");
});

test("a lost device reply can be checked again without sending a second command", async (t) => {
  const ui = await fixture(t);
  await begin(ui);
  ui.loseReply();
  ui.click("Camera cue");
  assert.equal(ui.outputCount(), 0);
  ui.click("Send cue");
  await waitFor(
    () =>
      ui.outputCount() === 1 &&
      ui.find("Check saved result / retry request") &&
      !ui.find("Check saved result / retry request").disabled,
  );
  ui.click("Check saved result / retry request");
  await waitFor(
    () =>
      ui.text().includes("Device acknowledged") &&
      !ui.find("Camera cue").disabled,
  );
  assert.equal(ui.outputCount(), 1);
  assert.equal(ui.manager.status().results.length, 1);
});

test("pending equipment does not block timer controls or allow premature cloud handoff", async (t) => {
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release("sent"));
  const ui = await fixture(t, { execute: () => waiting });
  await begin(ui);
  ui.click("Camera cue");
  ui.click("Send cue");
  await waitFor(() => ui.outputCount() === 1);
  ui.click("Refresh local status");
  await waitFor(() => ui.text().includes("Request pending · not confirmed"));
  assert.equal(ui.find("Finish local control").disabled, true);
  assert.equal(ui.find("Start timer").disabled, false);
  ui.click("Start timer");
  await waitFor(() => ui.manager.status().timer.playback === "play");
  release("sent");
  await waitFor(() => ui.text().includes("Sent · device does not acknowledge"));
  assert.equal(ui.outputCount(), 1);
});

test("finish preserves the review journal and keeps device commands out of reconciliation", async (t) => {
  const ui = await fixture(t);
  await begin(ui);
  ui.click("Start timer");
  await waitFor(
    () =>
      ui.manager.status().sequence === 1 &&
      !ui.find("Finish local control").disabled,
  );
  ui.click("Finish local control");
  assert.equal(ui.manager.status().mode, "active");
  ui.window.document.querySelector("dialog .primary").click();
  await waitFor(() => ui.text().includes("AWAITING REVIEW"));
  const state = ui.manager.status();
  assert.equal(state.mode, "finished");
  assert.equal(state.timer.playback, "pause");
  assert.equal(state.journal.operations.length, 1);
  assert.equal(ui.find("Open cloud to review progress").disabled, false);
  assert.equal(ui.find("Camera cue").disabled, true);
});

test("a restored session stays held until explicitly resumed, even with cloud available", async (t) => {
  const ui = await fixture(t, { active: true, held: true, cloud: true });
  assert.match(ui.text(), /LOCAL CONTROL HELD/);
  assert.equal(ui.cloudProbes(), 0);
  assert.equal(ui.find("Pause timer").disabled, true);
  assert.equal(ui.find("Open ShowPilot Cloud").disabled, true);
  ui.click("Resume local control");
  ui.window.document.querySelector("dialog .primary").click();
  await waitFor(() => !ui.find("Pause timer").disabled);
  assert.equal(ui.outputCount(), 0);
});

test("engine failure holds controls and exposes a working status retry", async (t) => {
  const ui = await fixture(t);
  await begin(ui);
  ui.unavailable(true);
  ui.click("Refresh local status");
  await waitFor(() => ui.text().includes("ENGINE UNAVAILABLE"));
  assert.equal(ui.find("Start timer").disabled, true);
  ui.unavailable(false);
  ui.click("Retry status check");
  await waitFor(() => !ui.find("Start timer").disabled);
});

test("empty preparations offer recovery without a pretend timer", async (t) => {
  const ui = await fixture(t, { empty: true });
  assert.match(ui.text(), /Prepare this computer before going offline/);
  assert.equal(ui.find("Start timer"), undefined);
});

test("startup preserves a finished journal for review even after cloud connectivity returns", async (t) => {
  const ui = await fixture(t, {
    active: true,
    finished: true,
    cloud: true,
    startup: true,
  });
  assert.match(ui.text(), /AWAITING REVIEW/);
  assert.equal(ui.cloudProbes(), 0);
  assert.equal(ui.manager.status().journal.operations.length, 1);
});

test("unknown equipment outcomes stay visible and require confirmation before a new attempt", async (t) => {
  const ui = await fixture(t, {
    execute: async () => {
      throw Error("Lost device connection");
    },
  });
  await begin(ui);
  ui.click("Camera cue");
  ui.click("Send cue");
  await waitFor(
    () =>
      ui.text().includes("Result unknown · check equipment") &&
      !ui.find("Camera cue").disabled,
  );
  ui.click("Camera cue");
  assert.match(
    ui.window.document.querySelector("dialog").textContent,
    /previous result is unknown/,
  );
  ui.click("Cancel");
  assert.equal(ui.outputCount(), 1);
});

test("polling preserves keyboard focus and the current row instead of rebuilding the controls", async (t) => {
  const ui = await fixture(t);
  await begin(ui);
  const next = ui.find("Next item");
  next.focus();
  ui.click("Refresh local status");
  await waitFor(() => !ui.find("Refresh local status").disabled);
  assert.equal(ui.find("Next item"), next);
  assert.equal(ui.window.document.activeElement, next);
});
