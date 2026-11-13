// Real compiled web/native UI, auth and D1. All requests stay in disposable fixtures.
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
  const errors = [], writes = [], held = [];
  let holdRead = true, failRead = false, holdWrite = null, reads = 0;
  const scope = { orgId, userId: "smoke-operator" };
  const current = async () => (await request(`/api/mobile/v1/graphics/control?${new URLSearchParams(scope)}`)).json();
  async function request(path, body) {
    const response = await fetch(`${origin}${path}`, { method: body ? "POST" : "GET", headers: { cookie, origin, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, 200, await response.clone().text()); return response;
  }
  async function externalEdit(title) {
    const state = await current(), graphic = state.templates.find(g => g.id === "smoke-graphic");
    const response = await request("/api/mobile/v1/graphics/control", { ...scope, requestId: crypto.randomUUID(), operation: { kind: "update", id: graphic.id, expectedGraphicRevision: graphic.revision, expectedProgramRevision: state.programRevision, content: { name: graphic.name, title, subtitle: graphic.subtitle } } });
    assert.equal((await response.json()).outcome, "applied");
  }
  const release = () => held.splice(0).forEach(done => done());
  page.on("pageerror", error => errors.push(error.message));
  await page.routeWebSocket("**/*", socket => socket.close());
  await page.addInitScript(() => { AbortSignal.prototype.throwIfAborted = undefined; });
  await page.route("**/*", async route => {
    const req = route.request(), url = new URL(req.url());
    if (!url.pathname.startsWith("/api/")) return url.origin === appOrigin ? route.continue() : route.abort();
    const read = url.pathname === "/api/mobile/v1/graphics/control" && req.method() === "GET";
    if (read) reads++;
    if (read && failRead) return route.abort("failed");
    const pauseRead = read && holdRead;
    const pauseWrite = url.pathname === "/api/mobile/v1/graphics/control" && req.method() === "POST" ? holdWrite : null;
    const body = req.postData();
    if (url.pathname.includes("/graphics") && req.method() === "POST") writes.push({ path: url.pathname, body });
    if (pauseWrite === "before") await new Promise(done => held.push(done));
    const result = await fetch(`${origin}${url.pathname}${url.search}`, { method: req.method(), headers: { ...req.headers(), cookie, origin, host: new URL(origin).host }, ...(body ? { body } : {}) });
    const bytes = Buffer.from(await result.arrayBuffer());
    if (pauseRead || pauseWrite === "after") await new Promise(done => held.push(done));
    await route.fulfill({ status: result.status, headers: { ...Object.fromEntries([...result.headers].filter(([key]) => !["content-encoding", "content-length", "transfer-encoding", "connection"].includes(key))), "access-control-allow-origin": appOrigin, "access-control-allow-credentials": "true" }, body: bytes }).catch(() => {});
  });
  const button = name => page.getByRole("button", { name, exact: true });
  async function wait(check, label) {
    const deadline = Date.now() + 20000;
    while (!(await check())) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await new Promise(done => setTimeout(done, 50)); }
  }
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
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: `/tmp/showpilot-native-graphics-${label}-${width}.png`, fullPage: true });
    }
  }
  try {
    await page.goto(`${appOrigin}/lower-thirds`);
    await button("Retry graphics").waitFor({ timeout: 15000 });
    assert.equal(reads, 1, "no automatic retries of a timed-out read");
    assert.doesNotMatch(await page.locator("body").innerText(), /No lower-third templates|Cloud graphics are disabled/);
    holdRead = false; release(); await button("Retry graphics").click();
    await button("Take off air").click();
    await page.getByText("Take this graphic off air?", { exact: true }).waitFor();
    assert.equal(writes.length, 0, "Output needs a visible confirmation before sending");
    await widths("confirmation", ["Keep current graphics", "Confirm change"]);
    await button("Keep current graphics").click(); assert.equal(writes.length, 0);
    await button("Edit Fixture").click();
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("Retained native graphic");
    await button("Back to operations").click();
    await page.getByRole("button", { name: /Lower thirds/ }).click();
    await wait(async () => await page.getByRole("textbox", { name: "Title", exact: true }).inputValue() === "Retained native graphic", "draft retained after navigation");
    await button("Save graphic").click();
    await page.getByText("Change this live graphic?", { exact: true }).waitFor();
    assert.equal(writes.length, 0);
    holdWrite = "after"; await button("Confirm change").click();
    await button("Retry original request").waitFor({ timeout: 20000 });
    assert.equal((await current()).templates[0].title, "Retained native graphic", "lost reply follows a committed save");
    await widths("uncertain", ["Retry original request", "Review current graphics"]);
    await externalEdit("Newer operator title");
    holdWrite = null; release(); await button("Retry original request").click();
    await button("Dismiss result").waitFor();
    assert.equal(writes.length, 2); assert.equal(writes[0].body, writes[1].body, "retry retains the original command exactly");
    assert.equal((await current()).templates[0].title, "Newer operator title", "retry cannot overwrite newer content");
    await button("Dismiss result").click();
    await button("Edit Fixture").click();
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("My reviewed replacement");
    await externalEdit("Concurrent title");
    await button("Use current revision").waitFor();
    assert.equal(await page.getByRole("textbox", { name: "Title", exact: true }).inputValue(), "My reviewed replacement");
    await button("Use current revision").click();
    await button("Save graphic").click(); await button("Confirm change").click();
    await button("Edit Fixture").waitFor();
    await wait(async () => await button("Edit Fixture").isEnabled(), "saved editor closes");
    assert.equal((await current()).templates[0].title, "My reviewed replacement");
    // Delay delivery itself. Reviewing must fence the original request before it arrives.
    holdWrite = "before"; await button("Take off air").click(); await button("Confirm change").click();
    await button("Review current graphics").waitFor({ timeout: 20000 });
    await button("Review current graphics").click();
    await page.getByText("The request was cancelled before it arrived. Your draft is retained.", { exact: true }).waitFor();
    await button("Dismiss result").waitFor();
    const delayed = JSON.parse(writes.findLast(w => w.path.endsWith("/control")).body);
    holdWrite = null; release();
    assert.equal((await (await request("/api/mobile/v1/graphics/control", delayed)).json()).outcome, "cancelled");
    assert.deepEqual((await current()).activeIds, ["smoke-graphic"]);
    await button("Dismiss result").click();
    failRead = true; await button("Retry graphics").waitFor();
    assert.match(await page.locator("body").innerText(), /Last confirmed state/);
    assert.equal(await button("Take off air").isDisabled(), true);
    failRead = false; await button("Retry graphics").click();
    await wait(() => button("Take off air").isEnabled(), "read recovery");
    await button("Take off air").click(); await button("Confirm change").click();
    await button("Take live").waitFor(); assert.deepEqual((await current()).activeIds, []);
    await button("Take live").click(); await page.getByText("Take this graphic live?", { exact: true }).waitFor();
    await button("Confirm change").click(); await button("Take off air").waitFor();
    await button("Clear program graphics").click();
    await page.getByText("Clear program graphics?", { exact: true }).waitFor();
    await button("Keep current graphics").click(); assert.deepEqual((await current()).activeIds, ["smoke-graphic"]);
    await button("Edit Fixture").click(); await button("Delete template").click();
    await page.getByText("Delete this graphic?", { exact: true }).waitFor();
    await button("Keep current graphics").click(); assert.equal((await current()).templates.length, 1);
    await widths("editor", ["Save graphic", "Discard draft", "Delete template"]);
    // Existing installed clients still use this endpoint. Trigger writes must
    // not turn a successful legacy edit into a false 404 acknowledgement.
    const legacyBefore = (await current()).templates.find(g => g.id === "smoke-graphic");
    const oldLibrary = await (await request(`/api/mobile/v1/graphics?orgId=${encodeURIComponent(orgId)}`)).json();
    const legacyReply = await (await request(`/api/mobile/v1/graphics/smoke-graphic?orgId=${encodeURIComponent(orgId)}`,
      { name: "Fixture", title: "Legacy client saved title", subtitle: legacyBefore.subtitle })).json();
    assert.equal(legacyReply.ok, true);
    const legacyAfter = (await current()).templates.find(g => g.id === "smoke-graphic");
    assert.equal(legacyAfter.title, "Legacy client saved title");
    assert.ok(legacyAfter.revision > legacyBefore.revision);
    const newLibrary = await (await request(`/api/mobile/v1/graphics?orgId=${encodeURIComponent(orgId)}`)).json();
    assert.equal(newLibrary.templates[0].style, oldLibrary.templates[0].style);
    assert.deepEqual(newLibrary.activeIds, oldLibrary.activeIds);
    assert.deepEqual(errors, []); assert.equal((await capturedEmails()).length, 0);
    console.log(JSON.stringify({ passed: true, boundedRead: true, confirmationBeforeWrite: true, retainedDraft: true, exactRetry: true, newerEditsPreserved: true, delayedRequestCancelled: true, legacyEditAcknowledged: true, legacyStyleAndOutputPreserved: true, viewports: [320, 768, 1440], emails: 0, errors }));
  } catch (error) {
    console.log(JSON.stringify({ writes, errors, body: (await page.locator("body").innerText()).slice(-5000) }));
    throw error;
  } finally { release(); await browser.close(); if (server) await new Promise(done => server.close(done)); }
}, { captureEmail: true });
