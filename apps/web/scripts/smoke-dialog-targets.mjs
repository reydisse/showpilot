// Real compiled dialogs, disposable auth/D1, no submitted mutations.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
const modules = execFileSync("npm", ["root", "-g"], {
  encoding: "utf8",
}).trim();
const { chromium } = createRequire(join(modules, "agent-browser/package.json"))(
  "playwright-core",
);
const audit = process.argv.includes("--audit");
await withLocalSmokeFixture(
  async ({ origin, orgId, operatorCookie, capturedEmails }) => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      hasTouch: true,
    });
    await context.addCookies(
      operatorCookie
        .split("; ")
        .map((part) => ({
          name: part.slice(0, part.indexOf("=")),
          value: part.slice(part.indexOf("=") + 1),
          url: origin,
        })),
    );
    const page = await context.newPage(),
      errors = [],
      measurements = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.routeWebSocket("**/*", (socket) => socket.close());
    await page.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.abort(),
    );
    const button = (name) => page.getByRole("button", { name, exact: true });
    async function stable() {
      await page.evaluate(async () => {
        await new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        );
        await Promise.all(
          document
            .getAnimations()
            .filter((a) => a.effect?.getTiming().iterations !== Infinity)
            .map((a) => a.finished.catch(() => {})),
        );
      });
    }
    async function go(path) {
      await page.goto(`${origin}/${orgId}/${path}`);
      await page.waitForFunction(() =>
        Object.keys(document.querySelector("aside a") ?? {}).some((key) =>
          key.startsWith("__reactProps$"),
        ),
      );
    }
    async function measure(control, name, width) {
      await control.scrollIntoViewIfNeeded();
      const box = await control.boundingBox();
      assert.ok(box);
      measurements.push({
        name,
        width,
        targetWidth: Math.round(box.width),
        targetHeight: Math.round(box.height),
      });
      if (audit) console.log(JSON.stringify(measurements.at(-1)));
      if (!audit) {
        assert.ok(
          box.width >= 44 && box.height >= 44,
          `${name} must be 44px at ${width}: ${JSON.stringify(box)}`,
        );
        assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
        await control.click({ trial: true });
      }
    }
    async function checkDialog(name, width) {
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      await stable();
      const close = dialog.getByRole("button", { name: "Close", exact: true });
      await measure(close, `${name} close`, width);
      if (!audit) {
        const bounds = await dialog.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
        const overlap = await dialog.evaluate((node) => {
          const close = node
              .querySelector("[data-slot=dialog-close]")
              .getBoundingClientRect(),
            title = node.querySelector("[data-slot=dialog-title]"),
            range = document.createRange();
          range.selectNodeContents(title);
          return [...range.getClientRects()].some(
            (rect) =>
              rect.left < close.right &&
              rect.right > close.left &&
              rect.top < close.bottom &&
              rect.bottom > close.top,
          );
        });
        assert.equal(overlap, false, `${name}: title must not overlap close`);
        for (let i = 0; i < 8; i++) {
          await page.keyboard.press("Tab");
          assert.ok(
            await dialog.evaluate((node) =>
              node.contains(document.activeElement),
            ),
            `${name}: focus remains inside`,
          );
        }
        await close.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: `/tmp/showpilot-dialog-${name}-${width}.png`,
        });
      }
      return { dialog, close };
    }
    try {
      for (const [width, height] of [
        [320, 480],
        [768, 1024],
        [1440, 1000],
      ]) {
        await page.setViewportSize({ width, height });
        await go("dashboard/prod-manager");
        await button("View details").click();
        let current = await checkDialog("assignments", width);
        await current.close.tap();
        await current.dialog.waitFor({ state: "hidden" });
        await go("production/incidents");
        await button("Report").click();
        current = await checkDialog("incident", width);
        await page.keyboard.press("Escape");
        await current.dialog.waitFor({ state: "hidden" });
        await go("production/checklist");
        await page
          .getByLabel("Checklist item", { exact: true })
          .fill("Unsaved fixture draft");
        await page
          .locator(`aside a[href='/${orgId}/schedule']`)
          .evaluate((node) => node.click());
        current = await checkDialog("leave-checklist", width);
        for (const name of ["Stay", "Leave checklist"])
          await measure(
            current.dialog.getByRole("button", { name, exact: true }),
            `checklist ${name}`,
            width,
          );
        await current.dialog
          .getByRole("button", { name: "Stay", exact: true })
          .click();
        await current.dialog.waitFor({ state: "hidden" });
        assert.equal(
          await page.getByLabel("Checklist item", { exact: true }).inputValue(),
          "Unsaved fixture draft",
        );
        await page.getByLabel("Checklist item", { exact: true }).fill("");
        await go("settings?section=organization");
        let settingsHelp = page.getByRole("button", { name: /^Help:/ });
        await measure(settingsHelp, "Settings Help", width);
        await settingsHelp.tap();
        current = await checkDialog("settings-help", width);
        await page.keyboard.press("Escape");
        await current.dialog.waitFor({ state: "hidden" });
        assert.ok(
          await settingsHelp.evaluate(
            (node) => node === document.activeElement,
          ),
          "Settings Help restores trigger focus",
        );
        await go("reports");
        const help = page.getByRole("button", { name: /^Help:/ });
        await measure(help, "Reports Help", width);
        await help.tap();
        current = await checkDialog("reports-help", width);
        await page.keyboard.press("Escape");
        await current.dialog.waitFor({ state: "hidden" });
        assert.ok(
          await help.evaluate((node) => node === document.activeElement),
          "Help restores trigger focus",
        );
      }
      assert.deepEqual(errors, []);
      assert.equal((await capturedEmails()).length, 0);
      console.log(
        JSON.stringify({
          audit,
          passed: !audit,
          measurements,
          errors,
          emails: 0,
        }),
      );
    } finally {
      await browser.close();
    }
  },
  { captureEmail: true },
);
