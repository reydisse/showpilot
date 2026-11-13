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
await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, operatorPassword, date }) => {
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
  const errors = [], sockets = new Set(), commands = [], requests = [];
  let mode = "normal", loseSaveReply = false;
  const saves = [];
  const showId = "smoke-show";
  page.on("pageerror", (error) => errors.push(error.message));
  // Forward real relay traffic to the disposable Worker with the fixture session.
  // No production socket is opened. Native hydration and broadcasts remain real.
  await page.routeWebSocket("**/*", (route) => {
    const url = new URL(route.url());
    if (!url.pathname.startsWith(`/api/timecode/${orgId}/`))
      return route.close();
    requests.push(url);
    const local = new URL(`${origin}${url.pathname}${url.search}`);
    local.protocol = "ws:";
    const socket = new WebSocket(local, {
      headers: { Cookie: cookie, Origin: origin },
    });
    sockets.add(socket);
    const queue = [];
    route.onMessage((message) => {
      const packet = JSON.parse(String(message));
      if (packet.type === "command") commands.push({ ...packet, showId: url.searchParams.get("showId") });
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
      route.send(message.toString());
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
    if (url.pathname.startsWith(`/api/timecode/${orgId}/`)) requests.push(url);
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
    if (url.pathname.endsWith("/command") && body && JSON.parse(body).action === "control-cues") {
      saves.push(JSON.parse(body));
      if (loseSaveReply) {
        loseSaveReply = false;
        await new Promise(resolve => setTimeout(resolve, 17_000));
      }
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
  async function cue(id, label = id, action = "lyrics-clear", payload = {}) {
    await command("add-event", { id, label, action, payload, triggerTimecode: { hours: 0, minutes: 0, seconds: 10, frames: 0 } });
  }
  try {
    await page.goto(`${nativeOrigin}/timecode`);
    await button(`Display test show · ${date}`).click();
    await wait(() => button("Claim control").isEnabled(), "hydrated show"); await button("Claim control").click();
    await wait(() => button("Start freerun").isEnabled(), "claimed control");
    await cue("review-cue", "Opening cue");
    await button("Fire now cue Opening cue").click();
    await button("Keep current cues").click();
    assert.equal(saves.length, 0); assert.equal((await events())[0].fired, false);
    await button("Fire now cue Opening cue").click(); await button("Confirm fire cue now").click();
    await button("Continue with current cues").waitFor();
    assert.equal((await events())[0].executionStatus, "acknowledged");
    await button("Continue with current cues").click();
    await button("Re-arm cue Opening cue").click();
    await command("update-event", { id: "review-cue", updates: { label: "Updated opening" } });
    await page.getByText("The cue, timeline, clock or automation state changed. Review the current state before confirming.", { exact: true }).waitFor();
    assert.equal(await button("Confirm re-arm cue").isDisabled(), true);
    for (const width of [320, 768, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `No overflow at ${width}`);
      for (const name of ["Keep current cues", "Confirm re-arm cue", "Review current cues"]) {
        const bounds = await button(name).boundingBox(); assert.ok(bounds.height >= 44 && bounds.width >= 44);
      }
      await page.screenshot({ path: `/tmp/showpilot-native-cue-controls-${width}.png` });
    }
    await button("Review current cues").click(); await wait(() => button("Confirm re-arm cue").isEnabled(), "fresh cue review");
    await button("Keep current cues").click(); assert.equal((await events())[0].fired, true);
    await button("Re-arm cue Updated opening").click(); await button("Confirm re-arm cue").click();
    await button("Continue with current cues").waitFor(); assert.equal((await events())[0].fired, false); await button("Continue with current cues").click();
    const beforeDisable = saves.length; mode = "silent"; loseSaveReply = true;
    await button("Disable cue Updated opening").click();
    await wait(() => saves.length === beforeDisable + 1, "disable committed with lost reply");
    assert.equal((await events())[0].enabled, false);
    await command("set-event-enabled", { id: "review-cue", enabled: true });
    await button("Change show").click(); mode = "normal";
    await button(`Evening test show · ${date}`).click(); assert.equal(await button("Retry original cue action").count(), 0);
    await button("Change show").click(); await button(`Display test show · ${date}`).click();
    await button("Retry original cue action").waitFor({ timeout: 20000 });
    await wait(() => button("Claim control").isEnabled(), "return hydrated"); await button("Claim control").click();
    await wait(() => button("Retry original cue action").isEnabled(), "original action recovery"); mode = "drop-sync";
    await button("Retry original cue action").click();
    await wait(() => saves.length === beforeDisable + 2, "same action recovered");
    assert.equal(saves[beforeDisable].payload.requestId, saves[beforeDisable + 1].payload.requestId);
    assert.equal((await events())[0].enabled, true, "Original disable must preserve a later enable");
    await page.getByText("The current cues could not refresh. Retry their refresh.", { exact: true }).waitFor({ timeout: 15000 }); mode = "normal";
    if (await button("Retry live connection").count()) await button("Retry live connection").click();
    await wait(() => button("Retry cue action refresh").isEnabled(), "reconnected refresh"); await button("Retry cue action refresh").click();
    await button("Continue with current cues").waitFor(); assert.equal(saves.length, beforeDisable + 2, "Refresh must not resend a cue command"); await button("Continue with current cues").click();
    if (await button("Claim control").count()) await button("Claim control").click();
    await cue("failed-device", "Missing test device", "device-action", { deviceId: "missing-fixture-device", actionId: "play", params: {} });
    await button("Fire now cue Missing test device").click(); await button("Confirm fire cue now").click();
    await button("Continue with current cues").waitFor();
    const failed = (await events()).find(event => event.id === "failed-device"); assert.equal(failed.executionStatus, "failed");
    await page.getByText(failed.executionError, { exact: true }).waitFor(); await button("Continue with current cues").click();
    await button("Retry cue Missing test device").click(); await button("Keep current cues").click();
    await button("Retry cue Missing test device").click(); await button("Confirm retry cue").click();
    await button("Continue with current cues").waitFor(); assert.equal((await events()).find(event => event.id === "failed-device").executionStatus, "failed"); await button("Continue with current cues").click();
    await button("Start freerun").click(); await wait(async () => (await clockState()).running, "running clock");
    assert.equal(await button("Re-arm all cues").isDisabled(), true); await button("Stop").click();
    await wait(() => button("Re-arm all cues").isEnabled(), "stopped reset");
    await button("Re-arm all cues").click(); await cue("late-cue", "Late cue");
    await wait(() => button("Confirm re-arm all cues").isDisabled(), "new cue invalidates reset review");
    await button("Keep current cues").click(); await button("Re-arm all cues").click(); await button("Confirm re-arm all cues").click();
    await button("Continue with current cues").waitFor(); assert.equal((await events()).every(event => !event.fired && event.executionStatus === "scheduled"), true); await button("Continue with current cues").click();
    await button("Remove cue Updated opening").click(); await button("Keep current cues").click(); assert.equal((await events()).some(event => event.id === "review-cue"), true);
    await button("Remove cue Updated opening").click(); await button("Confirm remove cue").click();
    await button("Continue with current cues").waitFor(); assert.equal((await events()).some(event => event.id === "review-cue"), false);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: "pass", realAuth: true, realRelay: true, fireReview: true, staleRearmBlocked: true, cancelPreservesCues: true,
      lostReply: true, laterEnablePreserved: true, navigationRecovery: true, refreshOnly: true, failedDeliveryVisible: true, retryReview: true, stoppedReset: true, staleResetBlocked: true, confirmedDelete: true, widths: [320, 768, 1440] }));
  } catch (error) {
    console.error(JSON.stringify({ body: await page.locator("body").innerText(), errors, saves })); throw error;
  } finally {
    for (const socket of sockets) socket.close(); await browser.close(); await new Promise(resolve => server.close(resolve));
  }
}, { secondShow: true });
