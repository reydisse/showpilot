// Exercise the built Schedule with real local auth and disposable legacy roster rows.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
const modules = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const { chromium } = createRequire(join(modules, "agent-browser/package.json"))("playwright-core");
const audit = process.argv.includes("--audit");
await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, capturedEmails }) => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies(operatorCookie.split("; ").map(part => ({ name: part.slice(0, part.indexOf("=")), value: part.slice(part.indexOf("=") + 1), url: origin })));
  const page = await context.newPage(), errors = [], failures = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const button = name => page.getByRole("button", { name, exact: true });
  async function reachable(control, width) {
    await control.scrollIntoViewIfNeeded();
    const bounds = await control.boundingBox();
    assert.ok(bounds && bounds.height >= 44 && bounds.width >= 44 && bounds.x >= 0 && bounds.x + bounds.width <= width + 1, `Control at ${width}: ${JSON.stringify(bounds)}`);
    await control.click({ trial: true });
  }
  try {
    await page.goto(`${origin}/${orgId}/schedule?date=2099-01-01&show=assignment-show&month=2099-01`);
    await page.waitForFunction(() => {
      const select = document.querySelector('select[aria-label="Filter crew responses"]');
      return select && Object.keys(select).some(key => key.startsWith("__reactProps$"));
    });
    for (const [width, height] of [[320,480], [768,1024], [1024,768], [1440,1000], [1920,1080]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(async () => {
        await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
        await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
      });
      const title = page.getByRole("heading", { name: "Assignment keyboard fixture", exact: true });
      const titleLayout = await title.evaluate(node => {
        const panel = node.closest("section");
        const style = getComputedStyle(panel);
        const available = panel.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        return { width: node.parentElement.parentElement.getBoundingClientRect().width, minimum: Math.min(288, available) };
      });
      if (!audit) assert.ok(titleLayout.width >= titleLayout.minimum - 1, `Show title squeezed at ${width}: ${JSON.stringify(titleLayout)}`);
      const report = await page.evaluate(() => {
        const visible = node => node.getBoundingClientRect().width > 0;
        const ids = ["assignment-accept", "assignment-decline", "assignment-other", "roster-empty-department", "roster-padded-department"];
        const missing = ids.filter(id => ![...document.querySelectorAll(`[id="assignment-${id}"],[id="assignment-mobile-${id}"]`)].some(visible));
        const short = [...document.querySelectorAll("main button,main select,main summary")].filter(visible).filter(node => node.getBoundingClientRect().height < 44).map(node => node.getAttribute("aria-label") || node.textContent.trim());
        const overflows = [...document.querySelectorAll("main,main section,main article,main [id^=assignment-]")].filter(visible).filter(node => node.scrollWidth > node.clientWidth + 1).map(node => ({ id: node.id, width: node.clientWidth, content: node.scrollWidth }));
        return { missing, short, overflows, rootOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
      });
      console.log(JSON.stringify({ width, ...report }));
      if (report.missing.length || report.short.length || report.overflows.length || report.rootOverflow) failures.push({ width, ...report });
      if (audit) continue;
      assert.deepEqual(report, { missing: [], short: [], overflows: [], rootOverflow: false });
      await reachable(button("Edit Legacy monitor engineer"), width);
      await button("Edit Legacy monitor engineer").click();
      await page.getByRole("dialog").waitFor();
      await page.getByRole("textbox", { name: "Position", exact: true }).waitFor();
      assert.equal(await page.getByRole("textbox", { name: "Position", exact: true }).inputValue(), "Legacy monitor engineer");
      await button("Close assignment").click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      await page.getByRole("combobox", { name: "Filter crew responses", exact: true }).selectOption("declined");
      const note = page.locator("summary:visible").filter({ hasText: "Read response note" });
      await reachable(note, width); await note.focus(); await page.keyboard.press("Enter");
      await page.locator("details[open]:visible p").filter({ hasText: "END-ROSTER-REASON" }).waitFor();
      const body = page.locator("details[open]:visible p");
      assert.equal(await body.evaluate(node => getComputedStyle(node).webkitLineClamp), "none");
      await body.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `/tmp/showpilot-schedule-roster-${width}.png`, fullPage: true });
      await page.getByRole("combobox", { name: "Filter crew responses", exact: true }).selectOption("confirmed");
      await page.getByText("No crew match this response filter.", { exact: true }).waitFor();
      await reachable(button("Show all responses"), width); await button("Show all responses").click();
    }
    assert.deepEqual(failures, []);
    assert.deepEqual(errors, []);
    assert.equal((await capturedEmails()).length, 0);
    console.log(JSON.stringify({ passed: true, widths: [320,768,1024,1440,1920], legacyAssignmentsVisible: true, keyboardNotes: true, filterRecovery: true, errors, emails: 0 }));
  } catch (error) {
    console.log(JSON.stringify({ errors, body: (await page.locator("body").innerText()).slice(-6000) }));
    await page.screenshot({ path: "/tmp/showpilot-schedule-roster-failure.png", fullPage: true });
    throw error;
  } finally { await browser.close(); }
}, { personalAssignments: true, scheduleRoster: true, captureEmail: true });
