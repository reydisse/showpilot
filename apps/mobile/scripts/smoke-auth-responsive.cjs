// Run against Expo web: node apps/mobile/scripts/smoke-auth-responsive.cjs http://127.0.0.1:8085
// Requires agent-browser (and its Chromium install). Native keyboard/orientation checks use Simulator.
const { execFileSync } = require("node:child_process");
const { createRequire } = require("node:module");
const path = require("node:path");
const globalModules = execFileSync("npm", ["root", "-g"], {
  encoding: "utf8",
}).trim();
const { chromium } = createRequire(
  path.join(globalModules, "agent-browser/package.json"),
)("playwright-core");
const origin = new URL(process.argv[2] || "http://127.0.0.1:8085").origin;
const assert = require("node:assert/strict");
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // Auth reads are stubbed as signed out. Validation must never send an auth write.
    const authWrites = [];
    await page.route("**/api/auth/**", (route) => {
      if (route.request().method() !== "GET") {
        authWrites.push(route.request().url());
        return route.abort();
      }
      return route.fulfill({
        status: 200,
        headers: {
          "content-type": "application/json",
          "access-control-allow-origin": origin,
          "access-control-allow-credentials": "true",
        },
        body: "null",
      });
    });
    for (const mode of ["sign-in", "sign-up"]) {
      await page.goto(origin + "/" + mode);
      await page.getByLabel("Email address", { exact: true }).waitFor();
      for (const [width, height] of [
        [320, 568],
        [390, 844],
        [768, 1024],
        [834, 1194],
        [900, 900],
        [901, 900],
        [1024, 768],
        [1032, 1376],
        [1366, 1024],
        [844, 390],
      ]) {
        await page.setViewportSize({ width, height });
        await page.waitForTimeout(150);
        const result = await page.evaluate(() => {
          const entry = document.querySelector('[data-testid="auth-entry"]');
          const inputs = [...document.querySelectorAll("input")];
          const submit = document.querySelector(
            '[role="button"][aria-label="Sign in"], [role="button"][aria-label="Create account"]',
          );
          const controls = [...inputs, submit];
          return {
            overflow: document.documentElement.scrollWidth > innerWidth + 1,
            wide: !!document.querySelector('[data-testid="auth-art-panel"]'),
            entryWidth: entry.getBoundingClientRect().width,
            inputs: inputs.length,
            controlsFit: controls.every((el) => {
              const r = el.getBoundingClientRect();
              return (
                r.left >= 19 && r.right <= innerWidth - 19 && r.height >= 44
              );
            }),
            inputFont: parseFloat(getComputedStyle(inputs[0]).fontSize),
          };
        });
        const label = mode + " " + width + "x" + height;
        assert.equal(result.overflow, false, label + ": overflow");
        assert.equal(result.wide, width > 900, label + ": wrong layout");
        assert.equal(
          result.inputs,
          mode === "sign-up" ? 3 : 2,
          label + ": wrong fields",
        );
        assert.ok(
          result.controlsFit && result.inputFont >= 16,
          label + ": clipped controls",
        );
        if (width <= 900)
          assert.equal(result.entryWidth, width, label + ": wrong width");
        await page
          .getByRole("button", {
            name: mode === "sign-up" ? "Create account" : "Sign in",
            exact: true,
          })
          .scrollIntoViewIfNeeded();
        await page
          .getByRole("button", {
            name: mode === "sign-up" ? "Create account" : "Sign in",
            exact: true,
          })
          .click();
        await page.getByRole("alert").waitFor();
        console.log(label + ": passed");
      }
      await page
        .getByLabel("Password", { exact: true })
        .fill("visual-test-only");
      await page
        .getByRole("button", { name: "Show password", exact: true })
        .click();
      assert.equal(
        await page
          .getByLabel("Password", { exact: true })
          .evaluate((el) => el.type),
        "text",
      );
      await page
        .getByRole("button", { name: "Hide password", exact: true })
        .click();
      assert.equal(
        await page
          .getByLabel("Password", { exact: true })
          .evaluate((el) => el.type),
        "password",
      );
      await page
        .getByRole("button", {
          name: mode === "sign-up" ? "Sign in instead" : "Create an account",
          exact: true,
        })
        .click();
      await page.waitForURL(
        "**/" + (mode === "sign-up" ? "sign-in" : "sign-up"),
      );
    }
    await page.setViewportSize({ width: 1366, height: 1024 });
    for (const [month, title] of [
      ["10", "Every cue."],
      ["11", "Make room"],
      ["12", "Everyone ready."],
    ]) {
      await page.clock.setFixedTime(new Date(`2026-${month}-15T12:00:00Z`));
      await page.goto(origin + "/sign-in");
      await page.getByText(title, { exact: false }).waitFor();
      console.log(`Season ${month}: passed`);
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();
    await page.getByLabel("Email address", { exact: true }).waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Pause artwork animation" })
        .count(),
      0,
    );
    assert.deepEqual(authWrites, [], "Validation sent an auth request");
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
