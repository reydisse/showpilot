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
  let mode = "normal", loseChoiceReply = true;
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
      if (mode === "silent") return;
      const packet = JSON.parse(message.toString());
      if (packet.events) packet.events.reverse(); // Deliberately unsorted input.
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
    if (loseChoiceReply && url.pathname.endsWith("/devices")) {
      loseChoiceReply = false; await new Promise(resolve => setTimeout(resolve, 11000));
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
  async function cue(id, seconds, patch = {}) {
    await command("add-event", { id, label: id, action: "lyrics-clear", payload: {},
      triggerTimecode: { hours: 0, minutes: 0, seconds, frames: 0 }, ...patch });
  }
  try {
    await page.goto(`${nativeOrigin}/timecode`);
    await button(`Display test show · ${date}`).click();
    await wait(() => button("Claim control").isEnabled(), "hydrated show"); await button("Claim control").click();
    await wait(() => button("Start freerun").isEnabled(), "claimed control");

    await command("set-format", { format: { frameRate: 29.97, dropFrame: "df" }, expectedFormat: (await clockState()).format, confirmed: true });
    await command("set-timecode", { timecode: { hours: 0, minutes: 0, seconds: 10, frames: 1 } });
    await cue("Early dispatch", 20, { leadMs: 8000 });
    await cue("Nominal first", 15);
    await cue("Overdue cue", 10, { toleranceFrames: 5 });
    await cue("Missed cue", 1, { toleranceFrames: 5 });
    await cue("Disabled cue", 2, { enabled: false });
    await cue("Switcher cue", 25, { action: "device-action", payload: { deviceId: "smoke-switcher", actionId: "set_program_input", params: { input: 2 } } });
    await cue("Private webhook", 30, { action: "custom-webhook", payload: { url: "https://example.com/private?token=should-not-render" } });
    const next = page.getByTestId("next-cue"), row = id => page.getByTestId(`timeline-cue-${id}`);
    await wait(async () => (await next.innerText()).includes("Next: Early dispatch · in 2.0s · Clock held"), "dispatch countdown while stopped");
    assert.match(await row("Early dispatch").innerText(), /NEXT/);
    assert.match(await row("Overdue cue").innerText(), /OVERDUE/);
    assert.match(await row("Missed cue").innerText(), /MISSED/);
    assert.match(await row("Disabled cue").innerText(), /Disabled/);
    assert.match(await row("Early dispatch").innerText(), /00:00:20;00/);
    assert.match(await page.getByTestId("timecode-transport").innerText(), /00:00:10;01/, JSON.stringify(await clockState()));
    assert.match(await row("Early dispatch").innerText(), /cue lead 8000 ms/);
    assert.match(await row("Early dispatch").innerText(), /Tolerance: 5 frames/);
    assert.deepEqual(await page.locator('[data-testid^="timeline-cue-"]').evaluateAll(rows => rows.map(row => row.getAttribute("data-testid"))), ["Missed cue", "Disabled cue", "Overdue cue", "Nominal first", "Early dispatch", "Switcher cue", "Private webhook"].map(id => `timeline-cue-${id}`));
    await button("Retry device names").waitFor({ timeout: 15000 }); await button("Retry device names").click();
    await wait(async () => (await row("Switcher cue").innerText()).includes("Device: Rehearsal switcher"), "bounded device-name retry");
    assert.match(await row("Switcher cue").innerText(), /set program input · input: 2/);
    assert.match(await row("Private webhook").innerText(), /POST https:\/\/example.com/);
    assert.equal((await row("Private webhook").innerText()).includes("should-not-render"), false);
    assert.equal(await button("Fire next").isDisabled(), true, "Clock jump pauses automation");
    await button("Review resume automation").click(); await button("Confirm resume").click();
    await button("Continue with current automation").click();
    await button("Fire next").click(); await button("Keep current cues").click();
    assert.equal((await events()).find(event => event.id === "Early dispatch").fired, false);
    await button("Fire next").click(); await button("Confirm fire cue now").click();
    await button("Continue with current cues").click();
    assert.equal((await events()).find(event => event.id === "Early dispatch").fired, true);
    await wait(async () => (await next.innerText()).includes("Next: Nominal first"), "next advances after confirmed manual cue");
    await cue("Failed device", 40, { action: "device-action", payload: { deviceId: "missing-fixture-device", actionId: "play", params: {} } });
    await button("Fire now cue Failed device").click(); await button("Confirm fire cue now").click(); await button("Continue with current cues").click();
    await wait(async () => (await row("Failed device").innerText()).includes("FAILED"), "honest failure status");
    assert.match(await page.getByTestId("cue-attention").innerText(), /Failed device · FAILED/);
    await button("Retry Failed device from attention list").click(); await button("Keep current cues").click();
    await button("Fire Missed cue from attention list").click(); await button("Keep current cues").click();
    for (const width of [320, 768, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      await row("Private webhook").scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `No overflow at ${width}`);
      for (const name of ["Start freerun", "Stop", "Stop automation"]) {
        const bounds = await button(name).boundingBox(); assert.ok(bounds.height >= 44 && bounds.width >= 44);
        assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 800, `${name} remains visible at ${width}`);
      }
      assert.match(await page.getByTestId("timecode-transport").innerText(), /00:00:10;01/);
      await page.screenshot({ path: `/tmp/showpilot-native-timeline-${width}.png` });
    }
    await page.setViewportSize({ width: 320, height: 568 });
    await row("Private webhook").scrollIntoViewIfNeeded();
    for (const name of ["Start freerun", "Stop", "Stop automation"]) {
      const bounds = await button(name).boundingBox(); assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 568);
    }
    await page.screenshot({ path: "/tmp/showpilot-native-timeline-short.png" });
    // Starting and stopping from the fixed header must still affect the real room.
    await button("Start freerun").click(); await wait(async () => (await clockState()).running, "live fixed-header start");
    assert.match(await page.getByTestId("timecode-transport").innerText(), /Running/);
    await button("Stop automation").click(); await wait(async () => !(await clockState()).triggersEnabled, "fixed automation stop");
    assert.equal((await clockState()).running, true, "Automation stop keeps the clock running");
    await wait(async () => (await page.getByTestId("timecode-transport").innerText()).includes("Automation stopped"), "visible automation-stop confirmation");
    await button("Stop").click(); await wait(async () => !(await clockState()).running, "fixed-header stop");
    // Suppress live traffic and verify the client labels its cached timeline honestly.
    mode = "silent"; for (const socket of sockets) socket.close();
    await wait(async () => (await next.innerText()).includes("Last known next"), "disconnected next label");
    assert.equal(await button("Fire next").isDisabled(), true);
    for (const name of ["Start freerun", "Stop", "Stop automation"]) assert.equal(await button(name).isDisabled(), true);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: "pass", realAuth: true, realRelay: true, reversedWireOrder: true, dispatchCountdown: true,
      dropFrameLabels: true, missedOverdueDisabledFailed: true, boundedDeviceNames: true, safePayloadSummary: true,
      confirmedFireNext: true, attentionReviews: true, fixedTransport: true, shortViewport: true, visibleStopConfirmation: true, disconnectedHonesty: true, widths: [320, 768, 1440] }));

  } catch (error) {
    console.error(JSON.stringify({ body: await page.locator("body").innerText(), errors })); throw error;
  } finally {
    for (const socket of sockets) socket.close(); await browser.close(); await new Promise(resolve => server.close(resolve));
  }
}, { secondShow: true, nativeCueEditor: true });
