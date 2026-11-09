// Disposable auth/R2/ChatRelay. Checks the actual image controls and download bytes.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
const modules = execFileSync("npm", ["root", "-g"], {
  encoding: "utf8",
}).trim();
const { chromium } = createRequire(join(modules, "agent-browser/package.json"))(
  "playwright-core",
);
const audit = process.argv.includes("--audit");
const bytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1sAAAAASUVORK5CYII=",
  "base64",
);
await withLocalSmokeFixture(
  async ({ origin, orgId, operatorCookie, capturedEmails }) => {
    const browser = await chromium.launch({ headless: true }),
      context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        hasTouch: true,
      }),
      page = await context.newPage(),
      errors = [],
      measurements = [];
    await context.addCookies(
      operatorCookie
        .split("; ")
        .map((part) => ({
          name: part.slice(0, part.indexOf("=")),
          value: part.slice(part.indexOf("=") + 1),
          url: origin,
        })),
    );
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.abort(),
    );
    try {
      await page.goto(`${origin}/${orgId}/chat?room=production`);
      const input = page.locator("[data-testid=chat-panel] input[type=file]");
      await input.waitFor({ state: "attached" });
      await page.waitForFunction(() =>
        Object.keys(
          document.querySelector("[data-testid=chat-panel] input[type=file]") ??
            {},
        ).some((key) => key.startsWith("__reactProps$")),
      );
      await input.setInputFiles({
        name: "stage.png",
        mimeType: "image/png",
        buffer: bytes,
      });
      await page
        .getByText(/^Ready to send/)
        .waitFor()
        .catch(async (error) => {
          console.error(await page.locator("body").innerText());
          throw error;
        });
      await page
        .getByRole("button", { name: "Send message", exact: true })
        .click();
      const open = page.getByRole("button", {
        name: "Open stage.png",
        exact: true,
      });
      await open.waitFor();
      for (const [width, height] of [
        [320, 480],
        [768, 1024],
        [1440, 1000],
      ]) {
        await page.setViewportSize({ width, height });
        await open.click();
        const dialog = page.getByRole("dialog", {
          name: "stage.png",
          exact: true,
        });
        await dialog.waitFor();
        for (const control of [
          dialog.getByRole("button", { name: "Close image", exact: true }),
          dialog.getByRole("link", { name: "Download image", exact: true }),
        ]) {
          const box = await control.boundingBox();
          assert.ok(box);
          measurements.push({
            width,
            control: await control.getAttribute("aria-label"),
            targetWidth: box.width,
            targetHeight: box.height,
          });
          if (!audit) {
            assert.ok(box.width >= 44 && box.height >= 44);
            assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
            await control.click({ trial: true });
          }
        }
        if (!audit) {
          const pending = page.waitForEvent("download");
          await dialog
            .getByRole("link", { name: "Download image", exact: true })
            .click();
          const download = await pending;
          assert.deepEqual(await readFile(await download.path()), bytes);
          await page.screenshot({
            path: `/tmp/showpilot-chat-image-${width}.png`,
          });
        }
        await dialog
          .getByRole("button", { name: "Close image", exact: true })
          .tap();
        await dialog.waitFor({ state: "hidden" });
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
          downloadVerified: !audit,
        }),
      );
    } finally {
      await browser.close();
    }
  },
  { captureEmail: true },
);
