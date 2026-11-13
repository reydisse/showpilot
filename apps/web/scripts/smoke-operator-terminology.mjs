// Verify visible terminology, keyboard tabs and responsive controls in the built app.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
const modules = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const { chromium } = createRequire(join(modules, "agent-browser/package.json"))("playwright-core");
await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, capturedEmails }) => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies(operatorCookie.split("; ").map(part => ({ name: part.slice(0, part.indexOf("=")), value: part.slice(part.indexOf("=") + 1), url: origin })));
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.routeWebSocket("**/*", socket => socket.close());
  await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const button = name => page.getByRole("button", { name, exact: true });
  async function open(path) {
    await page.goto(`${origin}/${orgId}/${path}`);
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some(node => Object.keys(node).some(key => key.startsWith("__reactProps$"))));
  }
  async function fits(label, controls = []) {
    for (const [width, height] of [[320, 480], [768, 1024], [1440, 1000]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(async () => {
        await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
        await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
      });
      for (const control of controls) {
        await control.scrollIntoViewIfNeeded();
        const box = await control.boundingBox();
        assert.ok(box && box.width >= 44 && box.height >= 44 && box.x >= 0 && box.x + box.width <= width + 1, `${label} target at ${width}: ${JSON.stringify(box)}`);
        if (!(await control.isDisabled())) await control.click({ trial: true });
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label} fits at ${width}`);
      await page.screenshot({ path: `/tmp/showpilot-terminology-${label}-${width}.png`, fullPage: true });
    }
  }
  try {
    await open("team");
    const names = ["Workspace members", "Access grants", "Crew roster", "Content reports"];
    const purposes = ["People who can sign in", "Extra permissions", "does not grant workspace sign-in access", "Show reports and handoff notes"];
    for (let i = 0; i < names.length; i++) {
      const tab = page.getByRole("tab", { name: new RegExp(names[i]) });
      await tab.click();
      assert.equal(await tab.getAttribute("aria-selected"), "true");
      assert.ok((await page.getByRole("tabpanel").innerText()).includes(purposes[i]));
      await fits(`team-${i}`, [tab]);
    }
    await page.getByRole("tab", { name: /Content reports/ }).press("Home");
    assert.equal(await page.getByRole("tab", { name: /Workspace members/ }).getAttribute("aria-selected"), "true");
    await page.getByRole("tab", { name: /Workspace members/ }).press("ArrowRight");
    assert.equal(await page.getByRole("tab", { name: /Access grants/ }).getAttribute("aria-selected"), "true");
    await open("streaming/graphics");
    await page.getByText("Save individual graphics", { exact: false }).waitFor();
    await button("Clear program graphics").waitFor();
    await fits("graphics", [button("Clear program graphics")]);
    await button("Clear program graphics").click();
    await page.getByRole("dialog").getByRole("button", { name: "Clear program graphics", exact: true }).waitFor();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("link", { name: "Template Studio", exact: true }).click();
    await page.getByRole("heading", { name: "Template Studio", exact: true }).waitFor();
    await page.getByText("Save graphic stores the selected lower third.", { exact: false }).waitFor();
    await fits("studio", [button("Add lower third"), button("Save graphic"), button("Save scene"), button("Clear program graphics")]);
    await open("dashboard/tech-manager");
    await page.getByRole("heading", { name: "Tech Manager", exact: true }).waitFor();
    assert.doesNotMatch(await page.locator("main").innerText(), /Open faults|No open faults|Technical Control/);
    await fits("tech-manager");
    assert.deepEqual(errors, []);
    assert.equal((await capturedEmails()).length, 0);
    console.log(JSON.stringify({ passed: true, teamPurposes: true, keyboardTabs: true, programClear: true, studioSaveDistinction: true, widths: [320, 768, 1440], errors, emails: 0 }));
  } catch (error) {
    console.log(JSON.stringify({ errors, body: (await page.locator("body").innerText()).slice(-5000) })); throw error;
  } finally { await browser.close(); }
}, { captureEmail: true });
