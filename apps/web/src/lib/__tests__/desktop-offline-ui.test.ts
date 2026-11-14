import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const script = readFileSync(resolve(import.meta.dirname, "../../../../desktop/offline/offline.js"), "utf8");
const previous = window.__TAURI__;
beforeEach(() => {
  window.history.replaceState({}, "", "/?local=1");
  document.body.innerHTML = '<main id="app"></main>';
});
afterEach(() => {
  window.__TAURI__ = previous;
  document.body.innerHTML = "";
  window.history.replaceState({}, "", "/");
});

async function load(status: { running: boolean; localDevicesEnabled: boolean; lastError: string | null }) {
  const invoke = vi.fn(async (command: string) => {
    if (command === "bridge_status") return status;
    if (command === "local_show_command") throw new Error("Start the local device engine before using local show control");
    throw new Error(`Unexpected native command: ${command}`);
  });
  Object.defineProperty(window, "__TAURI__", { configurable: true, writable: true, value: { core: { invoke } } });
  new Function("window", "document", "setInterval", script)(window, document, vi.fn());
  for (let i = 0; i < 50; i++) await Promise.resolve();
  return invoke;
}

it("explains deliberate cloud mode without an engine-failure alert or an automatic claim", async () => {
  const invoke = await load({ running: false, localDevicesEnabled: false, lastError: null });
  expect(document.querySelector("h1")?.textContent).toBe("Local control is off");
  expect(document.body.textContent).toContain("Use this computer");
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("");
  expect(invoke.mock.calls.map(call => call[0])).toEqual(["local_show_command", "bridge_status"]);
});

it("distinguishes an engine that is starting from one that failed", async () => {
  await load({ running: false, localDevicesEnabled: true, lastError: null });
  expect(document.querySelector("h1")?.textContent).toBe("Starting local control…");
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("");
});

it("keeps genuine engine failures visible", async () => {
  await load({ running: false, localDevicesEnabled: true, lastError: "Fixture startup failed" });
  expect(document.querySelector("h1")?.textContent).toBe("Local engine unavailable");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Fixture startup failed");
});
