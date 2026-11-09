// Compiled native manager screens with real auth/D1; no production traffic.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, join } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
const native = true;
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
  let holdRead = true, reads = 0;
  const audit = process.argv.includes("--audit");
  const release = () => held.splice(0).forEach(done => done());
  page.on("pageerror", error => errors.push(error.message));
  await page.routeWebSocket("**/*", socket => socket.close());
  await page.addInitScript(() => { AbortSignal.prototype.throwIfAborted = undefined; });
  await page.route("**/*", async route => {
    const req = route.request(), url = new URL(req.url());
    if (!url.pathname.startsWith("/api/")) return url.origin === appOrigin ? route.continue() : route.abort();
    const read = url.pathname.startsWith("/api/mobile/v1/dashboards/");
    if (read) { assert.equal(req.method(), "GET"); reads++; }
    const pause = read && holdRead;
    const result = await fetch(`${origin}${url.pathname}${url.search}`, { method: req.method(), headers: { ...req.headers(), cookie, origin, host: new URL(origin).host }, ...(req.postData() ? { body: req.postData() } : {}) });
    const bytes = Buffer.from(await result.arrayBuffer());
    if (pause) await new Promise(done => held.push(done));
    await route.fulfill({ status: result.status, headers: { ...Object.fromEntries([...result.headers].filter(([key]) => !["content-encoding", "content-length", "transfer-encoding", "connection"].includes(key))), "access-control-allow-origin": appOrigin, "access-control-allow-credentials": "true" }, body: bytes }).catch(() => {});
  });
  const button = name => page.getByRole("button", { name, exact: true });
  async function widths(label, names) {
    for (const [width, height] of [[320, 480], [768, 1024], [1440, 1000]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(async () => {
        await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
        await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
      });
      for (const name of names) {
        const control = button(name); await control.scrollIntoViewIfNeeded();
        const box = await control.boundingBox();
        assert.ok(box && box.width >= 44 && box.height >= 44 && box.x >= 0 && box.x + box.width <= width + 1, `${name} at ${width}`);
        await control.click({ trial: true });
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label} fits at ${width}`);
      await page.screenshot({ path: `/tmp/showpilot-native-managers-${label}-${width}.png`, fullPage: true });
    }
  }
  try {
    for (const kind of ["prod-manager", "tech-manager"]) {
      holdRead = true; reads = 0;
      await page.goto(`${appOrigin}/${kind}`);
      if (audit) {
        await page.waitForTimeout(11500);
        console.log(JSON.stringify({ kind, reads, retryVisible: await button("Retry dashboard").count() > 0, body: await page.locator("body").innerText() }));
        holdRead = false; release();
        continue;
      }
      await button("Retry dashboard").waitFor({ timeout: 15000 });
      assert.equal(reads, 1, "no automatic retries after deadline");
      assert.doesNotMatch(await page.locator("body").innerText(), /No scheduled show|No unresolved incidents|No crew assignments|Loading manager dashboard/);
      await widths(`${kind}-initial`, ["Retry dashboard"]);
      holdRead = false; release();
      await button("Retry dashboard").click();
      await page.getByText("Open incidents", { exact: true }).first().waitFor();
      await page.getByText("Dashboard could not load. Retry to check readiness.", { exact: true }).waitFor({ state: "hidden" });
      const loaded = await page.locator("body").innerText();
      assert.doesNotMatch(loaded, /Open faults|unresolved faults/);
      holdRead = true;
      await page.getByText("Dashboard could not refresh. Last confirmed values are shown.", { exact: true }).waitFor({ timeout: 20000 });
      await page.getByText("Open incidents", { exact: true }).first().waitFor();
      assert.doesNotMatch(await page.locator("body").innerText(), /Loading manager dashboard/);
      const stoppedReads = reads;
      await widths(`${kind}-refresh`, ["Retry dashboard", kind === "prod-manager" ? "Open schedule" : "Stream health"]);
      assert.equal(reads, stoppedReads, "failed refresh stops polling");
      holdRead = false; release();
      // A late reply must not dismiss the failure or claim a fresh successful read.
      await page.waitForTimeout(100);
      await button("Retry dashboard").click();
      await page.getByText("Dashboard could not refresh. Last confirmed values are shown.", { exact: true }).waitFor({ state: "hidden" });
      console.log(JSON.stringify({ kind, boundedInitialLoad: true, retainedRefreshData: true, explicitRetry: true, viewports: [320, 768, 1440] }));
    }
    assert.deepEqual(errors, []); assert.equal((await capturedEmails()).length, 0);
    console.log(JSON.stringify({ passed: true, audit, errors, emails: 0 }));
  } catch (error) {
    console.log(JSON.stringify({ reads, errors, body: (await page.locator("body").innerText()).slice(-5000) }));
    throw error;
  } finally { release(); await browser.close(); if (server) await new Promise(done => server.close(done)); }
}, { captureEmail: true });
