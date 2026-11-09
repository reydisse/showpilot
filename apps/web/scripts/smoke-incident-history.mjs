// Real compiled web/native UI, auth and D1. All requests stay in disposable fixtures.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, join } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
const native = process.argv.includes("--native");
const modules = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const { chromium } = createRequire(join(modules, "agent-browser/package.json"))("playwright-core");
await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, capturedEmails }) => {
  let cookie = operatorCookie;
  const active = await fetch(`${origin}/api/auth/organization/set-active`, { method: "POST", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ organizationId: orgId }) });
  assert.equal(active.status, 200, await active.clone().text());
  await active.arrayBuffer();
  const cookies = new Map(cookie.split("; ").map(value => [value.split("=")[0], value]));
  active.headers.getSetCookie().forEach(value => { const part = value.split(";")[0]; cookies.set(part.split("=")[0], part); });
  cookie = [...cookies.values()].join("; ");
  let server, appOrigin = origin;
  if (native) {
    const root = resolve(import.meta.dirname, "../../mobile/dist/web");
    server = createServer(async (req, res) => {
      try {
        let file = resolve(root, `.${decodeURIComponent(new URL(req.url, "http://fixture").pathname)}`);
        if (file !== root && !file.startsWith(root + "/")) return res.writeHead(403).end();
        if (!extname(file)) file = file === root ? join(root, "index.html") : file + ".html";
        res.writeHead(200, { "Content-Type": ({ ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".ttf": "font/ttf" })[extname(file)] ?? "application/octet-stream" }).end(await readFile(file));
      } catch { res.writeHead(404).end(); }
    });
    await new Promise(done => server.listen(0, "127.0.0.1", done));
    appOrigin = `http://127.0.0.1:${server.address().port}`;
  }
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  if (!native) await context.addCookies(cookie.split("; ").map(part => ({ name: part.slice(0, part.indexOf("=")), value: part.slice(part.indexOf("=") + 1), url: origin })));
  const page = await context.newPage();
  const errors = [], held = [];
  let holdHistory = native, reads = 0;
  page.on("pageerror", error => errors.push(error.message));
  if (native) {
    await page.addInitScript(() => { AbortSignal.prototype.throwIfAborted = undefined; });
    await page.routeWebSocket("**/*", socket => socket.close());
  }
  await page.route("**/*", async route => {
    const req = route.request(), url = new URL(req.url());
    if (!native) return url.origin === origin ? route.continue() : route.abort();
    if (!url.pathname.startsWith("/api/")) return url.origin === appOrigin ? route.continue() : route.abort();
    const history = url.pathname === "/api/mobile/v1/incidents/history";
    if (history) reads++;
    const hold = history && holdHistory;
    const body = req.postData();
    const result = await fetch(`${origin}${url.pathname}${url.search}`, { method: req.method(), headers: { ...req.headers(), cookie, origin, host: new URL(origin).host }, ...(body ? { body } : {}) });
    const bytes = Buffer.from(await result.arrayBuffer());
    if (hold) await new Promise(done => held.push(done));
    await route.fulfill({ status: result.status, headers: { ...Object.fromEntries([...result.headers].filter(([key]) => !["content-encoding", "content-length", "transfer-encoding", "connection"].includes(key))), "access-control-allow-origin": appOrigin, "access-control-allow-credentials": "true" }, body: bytes }).catch(() => {});
  });
  const button = name => page.getByRole("button", { name, exact: true });
  async function widths(label, controls) {
    for (const [width, height] of [[320, 480], [768, 1024], [1440, 1000]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(async () => {
        await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
        await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
      });
      for (const control of controls) {
        await control.scrollIntoViewIfNeeded();
        const b = await control.boundingBox(); assert.ok(b && b.height >= 44 && b.x >= 0 && b.x + b.width <= width + 1, `${await control.getAttribute("aria-label")} at ${width}: ${JSON.stringify(b)}`);
        await control.click({ trial: true });
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: `/tmp/showpilot-${native ? "native" : "web"}-history-${label}-${width}.png`, fullPage: true });
    }
  }
  try {
    await page.goto(native ? `${appOrigin}/incidents-history` : `${origin}/${orgId}/production/incidents-history`);
    if (native) {
      await page.getByText("Loading history…", { exact: true }).waitFor();
      assert.equal(await page.getByText("matching incidents", { exact: true }).count(), 0);
      assert.equal(await page.getByText("No incidents match these filters.", { exact: true }).count(), 0);
      await button("Retry history").waitFor({ timeout: 20000 });
      assert.equal(reads, 1, "No automatic retry loop after deadline");
      assert.equal(await page.getByText("Loading history…", { exact: true }).count(), 0);
      await widths("error", [button("Retry history"), button("Filter incident history")]);
      holdHistory = false; await button("Retry history").click();
      await page.getByText("Date-only fixture incident", { exact: true }).waitFor();
      held.splice(0).forEach(done => done());
      await button("Filter incident history").click();
      await page.getByLabel("History from date", { exact: true }).fill("2026-02-30");
      await button("Apply filters").click();
      await page.getByText("Enter real dates in YYYY-MM-DD format.", { exact: true }).waitFor();
      assert.equal(reads, 2);
      await page.getByLabel("History from date", { exact: true }).fill("2026-02-28");
      await page.getByLabel("History to date", { exact: true }).fill("2026-02-01");
      await button("Apply filters").click();
      await page.getByText("From date must be on or before To date.", { exact: true }).waitFor();
      assert.equal(reads, 2);
      await widths("filters", [page.getByLabel("Search incident history", { exact: true }), page.getByLabel("History from date", { exact: true }), button("Reset"), button("Apply filters"), button("Close history filters")]);
      await button("Reset").click();
      await page.getByLabel("Search incident history", { exact: true }).fill("not a fixture incident");
      await button("Apply filters").click();
      await page.getByText("No incidents match these filters.", { exact: true }).waitFor();
      assert.equal(await page.getByText("Loading history…", { exact: true }).count(), 0);
    } else {
      await page.getByText("Date-only fixture incident", { exact: true }).waitFor();
      const search = page.getByRole("textbox", { name: "Search incident history", exact: true });
      await page.waitForFunction(() => {
        const input = document.querySelector('input[placeholder="Search issues, people, categories…"]');
        return input && Object.keys(input).some(key => key.startsWith("__reactProps$"));
      });
      await search.fill("fixture");
      await page.getByRole("combobox", { name: "Status", exact: true }).selectOption("open");
      await page.waitForURL(url => url.searchParams.get("query") === "fixture" && url.searchParams.get("status") === "open");
      await page.getByText("Date-only fixture incident", { exact: true }).waitFor();
      await search.fill("discard this"); await button("Clear filters").click();
      await page.waitForFunction(() => document.querySelector('input[placeholder="Search issues, people, categories…"]')?.value === "");
      await new Promise(done => setTimeout(done, 500));
      assert.equal(new URL(page.url()).searchParams.get("query") || "", "");
      await widths("filters", [search, page.getByRole("combobox", { name: "Status", exact: true }), page.getByRole("combobox", { name: "Severity", exact: true }), page.getByRole("combobox", { name: "Category", exact: true }), page.getByRole("textbox", { name: "Assignee", exact: true }), page.getByLabel("From date", { exact: true }), page.getByLabel("To date", { exact: true }), button("Clear filters")]);
      const card = page.getByRole("link").filter({ hasText: "Date-only fixture incident" });
      await card.scrollIntoViewIfNeeded(); await card.focus(); await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Delete incident: Date-only fixture incident", exact: true }).waitFor();
    }
    assert.deepEqual(errors, []); const emails = await capturedEmails(); assert.equal(emails.length, 0);
    console.log(JSON.stringify({ passed: true, native, widths: [320, 768, 1440], historyReads: reads, errors, emails: emails.length }));
  } catch (error) {
    console.log(JSON.stringify({ url: page.url(), body: (await page.locator("body").innerText()).slice(-6000), errors }));
    await page.screenshot({ path: `/tmp/showpilot-history-failure-${native ? "native" : "web"}.png`, fullPage: true });
    throw error;
  } finally {
    held.splice(0).forEach(done => done()); await browser.close();
    if (server) await new Promise(done => server.close(done));
  }
}, { dateOnlyIncident: true, captureEmail: true });
