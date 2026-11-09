// Actual restricted dashboard in disposable D1. Never sends an invite or changes a real organization.
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
  async ({ origin, operatorCookie, capturedEmails, queryFixture }) => {
    const before = await queryFixture(
      "SELECT id,betaTester FROM organization ORDER BY id",
    );
    const browser = await chromium.launch({ headless: true }),
      context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        timezoneId: "America/Toronto",
      }),
      page = await context.newPage(),
      errors = [],
      observations = [];
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
    const tab = (name) =>
      audit
        ? page.getByRole("button", { name: new RegExp(`^${name}`) })
        : page.getByRole("tab", { name: new RegExp(`^${name}`) });
    try {
      await page.goto(`${origin}/superadmin`);
      await page
        .getByRole("heading", { name: "ShowPilot Super Admin" })
        .waitFor();
      await page.waitForFunction(() =>
        Object.keys(document.querySelector("button") ?? {}).some((key) =>
          key.startsWith("__reactProps$"),
        ),
      );
      if (audit) {
        const staticContext = await browser.newContext({
          javaScriptEnabled: false,
          timezoneId: "America/Toronto",
        });
        await staticContext.addCookies(await context.cookies());
        const staticPage = await staticContext.newPage();
        await staticPage.goto(`${origin}/superadmin`);
        console.log(
          JSON.stringify({
            serverDate: await staticPage
              .locator("tbody tr")
              .first()
              .locator("td")
              .nth(4)
              .innerText(),
            clientDate: await page
              .locator("tbody tr")
              .first()
              .locator("td")
              .nth(4)
              .innerText(),
          }),
        );
        await staticContext.close();
      }
      for (const [width, height] of [
        [320, 480],
        [768, 1024],
        [1440, 1000],
      ]) {
        await page.setViewportSize({ width, height });
        for (const name of [
          "Waitlist",
          "Users",
          "Organizations",
          "Sessions",
          "Invitations",
        ]) {
          await tab(name).click();
          await page.evaluate(
            () =>
              new Promise((done) =>
                requestAnimationFrame(() => requestAnimationFrame(done)),
              ),
          );
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth + 1,
          );
          const controls = page.locator("button,input,select");
          const small = [];
          for (const control of await controls.all()) {
            if (!(await control.isVisible())) continue;
            await control.scrollIntoViewIfNeeded();
            const box = await control.boundingBox();
            const label = await control.evaluate(
              (node) =>
                node.getAttribute("aria-label") ||
                node.getAttribute("title") ||
                node.textContent?.trim() ||
                node.tagName,
            );
            if (box.width < 44 || box.height < 44)
              small.push({ label, width: box.width, height: box.height });
            if (!audit) {
              assert.ok(
                box.width >= 44 && box.height >= 44,
                `${name}/${width}: ${label} must be 44px`,
              );
              assert.ok(
                box.x >= 0 && box.x + box.width <= width + 1,
                `${label} fits viewport`,
              );
              if (await control.isEnabled())
                await control.click({ trial: true });
            }
          }
          observations.push({ name, width, overflow, small });
          if (audit) console.log(JSON.stringify(observations.at(-1)));
          else assert.equal(overflow, false, `${name} fits ${width}`);
          if (name === "Organizations" && !audit) {
            await page
              .getByLabel("Public launch date", { exact: true })
              .fill("2099-01-02");
            await page
              .getByLabel("Workspace type", { exact: true })
              .selectOption("church");
            await page
              .getByLabel("Workspace type", { exact: true })
              .selectOption("all");
            await page.screenshot({
              path: `/tmp/showpilot-superadmin-orgs-${width}.png`,
              fullPage: true,
            });
          }
        }
        if (!audit) {
          await tab("Waitlist").focus();
          await page.keyboard.press("ArrowRight");
          assert.equal(
            await tab("Users").getAttribute("aria-selected"),
            "true",
          );
          assert.ok(
            await tab("Users").evaluate(
              (node) => node === document.activeElement,
            ),
          );
          await page.keyboard.press("End");
          assert.equal(
            await tab("Invitations").getAttribute("aria-selected"),
            "true",
          );
          await page.keyboard.press("Home");
          assert.equal(
            await tab("Waitlist").getAttribute("aria-selected"),
            "true",
          );
          await page
            .getByRole("button", { name: /^Remove .* from waitlist$/ })
            .click();
          await page.getByRole("dialog").waitFor();
          await page
            .getByRole("button", { name: "Cancel", exact: true })
            .click();
          assert.equal(
            (await queryFixture("SELECT id FROM waitlist_signup")).length,
            1,
          );
        }
      }
      assert.deepEqual(
        await queryFixture(
          "SELECT id,betaTester FROM organization ORDER BY id",
        ),
        before,
      );
      assert.equal((await capturedEmails()).length, 0);
      if (!audit) assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          audit,
          passed: !audit,
          observations,
          errors,
          emails: 0,
        }),
      );
    } finally {
      await browser.close();
    }
  },
  { superadmin: true, captureEmail: true },
);
