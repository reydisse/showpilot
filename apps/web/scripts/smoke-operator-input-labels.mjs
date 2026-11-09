// Real forms in disposable auth/D1. This rehearsal edits local drafts only.
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
  async ({ origin, orgId, operatorCookie, capturedEmails, queryFixture }) => {
    const browser = await chromium.launch({ headless: true }),
      context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      }),
      page = await context.newPage(),
      errors = [],
      results = [];
    await context.addCookies(
      operatorCookie.split("; ").map((part) => ({
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
    async function go(path) {
      await page.goto(`${origin}/${orgId}/${path}`);
      await page.waitForFunction(() =>
        Object.keys(document.querySelector("aside a") ?? {}).some((key) =>
          key.startsWith("__reactProps$"),
        ),
      );
    }
    async function check(name, selector, { targets = false } = {}) {
      for (const [width, height] of [
        [320, 480],
        [768, 1024],
        [1440, 1000],
      ]) {
        await page.setViewportSize({ width, height });
        await page.evaluate(
          () =>
            new Promise((done) =>
              requestAnimationFrame(() => requestAnimationFrame(done)),
            ),
        );
        await page.evaluate(async () => {
          await Promise.all(
            document
              .getAnimations()
              .filter(
                (animation) =>
                  animation.effect?.getTiming().iterations !== Infinity,
              )
              .map((animation) => animation.finished.catch(() => {})),
          );
        });
        if (width < 1024)
          await page.waitForFunction(
            () => {
              const sidebar = document.querySelector(
                'aside[aria-hidden="true"]',
              );
              return sidebar && sidebar.getBoundingClientRect().right <= 1;
            },
            null,
            { timeout: 3_000 },
          );
        const result = await page.locator(selector).evaluate((root) => {
          const fields = [
            ...root.querySelectorAll("input,select,textarea"),
          ].filter(
            (node) =>
              node.type !== "hidden" &&
              node.getBoundingClientRect().width > 0 &&
              node.getBoundingClientRect().height > 0,
          );
          const unlabelled = fields
            .filter(
              (node) =>
                !(
                  node.getAttribute("aria-label")?.trim() ||
                  node
                    .getAttribute("aria-labelledby")
                    ?.split(/\s+/)
                    .some((id) =>
                      document.getElementById(id)?.textContent.trim(),
                    ) ||
                  [...(node.labels ?? [])].some((label) =>
                    label.textContent.trim(),
                  )
                ),
            )
            .map((node) => ({
              tag: node.tagName,
              placeholder: node.getAttribute("placeholder"),
              type: node.type,
            }));
          return {
            fields: fields.length,
            unlabelled,
            overflow: document.documentElement.scrollWidth > innerWidth + 1,
          };
        });
        results.push({ name, width, ...result });
        if (audit) console.log(JSON.stringify(results.at(-1)));
        else {
          assert.ok(result.fields > 0);
          assert.deepEqual(
            result.unlabelled,
            [],
            `${name}/${width}: every visible field is labelled`,
          );
          assert.equal(result.overflow, false, `${name} fits ${width}`);
          if (targets) {
            for (const control of await page
              .locator(selector)
              .locator("button,input,select,textarea")
              .all()) {
              if (!(await control.isVisible())) continue;
              await control.scrollIntoViewIfNeeded();
              const box = await control.boundingBox();
              assert.ok(
                box && box.width >= 44 && box.height >= 44,
                `${name} 44px target: ${(await control.getAttribute("aria-label")) ?? (await control.textContent())}`,
              );
              if (await control.isEnabled())
                await control.click({ trial: true });
            }
          }
          if (selector === "[role=dialog]")
            await page.locator(selector).evaluate((node) => {
              node.scrollTop = 0;
            });
          await page.screenshot({
            path: `/tmp/showpilot-input-labels-${name}-${width}.png`,
            fullPage: true,
          });
        }
      }
    }
    try {
      await go("production/assets");
      await page.getByRole("heading", { name: "Asset Inventory" }).waitFor();
      await check("asset-list", "main", { targets: true });
      await page
        .getByRole("button", { name: "Edit unit 1", exact: true })
        .click();
      await page.getByPlaceholder("Equipment name...").waitFor();
      await check("asset-edit", "main", { targets: true });
      if (!audit) {
        for (const name of [
          "Equipment name",
          "Location",
          "Serial number",
          "Notes",
        ])
          await page.getByLabel(name, { exact: true }).fill(`Draft ${name}`);
      }
      await page
        .getByRole("button", {
          name: "Cancel editing Fixture microphone",
          exact: true,
        })
        .click();
      await page.getByRole("button", { name: "Add Item", exact: true }).click();
      await page.getByRole("dialog").waitFor();
      await check("asset-add", "[role=dialog]", { targets: true });
      if (!audit) {
        await page
          .getByRole("textbox", { name: "Name", exact: true })
          .fill("Draft asset");
        for (let step = 0; step < 18; step++) {
          await page.keyboard.press("Tab");
          assert.equal(
            await page
              .getByRole("dialog")
              .evaluate((node) => node.contains(document.activeElement)),
            true,
            "dialog contains keyboard focus",
          );
        }
        await page.keyboard.press("Escape");
        await page.getByRole("dialog").waitFor({ state: "hidden" });
        await page.waitForFunction(
          () =>
            document.activeElement?.getAttribute("data-slot") ===
            "dialog-trigger",
          null,
          { timeout: 2_000 },
        );
        assert.equal(
          await page
            .getByRole("button", { name: "Add Item", exact: true })
            .evaluate((node) => node === document.activeElement),
          true,
          "focus returns to Add Item",
        );
        await page.setViewportSize({ width: 320, height: 480 });
        await page
          .getByRole("button", { name: "Add Item", exact: true })
          .click();
        assert.equal(
          await page
            .getByRole("textbox", { name: "Name", exact: true })
            .inputValue(),
          "",
          "dismissed draft is reset",
        );
        await page
          .getByRole("button", { name: "Close add asset dialog", exact: true })
          .click();
        await page.getByRole("dialog").waitFor({ state: "hidden" });
      } else
        await page
          .getByRole("button", { name: "Close add asset dialog", exact: true })
          .click();
      await go("settings?section=organization");
      await page.getByPlaceholder("Repeat PIN").waitFor();
      await check("settings-pin", "main");
      await go("settings?section=people");
      await page
        .getByRole("heading", { name: "Import People", exact: true })
        .waitFor();
      await check("csv-import", "main");
      if (!audit) {
        await page
          .getByLabel("Crew CSV", { exact: true })
          .fill(
            "name,email,role\nFixture,fixture@display-smoke.invalid,Camera",
          );
        await page.getByLabel("Crew CSV", { exact: true }).fill("");
      }
      await go("songs/smoke-song");
      await page
        .getByPlaceholder("Lyrics, up to four display lines per section")
        .first()
        .waitFor();
      await check("song-studio", "main");
      await go("rundown");
      await page.getByPlaceholder("Message to stage display...").waitFor();
      await check("rundown", "main");
      assert.equal((await queryFixture("SELECT id FROM equipment")).length, 1);
      assert.equal(
        (
          await queryFixture(
            "SELECT name FROM equipment WHERE id='fixture-asset'",
          )
        )[0].name,
        "Fixture microphone",
      );
      assert.equal((await capturedEmails()).length, 0);
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          audit,
          passed: !audit,
          results,
          errors,
          emails: 0,
          draftsOnly: true,
        }),
      );
    } finally {
      await browser.close();
    }
  },
  { operatorInputs: true, nativeCueEditor: true, captureEmail: true },
);
