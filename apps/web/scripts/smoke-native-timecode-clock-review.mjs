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
  let mode = "normal", loseSaveReply = true;
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
    if (url.pathname.endsWith("/command") && body && JSON.parse(body).action === "edit-clock") {
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
    await wait(() => button("Set relay time").isEnabled(), "claimed control");
    await page.getByLabel("Set timecode", { exact: true }).fill("00:00:10:00");
    await button("Set relay time").click();
    await button("Confirm clock change").waitFor();
    assert.equal(saves.length, 0, "Opening review must not change the clock");
    await command("set-timecode", { timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 } });
    await page.getByText("The show, clock position or format changed. Review the current clock before confirming.", { exact: true }).waitFor();
    assert.equal(await button("Confirm clock change").isDisabled(), true);
    for (const width of [320, 768, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `No overflow at ${width}`);
      const bounds = await button("Keep current clock").boundingBox();
      assert.ok(bounds.height >= 44 && bounds.width >= 44);
      await page.screenshot({ path: `/tmp/showpilot-native-timecode-clock-review-${width}.png` });
    }
    await button("Review current clock").click();
    await wait(() => button("Confirm clock change").isEnabled(), "fresh review");
    mode = "silent";
    await button("Confirm clock change").click();
    await wait(() => saves.length === 1, "reviewed seek committed");
    assert.equal((await clockState()).totalFrames, 300);
    await command("set-timecode", { timecode: { hours: 0, minutes: 0, seconds: 20, frames: 0 } });
    await button("Change show").click();
    mode = "normal";
    await button(`Evening test show · ${date}`).click();
    assert.equal(await page.getByLabel("Set timecode", { exact: true }).inputValue(), "00:00:00:00");
    await button("Change show").click();
    await button(`Display test show · ${date}`).click();
    await button("Retry original clock change").waitFor({ timeout: 20000 });
    assert.equal(await page.getByLabel("Set timecode", { exact: true }).inputValue(), "00:00:10:00");
    await wait(() => button("Claim control").isEnabled(), "return hydrated");
    await button("Claim control").click();
    await wait(() => button("Retry original clock change").isEnabled(), "receipt check available");
    mode = "drop-sync";
    await button("Retry original clock change").click();
    await wait(() => saves.length === 2, "same request checked");
    assert.equal(saves[0].payload.requestId, saves[1].payload.requestId);
    assert.equal((await clockState()).totalFrames, 600, "Lost-reply recovery must preserve a later clock change");
    await button("Retry clock refresh").waitFor({ timeout: 15000 });
    mode = "normal";
    if (await button("Retry live connection").count()) await button("Retry live connection").click();
    await wait(() => button("Retry clock refresh").isEnabled(), "clock refresh reconnected");
    await button("Retry clock refresh").click();
    await button("Continue with current clock").waitFor();
    assert.equal(saves.length, 2, "Refresh does not replay the clock change");
    await button("Continue with current clock").click();
    if (await button("Claim control").count()) await button("Claim control").click();
    await wait(() => button("25").isEnabled(), "ready for format review");
    await button("25").click();
    await button("Confirm reformat").waitFor();
    await button("Keep current clock").click();
    assert.equal((await clockState()).format.frameRate, 30);
    await button("25").click();
    await button("Confirm reformat").click();
    await button("Continue with current clock").waitFor();
    assert.equal((await clockState()).format.frameRate, 25);
    assert.equal((await clockState()).totalFrames, 500);
    assert.equal((await clockState()).triggersEnabled, false);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: "pass", realAuth: true, realRelay: true, explicitReview: true, staleReviewBlocked: true,
      lostReply: true, laterClockPreserved: true, navigationRecovery: true, refreshOnly: true, reformat: true, widths: [320, 768, 1440] }));
  } catch (error) {
    console.error(JSON.stringify({ body: await page.locator("body").innerText(), errors, saves }));
    throw error;
  } finally {
    for (const socket of sockets) socket.close();
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}, { secondShow: true });
