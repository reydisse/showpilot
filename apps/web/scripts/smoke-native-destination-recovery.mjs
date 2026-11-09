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
await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, configureStreamOutputs, streamOutputRequests, streamOutputSnapshot }) => {
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
  let holdRead = true, failRead = false, holdWrite = null, reads = 0, holdInputs = false;
  const scope = { orgId, userId: "smoke-operator" };
  const current = async () => (await request(`/api/mobile/v1/destinations/control?${new URLSearchParams(scope)}`)).json();
  async function request(path, body) {
    const response = await fetch(`${origin}${path}`, { method: body ? "POST" : "GET", headers: { cookie, origin, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, 200, await response.clone().text()); return response;
  }
  async function externalEdit(name) {
    const state = await current(), destination = state.destinations.find(d => d.id === "smoke-alpha");
    const response = await request("/api/mobile/v1/destinations/control", { ...scope, requestId: crypto.randomUUID(), operation: { kind: "update", id: destination.id, expectedRevision: destination.revision, fields: { name, platform: destination.platform, rtmpUrl: destination.rtmpUrl, streamKey: "" } } });
    assert.equal((await response.json()).outcome, "applied");
  }
  const release = () => held.splice(0).forEach(done => done());
  page.on("pageerror", error => errors.push(error.message));
  await page.routeWebSocket("**/*", socket => socket.close());
  await page.addInitScript(() => { AbortSignal.prototype.throwIfAborted = undefined; });
  await page.route("**/*", async route => {
    const req = route.request(), url = new URL(req.url());
    if (!url.pathname.startsWith("/api/")) return url.origin === appOrigin ? route.continue() : route.abort();
    const read = url.pathname === "/api/mobile/v1/destinations/control" && req.method() === "GET";
    if (read) reads++;
    if (read && failRead) return route.abort("failed");
    const pauseRead = (read && holdRead) || (url.pathname === "/api/mobile/v1/streaming" && holdInputs);
    const pauseWrite = url.pathname === "/api/mobile/v1/destinations/control" && req.method() === "POST" ? holdWrite : null;
    const body = req.postData();
    if (url.pathname.includes("/destinations") && req.method() === "POST") writes.push({ path: url.pathname, body });
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
      await page.screenshot({ path: `/tmp/showpilot-native-destinations-${label}-${width}.png`, fullPage: true });
    }
  }
  try {
    // Start only the disposable provider's two outputs through the existing web UI.
    await context.addCookies(cookie.split("; ").map(part => ({ name: part.slice(0, part.indexOf("=")), value: part.slice(part.indexOf("=") + 1), url: origin })));
    const web = await context.newPage();
    await web.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await web.goto(`${origin}/${orgId}/streaming/platforms`);
    await web.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent.trim() === "Go Live" && Object.keys(button).some(key => key.startsWith("__reactProps$"))));
    await web.getByRole("button", { name: "Go Live", exact: true }).click();
    await web.getByRole("dialog").getByRole("button", { name: "Go Live", exact: true }).click();
    await wait(async () => (await streamOutputSnapshot()).filter(output => output.enabled).length === 2, "fixture outputs enabled");
    await web.close();
    await page.goto(`${appOrigin}/multi-platform`);
    await button("Retry destinations").waitFor({ timeout: 15000 });
    assert.equal(reads, 1); assert.doesNotMatch(await page.locator("body").innerText(), /No streaming destinations are configured/);
    holdRead = false; release(); await button("Retry destinations").click();
    await button("Disconnect Fixture alpha").click();
    await page.getByText("Disconnect this destination?", { exact: true }).waitFor();
    assert.equal(writes.length, 0);
    await widths("confirmation", ["Keep destination", "Confirm change"]);
    await externalEdit("Fixture alpha");
    await page.getByText("The destination or permissions changed while this confirmation was open. Keep the destination, review the latest state, and try again.", { exact: true }).waitFor();
    assert.equal(await button("Confirm change").isDisabled(), true);
    await button("Keep destination").click(); assert.equal(writes.length, 0);
    await button("Edit Fixture alpha").click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Retained alpha");
    await button("Back to operations").click();
    await page.getByRole("button", { name: /Multi-platform/ }).click();
    await wait(async () => await page.getByRole("textbox", { name: "Name", exact: true }).inputValue() === "Retained alpha", "draft retained after navigation");
    holdWrite = "after"; await button("Save destination").click();
    await button("Retry original request").waitFor({ timeout: 20000 });
    assert.equal((await current()).destinations.find(d => d.id === "smoke-alpha").name, "Retained alpha");
    await widths("uncertain", ["Retry original request", "Review current result"]);
    await externalEdit("Newer alpha");
    holdWrite = null; release(); await button("Retry original request").click(); await button("Dismiss result").waitFor();
    assert.equal(writes.length, 2); assert.equal(writes[0].body, writes[1].body);
    assert.equal((await current()).destinations.find(d => d.id === "smoke-alpha").name, "Newer alpha");
    await button("Dismiss result").click();
    await button("Edit Newer alpha").click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Reviewed alpha");
    await externalEdit("Concurrent alpha"); await button("Use current revision").waitFor();
    assert.equal(await page.getByRole("textbox", { name: "Name", exact: true }).inputValue(), "Reviewed alpha");
    await button("Use current revision").click(); await button("Save destination").click();
    await wait(() => button("Edit Reviewed alpha").isEnabled(), "saved editor closes");
    holdWrite = "before"; await button("Disconnect Reviewed alpha").click(); await button("Confirm change").click();
    await button("Review current result").waitFor({ timeout: 20000 }); await button("Review current result").click();
    await page.getByText("The request was cancelled before it was admitted. Your draft is retained.", { exact: true }).waitFor();
    await button("Dismiss result").waitFor();
    const delayed = JSON.parse(writes.findLast(w => w.path.endsWith("/control")).body);
    holdWrite = null; release();
    assert.equal((await (await request("/api/mobile/v1/destinations/control", delayed)).json()).outcome, "cancelled");
    assert.equal((await streamOutputSnapshot()).filter(output => output.enabled).length, 2);
    await button("Dismiss result").click();
    await configureStreamOutputs("fail-delete");
    await button("Disconnect Fixture beta").click(); await button("Confirm change").click();
    await button("Review current result").waitFor(); await wait(() => button("Review current result").isEnabled(), "provider result ready");
    const deletes = (await streamOutputRequests()).filter(request => request.method === "DELETE").length;
    await button("Review current result").click(); await wait(() => button("Retry original request").isEnabled(), "review complete");
    assert.equal((await streamOutputRequests()).filter(request => request.method === "DELETE").length, deletes, "review never repeats an admitted provider command");
    await configureStreamOutputs("success"); await button("Retry original request").click();
    await button("Select Fixture beta").waitFor(); await button("Dismiss result").waitFor();
    assert.equal((await streamOutputSnapshot()).filter(output => output.enabled).length, 1);
    await button("Dismiss result").click();
    failRead = true; await button("Retry destinations").waitFor();
    assert.match(await page.locator("body").innerText(), /Last confirmed values/);
    assert.equal(await button("Disconnect Reviewed alpha").isDisabled(), true);
    failRead = false; await button("Retry destinations").click(); await wait(() => button("Disconnect Reviewed alpha").isEnabled(), "read recovery");
    await configureStreamOutputs("error"); await button("Retry status for Reviewed alpha").waitFor();
    assert.match(await page.locator("body").innerText(), /Provider status unknown/);
    await configureStreamOutputs("success"); await button("Retry status for Reviewed alpha").click();
    await page.getByText("Provider output enabled", { exact: true }).waitFor();
    holdInputs = true; await button("Open Stream health").click();
    await button("Retry stream inputs").waitFor({ timeout: 15000 });
    assert.doesNotMatch(await page.locator("body").innerText(), /No live input is configured|Inputs confirmed active/i);
    await widths("health-recovery", ["Retry stream inputs", "Manage destinations"]);
    holdInputs = false; release(); await button("Retry stream inputs").click();
    await page.getByText("Live inputs", { exact: true }).waitFor();
    await button("Manage destinations").click();
    await button("Edit Reviewed alpha").click(); await button("Delete destination").click();
    await page.getByText("Delete this destination?", { exact: true }).waitFor(); await button("Keep destination").click();
    await widths("editor", ["Save destination", "Discard draft", "Delete destination"]);
    await button("Delete destination").click(); await button("Confirm change").click();
    await button("Add destination").waitFor();
    assert.equal((await current()).destinations.some(d => d.id === "smoke-alpha"), false);
    assert.equal((await current()).destinations.some(d => d.id === "smoke-beta"), true);
    assert.deepEqual(await streamOutputSnapshot(), []);
    await button("Add destination").click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("New destination");
    await page.getByRole("textbox", { name: "RTMP URL", exact: true }).fill("rtmp://fixture.invalid/new");
    await page.locator('input[aria-label="Stream key"]:visible').fill("fixture-new-private-key");
    await button("Save destination").click(); await button("Select New destination").waitFor(); await button("Select New destination").click();
    await button("Disconnect New destination").waitFor();
    assert.deepEqual(await streamOutputSnapshot(), [], "selection never creates a broadcast");
    assert.equal((await streamOutputRequests()).filter(request => request.method === "POST").length, 2, "only the initial web fixture broadcast created outputs");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, boundedReads: true, staleConfirmation: true, retainedDraft: true, exactRetry: true, newerEditsPreserved: true, delayedRequestCancelled: true, providerReconciliation: true, selectionDoesNotBroadcast: true, viewports: [320, 768, 1440], errors }));
  } catch (error) {
    console.log(JSON.stringify({ writes, errors, body: (await page.locator("body").innerText()).slice(-6000) })); throw error;
  } finally { release(); await browser.close(); if (server) await new Promise(done => server.close(done)); }
}, { streamOutputs: "commands" });
