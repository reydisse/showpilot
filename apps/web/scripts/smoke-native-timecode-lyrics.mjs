// Exercise compiled native Timecode against disposable authenticated Worker rooms.
// All app API and socket traffic is intercepted; no production endpoint is contacted.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, join } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
const modules = execFileSync("npm", ["root", "-g"], {
  encoding: "utf8",
}).trim();
const { chromium } = createRequire(join(modules, "agent-browser/package.json"))(
  "playwright-core",
);
const WebSocket = createRequire(join(modules, "agent-browser/package.json"))(
  "ws",
);
const root = resolve(import.meta.dirname, "../../mobile/dist/web");
await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, date }) => {
  const activated = await fetch(`${origin}/api/auth/organization/set-active`, {
    method: "POST",
    headers: {
      Cookie: operatorCookie,
      Origin: origin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ organizationId: orgId }),
  });
  assert.equal(activated.status, 200, await activated.clone().text());
  await activated.arrayBuffer();
  const cookies = new Map(
    operatorCookie.split("; ").map((value) => [value.split("=")[0], value]),
  );
  for (const value of activated.headers.getSetCookie()) {
    const cookie = value.split(";")[0];
    cookies.set(cookie.split("=")[0], cookie);
  }
  const cookie = [...cookies.values()].join("; ");
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(
        new URL(request.url, "http://fixture").pathname,
      );
      let file = resolve(root, `.${pathname}`);
      if (!file.startsWith(root + "/") && file !== root) {
        response.writeHead(403).end();
        return;
      }
      if (!extname(file))
        file = file === root ? join(root, "index.html") : file + ".html";
      const body = await readFile(file);
      response.writeHead(200, {
        "Content-Type":
          {
            ".html": "text/html",
            ".js": "application/javascript",
            ".css": "text/css",
            ".png": "image/png",
            ".woff2": "font/woff2",
            ".ttf": "font/ttf",
          }[extname(file)] ?? "application/octet-stream",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const nativeOrigin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
  });
  // Native AbortSignal implementations need only the aborted flag/event.
  await page.addInitScript(() => {
    AbortSignal.prototype.throwIfAborted = undefined;
  });
  const errors = [], sockets = new Set();
  let mode = "normal", loseReply = false;
  const changes = [], output = [];
  const showId = "smoke-show";
  page.on("pageerror", (error) => errors.push(error.message));
  // Forward real relay traffic to the disposable Worker with the fixture session.
  // No production socket is opened. Native hydration and broadcasts remain real.
  await page.routeWebSocket("**/*", (route) => {
    const url = new URL(route.url());
    if (!url.pathname.startsWith(`/api/timecode/${orgId}/`))
      return route.close();
    const local = new URL(`${origin}${url.pathname}${url.search}`);
    local.protocol = "ws:";
    const socket = new WebSocket(local, {
      headers: { Cookie: cookie, Origin: origin },
    });
    sockets.add(socket);
    const queue = [];
    route.onMessage((message) => {
      if(socket.readyState === WebSocket.OPEN) socket.send(message);
      else queue.push(message);
    });
    let cancelledBeforeOpen = false;
    route.onClose(() => {
      cancelledBeforeOpen = socket.readyState === WebSocket.CONNECTING;
      socket.close();
    });
    socket.on("open", () =>
      queue.splice(0).forEach((message) => socket.send(message)),
    );
    socket.on("message", (message) => {
      if (mode === "silent" || mode === "drop-sync" && JSON.parse(message.toString()).syncId) return;
      const packet = JSON.parse(message.toString());
      if (packet.type === "lyrics-update" || packet.type === "lyrics-clear") output.push(packet.type);
      route.send(JSON.stringify(packet));
    });
    socket.on("error", (error) => {
      // Navigation can cancel the proxy handshake, just as it cancels native
      // authentication. Only that intentional cancellation is expected.
      if (cancelledBeforeOpen && error.message === "WebSocket was closed before the connection was established") return;
      errors.push(error.message);
    });
    socket.on("close", () => {
      sockets.delete(socket);
      void route.close().catch(() => {});
    });
  });
  await page.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      body = request.postData();
    if (!url.pathname.startsWith("/api/"))
      return url.origin === nativeOrigin ? route.continue() : route.abort();
    const headers = {
      "content-type": "application/json",
      "access-control-allow-origin": nativeOrigin,
      "access-control-allow-credentials": "true",
    };
    const result = await fetch(`${origin}${url.pathname}${url.search}`, {
      method: request.method(),
      headers: {
        Cookie: cookie,
        Origin: origin,
        "Content-Type": "application/json",
      },
      ...(body ? { body } : {}),
    });
    const bytes = Buffer.from(await result.arrayBuffer());
    if (url.pathname.endsWith("/command") && body && JSON.parse(body).action === "control-lyrics") {
      changes.push(JSON.parse(body).payload);
      if (loseReply) { loseReply = false; await new Promise(resolve => setTimeout(resolve, 17000)); }
    }
    await route
      .fulfill({ status: result.status, headers, body: bytes })
      .catch(() => {});
  });
  const button = (name) => page.getByRole("button", { name, exact: true });
  const wait = async (check, label, timeout = 20000) => {
    const end = Date.now() + timeout;
    while (!(await check())) {
      if (Date.now() > end) throw new Error(`Timed out: ${label}`);
      await new Promise((done) => setTimeout(done, 50));
    }
  };
  async function clockState() {
    const response = await fetch(`${origin}/api/timecode/${orgId}/state?showId=${showId}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200); return response.json();
  }
  async function command(action, payload) {
    const response = await fetch(`${origin}/api/timecode/${orgId}/command?showId=${showId}`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ action, payload }),
    });
    assert.equal(response.status, 200, await response.text());
  }
  async function events() {
    const response = await fetch(`${origin}/api/timecode/${orgId}/events?showId=${showId}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200); return response.json();
  }
  const longLyrics = "First lyric line\n\nThird lyric line\nFourth lyric line\nFifth lyric line\nSixth lyric line\nSeventh lyric line";
  async function show(text = longLyrics, sectionId = "smoke-verse", sectionLabel = "Verse") {
    await command("set-lyrics", { songId: "smoke-song", songTitle: "Rehearsal song", sectionId, sectionLabel, lyrics: text, nextLabel: "Chorus" });
  }
  try {
    await page.goto(`${nativeOrigin}/timecode`);
    await button(`Display test show · ${date}`).click();
    await wait(() => button("Claim control").isEnabled(), "hydrated show"); await button("Claim control").click();
    await wait(() => button("Start freerun").isEnabled(), "claimed control");

    await show();
    const preview = page.getByTestId("lyrics-preview-text");
    await wait(async () => await preview.textContent() === longLyrics, "all lyric lines and blank lines");
    for (const width of [320, 768, 1440]) {
      await page.setViewportSize({ width, height: 800 }); await preview.scrollIntoViewIfNeeded();
      await wait(async () => await preview.evaluate(node => parseFloat(getComputedStyle(node).fontSize) >= 12), "readable fit floor");
      await page.waitForTimeout(300); // Allow native layout callbacks to converge.
      assert.equal(await preview.textContent(), longLyrics);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `No overflow at ${width}`);
      const size = await preview.evaluate(node => ({ font: parseFloat(getComputedStyle(node).fontSize), height: node.clientHeight, scroll: node.scrollHeight }));
      assert.ok(size.font >= 12 && size.scroll <= size.height + 1);
      for (const name of ["Previous lyrics section", "Next lyrics section", "Clear lyrics"]) { const bounds = await button(name).boundingBox(); assert.ok(bounds.height >= 44 && bounds.width >= 44); }
      await page.screenshot({ path: `/tmp/showpilot-native-lyrics-${width}.png` });
    }
    await page.setViewportSize({ width: 320, height: 800 });
    const dense = Array.from({ length: 50 }, (_, i) => `Complete lyric line ${i + 1}`).join("\n");
    await show(dense); await wait(async () => await preview.textContent() === dense, "dense lyrics preserved");
    await wait(async () => await preview.evaluate(node => parseFloat(getComputedStyle(node).fontSize) <= 12.25), "fit to readable floor");
    assert.ok(await preview.evaluate(node => node.scrollHeight <= node.clientHeight + 1), "Long preview expands instead of clipping");
    await show(); await wait(async () => await preview.textContent() === longLyrics, "reset verse");
    const element = await preview.elementHandle();
    await button("Next lyrics section").click(); await button("Keep current lyrics").click();
    assert.equal(changes.length, 0, "Cancelled review sends no output");
    const before = output.length;
    await button("Next lyrics section").click(); await button("Confirm next lyrics section").click();
    await button("Continue with current lyrics").click();
    assert.equal((await clockState()).lyrics.sectionId, "smoke-chorus");
    assert.deepEqual(output.slice(before), ["lyrics-update"], "Step must replace directly without clear");
    assert.equal(await preview.evaluate((node, previous) => node.isSameNode(previous), element), true, "Preview stays mounted between slides");
    await button("Previous lyrics section").click(); await button("Confirm previous lyrics section").click(); await button("Continue with current lyrics").click();
    assert.equal((await clockState()).lyrics.sectionId, "smoke-verse");
    await button("Clear lyrics").click(); await show("A newer manual verse");
    await wait(() => button("Confirm clear lyrics").isDisabled(), "stale Clear blocked");
    await button("Review current lyrics").click(); await button("Keep current lyrics").click();
    assert.equal((await clockState()).lyrics.lyrics, "A newer manual verse");
    // Lost Next response survives navigation; a later manual display must win.
    loseReply = true; const beforeLost = changes.length;
    await button("Next lyrics section").click(); await button("Confirm next lyrics section").click();
    await wait(() => changes.length === beforeLost + 1, "saved Next with lost reply");
    await show("Later output survives recovery");
    await button("Change show").click(); await button(`Evening test show · ${date}`).click();
    await button("Change show").click(); await button(`Display test show · ${date}`).click();
    if (await button("Claim control").count()) await button("Claim control").click();
    await wait(() => button("Retry original lyrics change").isEnabled(), "retained request", 25000);
    await button("Retry original lyrics change").click(); await button("Continue with current lyrics").click();
    assert.deepEqual(changes[beforeLost], changes[beforeLost + 1]);
    assert.equal((await clockState()).lyrics.lyrics, "Later output survives recovery");
    // A known result refreshes without repeating Clear, even though lyrics are null.
    const beforeRefresh = changes.length; mode = "drop-sync";
    await button("Clear lyrics").click(); await button("Confirm clear lyrics").click();
    await wait(() => button("Retry lyrics refresh").count(), "bounded lyrics refresh", 20000);
    mode = "normal"; await button("Retry lyrics refresh").click(); await button("Continue with current lyrics").click();
    assert.equal(changes.length, beforeRefresh + 1); assert.equal((await clockState()).lyrics, null);
    if (await button("Claim control").count()) await button("Claim control").click();
    await wait(() => button("Start freerun").isEnabled(), "restored control");
    // Boundary errors remain inline and recover to a newly reviewed action.
    await show(); await button("Previous lyrics section").click(); await button("Confirm previous lyrics section").click();
    await page.getByText("Already at the first song section.", { exact: true }).waitFor(); await button("Continue with current lyrics").click();
    await button("Clear lyrics").click(); await button("Confirm clear lyrics").click(); await button("Continue with current lyrics").click();
    assert.equal((await clockState()).lyrics, null);
    assert.equal(await button("Next lyrics section").isDisabled(), true);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: "pass", realAuth: true, realRelay: true, allLinesAndBlankLines: true, readableFit: true,
      denseLyricsExpand: true, directReplacementNoClear: true, stablePreview: true, nextPreviousClear: true, staleReview: true,
      lostReplyNavigation: true, newerLyricsPreserved: true, refreshOnly: true, boundaryError: true, widths: [320, 768, 1440] }));

  } catch (error) {
    console.error(JSON.stringify({ body: await page.locator("body").innerText(), errors })); throw error;
  } finally {
    for (const socket of sockets) socket.close(); await browser.close(); await new Promise(resolve => server.close(resolve));
  }
}, { secondShow: true, nativeCueEditor: true });
