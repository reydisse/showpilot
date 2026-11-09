// Actual compiled manager reads/UI against disposable auth/D1. No provider writes.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
const modules = execFileSync("npm", ["root", "-g"], {
  encoding: "utf8",
}).trim();
const { chromium } = createRequire(join(modules, "agent-browser/package.json"))(
  "playwright-core",
);
const require = createRequire(new URL("../package.json", import.meta.url)),
  router = createRequire(require.resolve("@tanstack/react-router")),
  core = createRequire(router.resolve("@tanstack/router-core"));
const { toJSONAsync, fromCrossJSON } = core("seroval"),
  { defaultSerovalPlugins } = router("@tanstack/router-core");
const audit = process.argv.includes("--audit"),
  ids = {},
  assets = resolve(import.meta.dirname, "../dist/server/assets");
for (const file of (await readdir(assets)).filter((file) =>
  file.endsWith(".js"),
)) {
  const source = await readFile(join(assets, file), "utf8");
  for (const name of ["getPmDashboard", "getTmDashboard"])
    ids[name] ??= source.match(
      new RegExp(
        `const ${name}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`,
      ),
    )?.[1];
}
assert.ok(ids.getPmDashboard && ids.getTmDashboard);
await withLocalSmokeFixture(
  async ({
    origin,
    orgId,
    operatorCookie,
    configureReadinessSummary,
    configureReadinessPhase,
    capturedEmails,
  }) => {
    const headers = {
      Cookie: operatorCookie,
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      "x-tsr-serverFn": "true",
      "Content-Type": "application/json",
    };
    async function read(name) {
      const payload = JSON.stringify(await toJSONAsync({ data: { orgId } }));
      const response = await fetch(
        `${origin}/_serverFn/${ids[name]}?payload=${encodeURIComponent(payload)}`,
        { headers },
      );
      if (response.status !== 200) return { error: await response.text() };
      const reply = fromCrossJSON(await response.json(), {
        refs: new Map(),
        plugins: defaultSerovalPlugins,
      });
      return reply instanceof Error ? { error: reply.message } : reply;
    }
    const tm = await read("getTmDashboard"),
      pm = await read("getPmDashboard");
    assert.ok(tm.result, JSON.stringify(tm));
    assert.ok(pm.result, JSON.stringify(pm));
    if (audit) {
      await configureReadinessSummary(true);
      const broken = await read("getPmDashboard");
      await configureReadinessSummary(false);
      console.log(
        JSON.stringify({
          audit,
          technicalCritical: tm.result.model.faults
            .filter((item) => item.severity === "critical")
            .map((item) => item.description),
          checks: tm.result.model.checks,
          streamDetail: tm.result.model.signalPath.detail,
          productionIncidents: pm.result.model.incidents.map(
            (item) => item.description,
          ),
          carriedForward: pm.result.model.openItems.length,
          corruptSummaryRejected: !!broken.error,
        }),
      );
      return;
    }
    assert.equal(tm.result.model.incidentsTruncated, true);
    assert.equal(tm.result.model.faults.length, 25);
    assert.equal(
      tm.result.model.faults[0].description,
      "Older critical readiness fixture",
    );
    assert.equal(tm.result.model.faults[0].severity, "critical");
    assert.equal(tm.result.model.readiness, "fail");
    assert.deepEqual(
      tm.result.model.checks.map((item) => ({
        total: item.total,
        outstanding: item.outstanding,
      })),
      [{ total: 1, outstanding: 1 }],
    );
    assert.match(tm.result.model.signalPath.detail, /selected for Go Live/);
    assert.doesNotMatch(
      tm.result.model.signalPath.detail,
      /destinations? live/,
    );
    assert.deepEqual(pm.result.model.incidents, []);
    assert.equal(pm.result.model.openItems.length, 6);
    assert.equal(pm.result.model.openItemsTruncated, true);
    assert.equal(
      pm.result.model.openItems[0].description,
      "Older critical readiness fixture",
    );
    assert.equal(
      pm.result.model.readiness.factors.find((item) => item.id === "incidents")
        .status,
      "fail",
    );
    await configureReadinessPhase("prep");
    const browser = await chromium.launch({ headless: true }),
      context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      }),
      page = await context.newPage(),
      errors = [];
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
    await page.routeWebSocket("**/*", (socket) => socket.close());
    await page.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.abort(),
    );
    const button = (name) => page.getByRole("button", { name, exact: true });
    try {
      await page.goto(`${origin}/${orgId}/dashboard/prod-manager`);
      await page
        .getByRole("heading", { name: "Production Manager", exact: true })
        .waitFor();
      await page.waitForFunction(() =>
        [...document.querySelectorAll("button")].some(
          (node) =>
            node.getAttribute("aria-label") === "Refresh dashboard" &&
            Object.keys(node).some((key) => key.startsWith("__reactProps$")),
        ),
      );
      const carriedCritical = page
        .getByRole("listitem")
        .filter({ hasText: "Older critical readiness fixture" });
      assert.match(await carriedCritical.innerText(), /critical · audio/);
      assert.ok(
        await carriedCritical
          .locator("span[aria-hidden='true']")
          .evaluate((node) => node.classList.contains("bg-red-500")),
      );
      await page
        .getByText(
          "Showing six highest-priority incidents. Review the incident log for the rest.",
          { exact: true },
        )
        .waitFor();
      await configureReadinessSummary(true);
      await button("Refresh dashboard").click();
      await button("Retry dashboard").waitFor({ timeout: 16000 });
      await page
        .getByRole("heading", { name: "Production Manager", exact: true })
        .waitFor();
      assert.match(
        await page.locator("main").innerText(),
        /Production dashboard could not refresh. Last confirmed values are shown. Retry to check readiness./,
      );
      assert.match(
        await page.locator("main").innerText(),
        /Older critical readiness fixture/,
      );
      await configureReadinessSummary(false);
      await button("Retry dashboard").click();
      await button("Retry dashboard").waitFor({ state: "hidden" });
      await configureReadinessPhase("call");
      await page
        .locator(`aside a[href='/${orgId}/dashboard/tech-manager']`)
        .click();
      await page
        .getByRole("heading", { name: "Tech Manager", exact: true })
        .waitFor();
      assert.match(await page.locator("main").innerText(), /Needs attention/);
      assert.match(
        await page.locator("main").innerText(),
        /Showing the 25 highest-priority incidents/,
      );
      assert.doesNotMatch(
        await page.locator("main").innerText(),
        /destinations? live|Resolved readiness fixture/,
      );
      await page.getByRole("button", { name: /^mine/i }).click();
      await page
        .getByText(
          "No incidents match this view. Change the filter or search.",
          { exact: true },
        )
        .waitFor();
      await page
        .getByRole("link", {
          name: "Review the full incident log",
          exact: true,
        })
        .waitFor();
      await page.getByRole("button", { name: /^all/i }).click();
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
        for (const control of [
          button("Refresh dashboard"),
          button("Arrange widgets"),
          page.getByRole("link", {
            name: "Review the full incident log",
            exact: true,
          }),
        ]) {
          await control.scrollIntoViewIfNeeded();
          const box = await control.boundingBox();
          assert.ok(
            box &&
              box.width >= 44 &&
              box.height >= 44 &&
              box.x >= 0 &&
              box.x + box.width <= width + 1,
            `Readiness control fits ${width}`,
          );
          await control.click({ trial: true });
        }
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        );
        await page.screenshot({
          path: `/tmp/showpilot-manager-readiness-${width}.png`,
          fullPage: true,
        });
      }
      assert.deepEqual(errors, []);
      assert.equal((await capturedEmails()).length, 0);
      console.log(
        JSON.stringify({
          passed: true,
          criticalBacklog: true,
          boundedLists: true,
          resolvedExcluded: true,
          missingChecksOutstanding: true,
          configurationNotLive: true,
          realDatabaseReadFailureRetained: true,
          filterEmptyState: true,
          widths: [320, 768, 1440],
          errors,
          emails: 0,
        }),
      );
    } finally {
      await configureReadinessSummary(false);
      await browser.close();
    }
  },
  { managerReadiness: true, captureEmail: true },
);
