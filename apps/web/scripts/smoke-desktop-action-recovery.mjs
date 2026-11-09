// Real compiled app/auth/D1 and Tauri JS updater adapter. Native IPC is simulated;
// this does not install an update or claim physical desktop-engine validation.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
const modules = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const { chromium } = createRequire(join(modules, "agent-browser/package.json"))("playwright-core");
await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, capturedEmails }) => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies(operatorCookie.split("; ").map(part => ({ name: part.slice(0, part.indexOf("=")), value: part.slice(part.indexOf("=") + 1), url: origin })));
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.clock.install();
  await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.addInitScript(() => {
    const f = window.desktopActionFixture = { reads: 0, windows: [], local: 0, installs: 0, restarts: 0, heldStatus: [], heldWindows: [], heldInstall: [], statusMode: "hold" };
    const status = { configured: false, localDevicesEnabled: false, running: false, connection: "offline", pid: null, logs: [], lastError: null };
    const callbacks = new Map(); let callback = 0;
    const invoke = async (command, args = {}) => {
      if (command === "engine_info") return { native: true, platform: "fixture", version: "0.1.9", cachePath: null };
      if (command === "bridge_status") { f.reads++; return f.statusMode === "hold" ? new Promise(done => f.heldStatus.push(() => done(status))) : status; }
      if (command === "open_companion_window") { f.windows.push(args); return new Promise(done => f.heldWindows.push(done)); }
      if (command === "open_local_show") { f.local++; return; }
      if (command === "plugin:updater|check") return { rid: 1, currentVersion: "0.1.9", version: "0.2.0", body: "Fixture update", date: null, rawJson: {} };
      if (command === "plugin:updater|download_and_install") { f.installs++; return new Promise(done => f.heldInstall.push(done)); }
      if (command === "restart_desktop") { f.restarts++; throw new Error("Fixture older shell cannot restart"); }
      if (command === "local_show_command") return { mode: "empty", installationId: null, commandSource: "cloud" };
      if (command === "confidence_outputs") return { monitors: [], decklink: { devices: [], error: null }, active: null };
      if (command === "confidence_output_status") return { state: "stopped", message: "" };
      if (command === "display_fullscreen_state") return false;
      if (command.startsWith("plugin:")) return null;
      throw new Error(`Unexpected fixture IPC ${command}`);
    };
    window.__TAURI_INTERNALS__ = { invoke, transformCallback: fn => { callbacks.set(++callback, fn); return callback; }, unregisterCallback: id => callbacks.delete(id), metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } } };
    window.__TAURI__ = { core: { invoke } };
  });
  const button = name => page.getByRole("button", { name, exact: true });
  async function wait(expression) { await page.waitForFunction(expression); }
  async function widths(kind, names) {
    for (const [width, height] of [[320, 480], [768, 1024], [1440, 1000]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(async () => {
        await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
        await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
      });
      for (const name of names) {
        const control = button(name); await control.scrollIntoViewIfNeeded();
        const b = await control.boundingBox();
        assert.ok(b && b.height >= 44 && b.x >= 0 && b.x + b.width <= width + 1 && b.y >= 0 && b.y + b.height <= height + 1, `${name} reachable at ${width}`);
        await control.click({ trial: true });
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.ok(await page.locator("main").evaluate(node => node.getBoundingClientRect().height >= 120), `operator workspace remains visible at ${width}`);
      if (kind === "install-pending") {
        const notice = page.getByText(/Desktop installation has not confirmed completion/);
        await notice.scrollIntoViewIfNeeded();
        const bounds = await notice.boundingBox();
        assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= height + 1, `installation explanation reachable at ${width}`);
      }
      await page.screenshot({ path: `/tmp/showpilot-desktop-actions-${kind}-${width}.png`, fullPage: true });
    }
  }
  try {
    await page.goto(`${origin}/${orgId}/settings?section=workspace`);
    await button("Check-in").waitFor();
    await page.waitForLoadState("networkidle");
    await wait(() => desktopActionFixture.reads >= 2);
    const initialReads = await page.evaluate(() => desktopActionFixture.reads);
    await page.clock.fastForward(16000);
    await button("Retry local status").waitFor();
    assert.equal(await page.evaluate(() => desktopActionFixture.reads), initialReads);
    await page.evaluate(() => { desktopActionFixture.statusMode = "normal"; desktopActionFixture.heldStatus.splice(0).forEach(done => done()); });
    await button("Retry local status").waitFor({ state: "hidden" });
    await button("Check-in").click(); await page.clock.fastForward(12000);
    await page.getByText("Check-in has not confirmed completion. It may still finish. Other controls remain available.", { exact: true }).waitFor();
    assert.equal(await button("Check-in pending").isDisabled(), true);
    await button("Local show").click(); await wait(() => desktopActionFixture.local === 1);
    assert.equal(await page.evaluate(() => desktopActionFixture.windows.length), 1);
    await page.evaluate(() => desktopActionFixture.heldWindows.splice(0).forEach(done => done()));
    await button("Check-in").waitFor();
    await widths("controls", ["Local show", "Timer window", "Crew status", "Check-in", "Use this computer"]);
    await button("Update 0.2.0").click();
    await page.getByRole("dialog").getByRole("button", { name: "Install and restart", exact: true }).click();
    await wait(() => desktopActionFixture.installs === 1); await page.clock.fastForward(60000);
    await button("Installation not confirmed").waitFor();
    assert.equal(await button("Installation not confirmed").isDisabled(), true);
    await page.getByText(/Desktop installation has not confirmed completion/).waitFor();
    await widths("install-pending", ["Local show", "Timer window"]);
    assert.equal(await page.evaluate(() => desktopActionFixture.installs), 1);
    await page.evaluate(() => desktopActionFixture.heldInstall.splice(0).forEach(done => done()));
    await button("Restart required").waitFor();
    assert.equal(await page.evaluate(() => desktopActionFixture.restarts), 1);
    assert.equal(await button("Restart required").isDisabled(), true);
    assert.deepEqual(errors, []); assert.equal((await capturedEmails()).length, 0);
    console.log(JSON.stringify({ result: "pass", simulatedNativeIpc: true, serializedPolling: true, lateWindowCompletion: true, noDuplicateInstallation: true, manualRestart: true, viewports: [320, 768, 1440], errors }));
  } catch (error) {
    console.error(JSON.stringify({ body: await page.locator("body").innerText(), errors }));
    await page.screenshot({ path: "/tmp/showpilot-desktop-actions-failure.png", fullPage: true }); throw error;
  } finally { await browser.close(); }
}, { captureEmail: true });
