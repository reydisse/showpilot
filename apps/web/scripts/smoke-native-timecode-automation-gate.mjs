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
    if (url.pathname.endsWith("/command") && body && JSON.parse(body).action === "edit-automation-gate") {
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
  try {
    await page.goto(`${nativeOrigin}/timecode`);
    await button(`Display test show · ${date}`).click();
    await wait(() => button("Claim control").isEnabled(), "hydrated show");
    await button("Claim control").click();
    await wait(() => button("Start freerun").isEnabled(), "claimed control");
    await button("Start freerun").click();
    await wait(async () => (await clockState()).running, "clock running");
    await button("Stop automation").click();
    await button("Continue with current automation").waitFor();
    assert.equal((await clockState()).triggersEnabled, false);
    assert.equal((await clockState()).running, true, "Stopping automation must not stop the clock");
    const originalStop = saves[0].payload;
    await button("Continue with current automation").click();
    await button("Stop").click();
    await wait(async () => !(await clockState()).running, "transport stopped for navigation");
    await button("Review resume automation").click();
    assert.equal(saves.length, 1, "Review must not resume automation");
    await command("set-triggers-enabled", { enabled: false });
    await page.getByText("Automation changed after review. Review its current state before confirming.", { exact: true }).waitFor();
    assert.equal(await button("Confirm resume").isDisabled(), true);
    for (const width of [320, 768, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      await button("Confirm resume").scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `No overflow at ${width}`);
      for (const name of ["Keep automation paused", "Confirm resume", "Stop automation"]) {
        const bounds = await button(name).boundingBox();
        assert.ok(bounds.height >= 44 && bounds.width >= 44, `${name} touch target at ${width}`);
      }
      await page.screenshot({ path: `/tmp/showpilot-native-timecode-gate-review-${width}.png` });
    }
    await button("Keep automation paused").click();
    assert.equal((await clockState()).triggersEnabled, false);
    await button("Review resume automation").click();
    loseSaveReply = true; mode = "silent";
    await button("Confirm resume").click();
    await wait(() => saves.length === 2, "resume committed with a lost reply");
    assert.equal((await clockState()).triggersEnabled, true);
    // The actual native Stop remains reachable while Resume awaits its reply.
    await button("Stop automation").click();
    await wait(() => saves.length === 3, "new stop while resume pending");
    assert.equal((await clockState()).triggersEnabled, false);
    await button("Change show").click(); mode = "normal";
    await button(`Evening test show · ${date}`).click();
    assert.equal(await button("Retry original resume automation").count(), 0);
    await button("Change show").click();
    await button(`Display test show · ${date}`).click();
    await button("Retry original resume automation").waitFor({ timeout: 20000 });
    await wait(() => button("Claim control").isEnabled(), "return hydrated");
    await button("Claim control").click();
    await wait(() => button("Retry original resume automation").isEnabled(), "same request available");
    mode = "drop-sync";
    await button("Retry original resume automation").click();
    await wait(() => saves.length === 4, "same resume receipt recovered");
    assert.equal(saves[1].payload.requestId, saves[3].payload.requestId);
    assert.equal((await clockState()).triggersEnabled, false, "Old Resume cannot override a newer Stop");
    await page.getByText("The current automation state could not refresh. Retry its refresh.", { exact: true }).first().waitFor({ timeout: 15000 });
    mode = "normal";
    if (await button("Retry live connection").count()) await button("Retry live connection").click();
    await wait(() => button("Retry automation refresh").first().isEnabled(), "refresh reconnected");
    while (await button("Retry automation refresh").count()) {
      await button("Retry automation refresh").first().click();
      await button("Continue with current automation").first().waitFor();
      await button("Continue with current automation").first().click();
    }
    while (await button("Continue with current automation").count()) await button("Continue with current automation").first().click();
    assert.equal(saves.length, 4, "Refresh never repeats automation changes");
    if (await button("Claim control").count()) await button("Claim control").click();
    await command("set-triggers-enabled", { enabled: true });
    await command("edit-automation-gate", originalStop);
    assert.equal((await clockState()).triggersEnabled, true, "An old stop receipt cannot undo a later resume");
    await command("add-event", { id: "pause-automatic", label: "Pause automatic cues", action: "triggers-disable", payload: {}, triggerTimecode: { hours: 0, minutes: 1, seconds: 0, frames: 0 } });
    await command("fire-event", { id: "pause-automatic" });
    await button("Review automatic cues").waitFor();
    await button("Review automatic cues").click();
    await button("Keep automation paused").click();
    assert.equal((await clockState()).automaticCuesEnabled, false);
    await button("Review automatic cues").click();
    await button("Confirm resume").click();
    await button("Continue with current automation").waitFor();
    assert.equal((await clockState()).automaticCuesEnabled, true);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: "pass", realAuth: true, realRelay: true, stopKeepsClock: true, explicitReview: true, staleReviewBlocked: true,
      lostReply: true, stopDuringPendingResume: true, newerStopPreserved: true, navigationRecovery: true, refreshOnly: true, independentAutomaticGate: true, widths: [320, 768, 1440] }));
  } catch (error) {
    console.error(JSON.stringify({ body: await page.locator("body").innerText(), errors, saves }));
    throw error;
  } finally {
    for (const socket of sockets) socket.close();
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}, { secondShow: true });
