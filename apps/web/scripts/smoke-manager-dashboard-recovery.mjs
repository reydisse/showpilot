// Compiled manager dashboards, bounded reads and exports with real local auth/D1.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
const modules = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const { chromium } = createRequire(join(modules, "agent-browser/package.json"))("playwright-core");
import { readFile, readdir } from "node:fs/promises";
const audit = process.argv.includes("--audit");
const ids = {};
const assets = resolve(import.meta.dirname, "../dist/server/assets");
for (const file of (await readdir(assets)).filter(file => file.endsWith(".js"))) {
  const source = await readFile(join(assets, file), "utf8");
  for (const name of ["getPmDashboard", "getTmDashboard", "exportShowReport"]) ids[name] ??= source.match(new RegExp(`const ${name}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`))?.[1];
}
assert.equal(Object.keys(ids).filter(name => ids[name]).length, 3);
await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, capturedEmails, queryFixture }) => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies(operatorCookie.split("; ").map(part => ({ name: part.slice(0, part.indexOf("=")), value: part.slice(part.indexOf("=") + 1), url: origin })));
  const page = await context.newPage(), errors = [], held = [];
  let hold = true, reads = 0, exportHold = false;
  const release = () => held.splice(0).forEach(done => done());
  page.on("pageerror", error => errors.push(error.message));
  await page.routeWebSocket("**/*", socket => socket.close());
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    const dashboard = [ids.getPmDashboard, ids.getTmDashboard].some(id => url.pathname.endsWith(id));
    if (dashboard) reads++;
    if ((dashboard && hold) || (url.pathname.endsWith(ids.exportShowReport) && exportHold)) {
      const response = await route.fetch();
      await new Promise(done => held.push(done));
      return route.fulfill({response}).catch(() => {});
    }
    return route.continue();
  });
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
      if (label.endsWith("-controls") || label === "arrangement") {
        const small = await page.locator("main button, main input, main select, main a").evaluateAll(nodes => nodes.filter(node => node.checkVisibility() && !node.closest("[inert]")).map(node => ({ name: node.getAttribute("aria-label") || node.textContent.trim(), box: node.getBoundingClientRect() })).filter(item => item.box.width < 44 || item.box.height < 44).map(item => ({name:item.name,width:item.box.width,height:item.box.height})));
        assert.deepEqual(small, [], `${label} controls at ${width}`);
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label} fits at ${width}`);
      await page.screenshot({ path: `/tmp/showpilot-managers-${label}-${width}.png`, fullPage: true });
    }
  }
  try {
    for (const kind of ["prod-manager", "tech-manager"]) {
      hold = true; reads = 0;
      await open(`dashboard/${kind}`);
      const heading = page.getByRole("heading", {name:kind === "prod-manager" ? "Production Manager" : "Tech Manager",exact:true});
      await heading.waitFor();
      if (audit) {
        if (kind === "tech-manager") await button("Refresh dashboard").click();
        // Production's original periodic refresh is 60 seconds in planning.
        await page.waitForTimeout(kind === "prod-manager" ? 74000 : 14000);
        console.log(JSON.stringify({kind,reads,headingPresent:await heading.count()>0,body:(await page.locator("body").innerText()).slice(-3000)}));
        hold=false;release();continue;
      }
      await button("Retry dashboard").waitFor({timeout:15000});
      await heading.waitFor();
      if (kind === "tech-manager") assert.equal(await button("Take it").isDisabled(), true, "stale incident snapshot cannot be changed");
      assert.equal(reads,1);
      await fits(`${kind}-retry`,[button("Retry dashboard")]);
      hold=false;release();
      await button("Retry dashboard").click();
      await button("Retry dashboard").waitFor({state:"hidden"});
      await fits(`${kind}-controls`,[button("Choose show"),button("Refresh dashboard")]);
      await button("Choose show").click();
      const option=page.getByRole("menuitem").first();
      await fits(`${kind}-menu`,[option]);
      await page.keyboard.press("Escape");
      if(kind === "tech-manager") {
        await button("Take it").click({ trial: true });
        await button("Arrange widgets").click();
        assert.deepEqual(await button("Take it").evaluate(node => { node.focus(); return { inert: !!node.closest("[inert]"), disabled: node.disabled, focusBlocked: document.activeElement !== node }; }), { inert: true, disabled: true, focusBlocked: true }, "arranging blocks actual keyboard focus and incident actions");
        await fits("arrangement",[button("Done arranging"),button("Move System overview down")]);
        assert.equal(await page.locator("[inert]").count() > 0, true, "operational regions are keyboard-inert while arranging");
        await button("Move System overview down").press("Enter");
        await page.waitForFunction(() => ![...document.querySelectorAll("button[aria-label='Move System overview up']")].some(button => button.disabled));
        const storedLayout = async () => JSON.parse((await queryFixture("SELECT layout FROM dashboard_layout WHERE dashboard = 'tech-manager' LIMIT 1"))[0].layout);
        const beforeDrag = await storedLayout();
        await button("Move Incidents up").locator("..").locator("..").dragTo(button("Move Before the service up").locator("..").locator(".."));
        const until = Date.now() + 10000;
        while ((await storedLayout()).main[0] !== "faults") { assert.ok(Date.now() < until, "widget drag persisted"); await page.waitForTimeout(50); }
        assert.deepEqual((await storedLayout()).sections, beforeDrag.sections, "widget drag does not reorder parent sections");
        await button("Done arranging").click();
        await page.reload();
        await page.waitForFunction(() => [...document.querySelectorAll("button")].some(node => node.textContent.trim() === "Arrange widgets" && Object.keys(node).some(key => key.startsWith("__reactProps$"))));
        await button("Arrange widgets").click();
        await button("Move System overview up").click({ trial: true });
        assert.equal(await button("Move System overview up").isDisabled(), false, "keyboard reorder persisted after the control snapshot refreshes");
        assert.equal(await button("Move Incidents up").isDisabled(), true, "drag order survives reload");
        await button("Done arranging").click();
      } else {
        const downloads=[];page.on("download",download=>downloads.push(download.suggestedFilename()));
        exportHold=true;await button("Show report").click();
        await button("Retry report").waitFor({timeout:20000});
        await fits("report-error",[button("Retry report")]);
        exportHold=false;release();await page.waitForTimeout(100);
        assert.equal(downloads.length,0,"late report does not download after timeout");
        const [download] = await Promise.all([page.waitForEvent("download",{timeout:20000}), button("Retry report").click()]);
        assert.equal(downloads.length,1);
        const bytes = await readFile(await download.path());
        assert.equal(bytes.subarray(0,4).toString(), "%PDF");
        assert.ok(bytes.length > 1000, "retry downloads a real PDF");
      }
      console.log(JSON.stringify({kind,boundedRefresh:true,retainedDashboard:true,retry:true,widths:[320,768,1440]}));
    }
    if(!audit) assert.deepEqual(errors,[]);
    assert.equal((await capturedEmails()).length,0);
    console.log(JSON.stringify({passed:true,audit,errors}));
  } catch(error) {console.log(JSON.stringify({reads,errors,body:(await page.locator("body").innerText()).slice(-5000)}));throw error;}
  finally {release();await browser.close();}
},{captureEmail:true,dateOnlyIncident:true});
