// Real compiled web/native UI, auth and D1. All requests stay in disposable fixtures.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { resolve, extname, join } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
const native = process.argv.includes("--native");
const modules = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const { chromium } = createRequire(join(modules, "agent-browser/package.json"))("playwright-core");
const ids = {};
if (!native) {
  const assets = resolve(import.meta.dirname, "../dist/server/assets");
  for (const file of (await readdir(assets)).filter(file => file.endsWith(".js"))) {
    const source = await readFile(resolve(assets, file), "utf8");
    for (const name of ["getWorkspaceChange", "saveWorkspaceChange", "reviewWorkspaceChange"])
      ids[name] ??= source.match(new RegExp(`const ${name}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`))?.[1];
  }
  assert.ok(ids.saveWorkspaceChange && ids.getWorkspaceChange && ids.reviewWorkspaceChange);
}
await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, capturedEmails }) => {
  const scope = { orgId, userId: "smoke-operator" };
  let cookie = operatorCookie;
  async function request(path, body) {
    const response = await fetch(`${origin}${path}`, { method: body ? "POST" : "GET", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, 200, await response.clone().text());
    return response;
  }
  const active = await request("/api/auth/organization/set-active", { organizationId: orgId });
  await active.arrayBuffer();
  const cookies = new Map(cookie.split("; ").map(value => [value.split("=")[0], value]));
  active.headers.getSetCookie().forEach(value => { const part = value.split(";")[0]; cookies.set(part.split("=")[0], part); });
  cookie = [...cookies.values()].join("; ");
  const current = async () => (await request(`/api/mobile/v1/workspace/change?${new URLSearchParams(scope)}`)).json();
  async function change(operation) {
    const snapshot = await current();
    const result = await (await request("/api/mobile/v1/workspace/change", { ...scope, requestId: crypto.randomUUID(), expectedRevision: snapshot.revision, operation })).json();
    assert.equal(result.outcome, "applied"); return result;
  }
  await change({ kind: "type", type: "custom", resetModules: false });
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
  const errors = [], calls = [], held = [];
  let holdSave = false, failRead = true;
  page.on("pageerror", error => errors.push(error.message));
  if (native) {
    await page.addInitScript(() => { AbortSignal.prototype.throwIfAborted = undefined; });
    await page.routeWebSocket("**/*", socket => socket.close());
  }
  await page.route("**/*", async route => {
    const req = route.request(), url = new URL(req.url());
    const read = native ? url.pathname === "/api/mobile/v1/workspace/change" && req.method() === "GET" : url.pathname.includes(`/_serverFn/${ids.getWorkspaceChange}`);
    const save = native ? url.pathname === "/api/mobile/v1/workspace/change" && req.method() === "POST" : url.pathname.includes(`/_serverFn/${ids.saveWorkspaceChange}`);
    if (!native && !read && !save) return url.origin === origin ? route.continue() : route.abort();
    if (native && !url.pathname.startsWith("/api/")) return url.origin === appOrigin ? route.continue() : route.abort();
    if (read && failRead) return route.abort("failed");
    const body = req.postData(); if (save) calls.push(body);
    const hold = save && holdSave;
    const result = await fetch(`${origin}${url.pathname}${url.search}`, { method: req.method(), headers: { ...req.headers(), cookie, origin, host: new URL(origin).host }, ...(body ? { body } : {}) });
    const bytes = Buffer.from(await result.arrayBuffer());
    if (hold) await new Promise(done => held.push(done));
    await route.fulfill({ status: result.status, headers: { ...Object.fromEntries([...result.headers].filter(([key]) => !["content-encoding", "content-length", "transfer-encoding", "connection"].includes(key))), "access-control-allow-origin": appOrigin, "access-control-allow-credentials": "true" }, body: bytes }).catch(() => {});
  });
  const button = name => page.getByRole("button", { name, exact: true });
  const wait = async (condition, label) => {
    const end = Date.now() + 20000;
    while (!(await condition())) { if (Date.now() > end) throw new Error(`Timed out: ${label}`); await new Promise(done => setTimeout(done, 50)); }
  };
  async function widths(label, names) {
    for (const [width, height] of [[320, 480], [768, 1024], [1440, 1000]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(async () => {
        await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
        await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
      });
      for (const name of names) {
        const control = button(name); await control.scrollIntoViewIfNeeded();
        const b = await control.boundingBox(); assert.ok(b && b.height >= 44 && b.x >= 0 && b.x + b.width <= width + 1, `${name} at ${width}`);
        await control.click({ trial: true });
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: `/tmp/showpilot-${native ? "native" : "web"}-workspace-${label}-${width}.png`, fullPage: true });
    }
  }
  try {
    const settings = native ? `${appOrigin}/settings` : `${origin}/${orgId}/settings?section=workspace`;
    await page.goto(settings);
    await button("Reload workspace").waitFor(); failRead = false; await button("Reload workspace").click();
    if (!native) {
      await page.getByRole("textbox", { name: "Workspace label", exact: true }).fill("Retained tour names");
      await button("Change type").click();
      await widths("type", ["Save type", "Cancel"]); await button("Cancel").click();
      // Change settings sections without a document reload.
      await page.getByRole("button", { name: "Organization", exact: true }).click();
      await page.getByRole("button", { name: "Workspace", exact: true }).click();
      await wait(async () => await page.getByRole("textbox", { name: "Workspace label", exact: true }).inputValue() === "Retained tour names", "retained names");
      holdSave = true; await button("Save names").click();
    } else {
      await button("School").click(); holdSave = true; await button("Save type").click();
    }
    await button("Retry original change").waitFor({ timeout: 20000 });
    await widths("unknown", ["Retry original change", "Check current settings"]);
    const before = await current();
    assert.equal(native ? before.profile.type : before.profile.label, native ? "school" : "Retained tour names", "the held reply follows a committed save");
    await change({ kind: "module", module: "songs", enabled: false });
    holdSave = false; held.splice(0).forEach(done => done());
    await button("Retry original change").click();
    await button("Use current settings").waitFor();
    assert.equal(calls.length, 2); assert.equal(calls[0], calls[1]);
    assert.equal((await current()).profile.modules.includes("songs"), false);
    assert.notEqual((await current()).revision, before.revision);
    await widths("review", ["Use current settings"]); await button("Use current settings").click();
    if (!native) {
      assert.equal(await page.getByRole("textbox", { name: "Workspace label", exact: true }).inputValue(), "Retained tour names");
      await change({ kind: "module", module: "chat", enabled: false });
      await page.goto(`${origin}/${orgId}/chat`);
      await button("Enable Chat").click();
      await wait(async () => (await current()).profile.modules.includes("chat"), "feature enabled");
      await button("Enable Chat").waitFor({ state: "hidden" });
      assert.equal((await current()).profile.modules.includes("songs"), false);
    }
    assert.deepEqual(errors, []);
    assert.equal((await capturedEmails()).length, 0);
    console.log(JSON.stringify({ result: "pass", native, initialReadRecovery: true, exactRetry: true, newerSettingsPreserved: true, viewports: [320, 768, 1440], emails: 0, errors }));
  } catch (error) {
    console.error(JSON.stringify({ body: await page.locator("body").innerText(), calls, errors })); throw error;
  } finally {
    held.splice(0).forEach(done => done()); await browser.close();
    if (server) await new Promise(done => server.close(done));
  }
}, { captureEmail: true });
