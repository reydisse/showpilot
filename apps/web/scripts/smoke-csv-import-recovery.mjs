// Real CSV imports in disposable auth/D1: file errors, exact retry and cancellation.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
const modules = execFileSync("npm", ["root", "-g"], {
  encoding: "utf8",
}).trim();
const { chromium } = createRequire(join(modules, "agent-browser/package.json"))(
  "playwright-core",
);
const ids = {},
  names = ["getCsvImportContext", "importMembersCsv", "reviewCsvImport"];
const assets = resolve(import.meta.dirname, "../dist/server/assets");
for (const file of (await readdir(assets)).filter((file) =>
  file.endsWith(".js"),
)) {
  const source = await readFile(join(assets, file), "utf8");
  for (const name of names)
    ids[name] ??= source.match(
      new RegExp(
        `const ${name}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`,
      ),
    )?.[1];
}
assert.ok(
  names.every((name) => ids[name]),
  JSON.stringify(ids),
);
await withLocalSmokeFixture(
  async ({ origin, orgId, operatorCookie, queryFixture, capturedEmails }) => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    await context.addCookies(
      operatorCookie.split("; ").map((part) => ({
        name: part.slice(0, part.indexOf("=")),
        value: part.slice(part.indexOf("=") + 1),
        url: origin,
      })),
    );
    const page = await context.newPage(),
      errors = [],
      writes = [],
      completed = [],
      held = [];
    let pause = null,
      pauseRead = true;
    const release = () => held.splice(0).forEach((done) => done());
    await page.addInitScript(() => {
      const now = Date.now.bind(Date);
      Date.now = () => now() + 3600000;
      const Reader = window.FileReader;
      window.FileReader = class extends Reader {
        readAsText(file, ...args) {
          if (file.name === "unreadable.csv")
            queueMicrotask(() =>
              this.dispatchEvent(new ProgressEvent("error")),
            );
          else if (file.name !== "held.csv") super.readAsText(file, ...args);
        }
      };
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", async (route) => {
      const req = route.request(),
        url = new URL(req.url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname.endsWith(ids.getCsvImportContext) && pauseRead) {
        const response = await route.fetch();
        await new Promise((done) => held.push(done));
        return route.fulfill({ response }).catch(() => {});
      }
      if (
        req.method() === "POST" &&
        url.pathname.endsWith(ids.importMembersCsv)
      ) {
        const value = req.postData();
        writes.push(value);
        const hold = pause;
        if (hold === "before") await new Promise((done) => held.push(done));
        const response = await route.fetch();
        completed.push(value);
        if (hold === "after") await new Promise((done) => held.push(done));
        return route.fulfill({ response }).catch(() => {});
      }
      return route.continue();
    });
    const button = (name) => page.getByRole("button", { name, exact: true });
    const csv = page.getByLabel("Crew CSV", { exact: true });
    const source =
      "name,email,role\nJane,jane@csv-smoke.invalid,Camera\nBad,not-email,Audio\nJane duplicate,JANE@CSV-SMOKE.INVALID,\nSam,sam@csv-smoke.invalid,";
    const count = async () =>
      (
        await queryFixture(
          "SELECT id FROM crew_member WHERE email LIKE '%@csv-smoke.invalid'",
        )
      ).length;
    async function wait(check, label) {
      const until = Date.now() + 20000;
      while (!(await check())) {
        assert.ok(Date.now() < until, label);
        await page.waitForTimeout(50);
      }
    }
    async function fits(label, controls) {
      for (const [width, height] of [
        [320, 480],
        [768, 1024],
        [1440, 1000],
      ]) {
        await page.setViewportSize({ width, height });
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
        for (const control of controls) {
          await control.scrollIntoViewIfNeeded();
          const box = await control.boundingBox();
          assert.ok(
            box &&
              box.width >= 44 &&
              box.height >= 44 &&
              box.x >= 0 &&
              box.x + box.width <= width + 1,
            `${label} ${width}: ${JSON.stringify(box)}`,
          );
          await control.click({ trial: true });
        }
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        );
        await page.screenshot({
          path: `/tmp/showpilot-csv-recovery-${label}-${width}.png`,
        });
      }
    }
    async function file(name, text = source) {
      await page
        .getByLabel("Choose crew CSV file", { exact: true })
        .setInputFiles({
          name,
          mimeType: "text/csv",
          buffer: Buffer.from(text),
        });
    }
    try {
      await page.goto(`${origin}/${orgId}/settings?section=people`);
      await button("Retry import access").waitFor({ timeout: 16000 });
      assert.equal(writes.length, 0);
      pauseRead = false;
      release();
      await button("Retry import access").click();
      await wait(
        () =>
          button("Retry import access")
            .count()
            .then((n) => n === 0),
        "access recovered",
      );
      await csv.fill("name\nJane");
      await button("Import").click();
      await page
        .getByRole("alert")
        .filter({ hasText: 'Missing an "email" column' })
        .waitFor();
      assert.equal(writes.length, 0);
      await csv.fill(source);
      await file("unreadable.csv");
      await button("Retry file").waitFor();
      assert.equal(await csv.inputValue(), source);
      assert.equal(await button("Upload .csv").count(), 1);
      assert.equal(await button("Import").isDisabled(), true);
      await fits("file-error", [
        button("Retry file"),
        button("Keep current CSV"),
      ]);
      await button("Keep current CSV").click();
      await file("held.csv");
      await button("Retry file").waitFor({ timeout: 14000 });
      await page.getByRole("alert").filter({ hasText: "timed out" }).waitFor();
      assert.equal(await csv.inputValue(), source);
      await button("Keep current CSV").click();
      await file("Sunday-crew-import-with-a-long-but-readable-file-name.csv");
      await wait(() => button("Import").isEnabled(), "file ready");
      pause = "after";
      await button("Import").evaluate((node) => {
        node.click();
        node.click();
      });
      await button("Retry import").waitFor({ timeout: 16000 });
      assert.equal(writes.length, 1);
      assert.equal(await count(), 2);
      await fits("import-retry", [
        button("Retry import"),
        button("Review import result"),
      ]);
      await page.getByRole("link", { name: "Schedule", exact: true }).click();
      await page.waitForURL("**/schedule");
      await page.goBack();
      await button("Retry import").waitFor();
      assert.equal(await csv.inputValue(), source);
      pause = null;
      release();
      await button("Retry import").click();
      await page.getByText("2 imported", { exact: true }).waitFor();
      await page
        .getByText("1 skipped (already on roster)", { exact: true })
        .waitFor();
      await page.getByText("1 error", { exact: true }).waitFor();
      assert.equal(writes[1], writes[0]);
      assert.equal(await count(), 2);
      await csv.fill("name,email\nUndelivered,unsent@csv-smoke.invalid");
      pause = "before";
      await button("Import").click();
      await button("Review import result").waitFor({ timeout: 16000 });
      await button("Review import result").click();
      await button("Continue editing CSV").waitFor();
      await page
        .getByRole("alert")
        .filter({ hasText: "undelivered import was cancelled" })
        .waitFor();
      pause = null;
      release();
      await wait(
        () => completed.length === 3,
        "late request reached cancelled receipt",
      );
      assert.equal(await count(), 2);
      await button("Continue editing CSV").click();
      await wait(() => csv.isEnabled(), "cancelled import unlocks its draft");
      assert.equal(
        await csv.inputValue(),
        "name,email\nUndelivered,unsent@csv-smoke.invalid",
      );
      assert.deepEqual(errors, []);
      assert.equal((await capturedEmails()).length, 0);
      console.log(
        JSON.stringify({
          passed: true,
          accessTimeout: true,
          fileFailureAndTimeout: true,
          previousDraftPreserved: true,
          partialRowSummary: true,
          exactRetryAcrossNavigation: true,
          noDuplicateProfiles: true,
          cancelBeforeDelivery: true,
          clockOffsetHours: 1,
          widths: [320, 768, 1440],
          errors,
          emails: 0,
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          errors,
          writes: writes.length,
          completed: completed.length,
          body: (await page.locator("body").innerText()).slice(-5000),
        }),
      );
      throw error;
    } finally {
      release();
      await browser.close();
    }
  },
  { captureEmail: true },
);
