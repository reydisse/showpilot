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
  let mode = "silent", stallBootstrap = true, stallShowList = true;
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
    route.onClose(() => socket.close());
    socket.on("open", () =>
      queue.splice(0).forEach((message) => socket.send(message)),
    );
    socket.on("message", (message) => {
      if (mode === "silent") return;
      route.send(message.toString());
    });
    socket.on("error", (error) => errors.push(error.message));
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
    if ((url.pathname === "/api/mobile/v1/bootstrap" && stallBootstrap) || (url.pathname === "/api/mobile/v1/timecode/shows" && stallShowList)) {
      await new Promise(resolve => setTimeout(resolve, 12_500));
    }
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
  const login = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "second@display-smoke.invalid", password: operatorPassword }),
  });
  assert.equal(login.status, 200, await login.clone().text());
  const secondCookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  await login.arrayBuffer();
  const headers = { Cookie: secondCookie, Origin: origin, "Content-Type": "application/json" };
  async function read(show = showId, part = "state") {
    const response = await fetch(`${origin}/api/timecode/${orgId}/${part}?showId=${show}`, { headers });
    assert.ok(response.ok, await response.clone().text()); return response.json();
  }
  async function command(show, action, payload) {
    const response = await fetch(`${origin}/api/timecode/${orgId}/command?showId=${show}`, {
      method: "POST", headers, body: JSON.stringify({ action, payload }),
    });
    assert.ok(response.ok, await response.clone().text()); return response.json();
  }
  async function claim(show) {
    const socket = new WebSocket(`${origin.replace("http:", "ws:")}/api/timecode/${orgId}/ws?showId=${show}`, { headers });
    sockets.add(socket);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Fixture control was not granted")), 8000);
      socket.on("message", bytes => {
        const message = JSON.parse(String(bytes));
        if (message.type === "hydrate") socket.send(JSON.stringify({ type: "command", action: "claim-control" }));
        if (message.type === "control-status" && message.control === "yours") { clearTimeout(timeout); resolve(); }
      });
      socket.on("error", reject);
    });
    return socket;
  }
  async function widths(kind, controls) {
    for (const [width, height] of [[320, 480], [768, 1024], [1440, 1000]]) {
      await page.setViewportSize({ width, height });
      for (const name of controls) {
        const control = button(name);
        await control.scrollIntoViewIfNeeded();
        const box = await control.boundingBox();
        assert.ok(box && box.height >= 44 && box.x >= 0 && box.x + box.width <= width + 1, `${name} reachable at ${width}`);
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `No horizontal overflow at ${width}`);
      if (kind === "failed") {
        await page.getByText("Failed", { exact: true }).scrollIntoViewIfNeeded();
      }
      await page.screenshot({ path: `/tmp/showpilot-native-timecode-${kind}-${width}.png`, fullPage: true });
    }
  }
  try {
    const owner = await claim(showId);
    const evening = await claim("smoke-second-show");
    await command(showId, "add-event", {
      id: "missing-item", label: "Missing rundown item", action: "rundown-start-item",
      triggerTimecode: { hours: 1, minutes: 0, seconds: 0, frames: 0 }, payload: { itemId: "missing-item" },
    });
    await command(showId, "add-event", {
      id: "disabled", label: "Disabled cue", action: "lyrics-clear", enabled: false,
      triggerTimecode: { hours: 1, minutes: 1, seconds: 0, frames: 0 }, payload: {},
    });
    await command("smoke-second-show", "add-event", {
      id: "evening", label: "Evening only cue", action: "lyrics-clear",
      triggerTimecode: { hours: 1, minutes: 0, seconds: 0, frames: 0 }, payload: {},
    });
    await page.goto(`${nativeOrigin}/timecode`);
    await button("Retry loading shows").waitFor({ timeout: 16000 });
    await page.getByText(/request timed out/).waitFor();
    stallBootstrap = false;
    await button("Retry loading shows").click();
    await page.getByText("Choose a show", { exact: true }).waitFor();
    await button("Retry loading shows").waitFor({ timeout: 16000 });
    await page.getByText(/request timed out/).waitFor();
    stallShowList = false;
    await button("Retry loading shows").click();
    await button(`Display test show · ${date}`).click();
    await page.getByText(/timecode connection timed out/).waitFor({ timeout: 16000 });
    assert.equal(await button("Start freerun").isEnabled(), false);
    await widths("timeout", ["Retry live connection"]);
    mode = "normal";
    await button("Retry live connection").click();
    await page.getByText(/Another operator controls this show/).waitFor();
    assert.equal(await button("Claim control").isEnabled(), false);
    assert.equal(await button("Start freerun").isEnabled(), false);
    await command(showId, "fire-event", { id: "missing-item" });
    await wait(async () => (await read(showId, "events")).find(item => item.id === "missing-item").executionStatus === "failed", "real failed cue");
    await page.getByText("Failed", { exact: true }).waitFor();
    await page.getByText("Disabled", { exact: true }).waitFor();
    assert.equal(await page.getByText("Fired", { exact: true }).count(), 0);
    assert.equal(await page.getByText("Evening only cue", { exact: true }).count(), 0);
    await widths("failed", ["Claim control", "Start freerun"]);
    owner.close();
    await wait(() => button("Claim control").isEnabled(), "ownership released");
    await button("Claim control").click();
    await wait(() => button("Start freerun").isEnabled(), "claim acknowledged");
    await button("Start freerun").click();
    await wait(async () => (await read()).running && (await read()).totalFrames > 2, "real native clock feed");
    assert.equal(await button("Change show").isEnabled(), false);
    await button("Stop").click();
    await wait(async () => !(await read()).running, "real Stop");
    await wait(() => button("Change show").isEnabled(), "Stop acknowledged");
    const starts = commands.filter(item => item.action === "start").length;
    mode = "silent";
    await page.getByText(/connection stopped responding/).waitFor({ timeout: 35000 });
    assert.equal(await button("Start freerun").isEnabled(), false);
    const lastKnown = await page.getByLabel(/^Timecode \d/).innerText();
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(await page.getByLabel(/^Timecode \d/).innerText(), lastKnown);
    mode = "normal";
    await button("Retry live connection").click();
    await wait(() => button("Claim control").isEnabled(), "fresh connection remains a viewer");
    assert.equal(commands.filter(item => item.action === "start").length, starts);
    assert.equal((await read()).running, false);
    await button("Change show").click();
    await button(`Evening test show · ${date}`).click();
    await page.getByText("Evening only cue", { exact: true }).waitFor();
    assert.equal(await page.getByText("Missing rundown item", { exact: true }).count(), 0);
    assert.equal(await button("Claim control").isEnabled(), false);
    await widths("evening", ["Change show", "Claim control"]);
    assert.ok(requests.length > 4);
    assert.ok(requests.every(url => [showId, "smoke-second-show"].includes(url.searchParams.get("showId"))), "Every HTTP and socket request pins an explicit show");
    assert.deepEqual(errors, []);
    evening.close();
    console.log(JSON.stringify({ result: "pass", realAuth: true, realRelay: true, scopedHttpAndWebSocket: true,
      competingOperator: true, failedCueHonesty: true, disabledCue: true, nativeClock: true,
      bootstrapDeadline: true, showListDeadline: true, connectionDeadline: true, idleDeadline: true, explicitRetry: true, noAutomaticRestart: true,
      isolatedShowSelection: true, viewports: [320, 768, 1440], errors }));
  } catch (error) {
    console.error(JSON.stringify({ body: await page.locator("body").innerText(), errors, commands: commands.filter(item => item.action !== "feed-tc") }));
    throw error;
  } finally {
    for (const socket of sockets) socket.close();
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}, { secondShow: true, secondOperator: true });
