// Exercise connection deadlines and stale read-only status in the exported native app. All API traffic is
// sent to disposable local fixtures; no request reaches a production API.
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
await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie }) => {
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
  let mode = "silent";
  const showId = "smoke-show",
    base = `/api/mobile/v1/rundowns/${showId}`;
  page.on("pageerror", (error) => errors.push(error.message));
  // Forward real relay traffic to the disposable Worker with the fixture session.
  // No production socket is opened. Native hydration and broadcasts remain real.
  await page.routeWebSocket("**/*", (route) => {
    const url = new URL(route.url());
    if (!url.pathname.startsWith(`/api/rundown/${orgId}/`) && !url.pathname.startsWith(`/api/chat/`))
      return route.close();
    const isRundown = url.pathname.startsWith(`/api/rundown/${orgId}/`);
    const local = new URL(`${origin}${url.pathname}${url.search}`);
    local.protocol = "ws:";
    const socket = new WebSocket(local, {
      headers: { Cookie: cookie, Origin: origin },
    });
    sockets.add(socket);
    const queue = [];
    route.onMessage((message) =>
      socket.readyState === WebSocket.OPEN
        ? socket.send(message)
        : queue.push(message),
    );
    route.onClose(() => socket.close());
    socket.on("open", () =>
      queue.splice(0).forEach((message) => socket.send(message)),
    );
    socket.on("message", (message) => {
      if (isRundown && mode === "silent") return;
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
  const wait = async (check, label) => {
    const end = Date.now() + 20000;
    while (!(await check())) {
      if (Date.now() > end) throw new Error(`Timed out: ${label}`);
      await new Promise((done) => setTimeout(done, 50));
    }
  };
  async function api(path = "/details", data) {
    const response = await fetch(
      `${origin}${base}${path}?orgId=${orgId}&userId=smoke-operator`,
      {
        method: data ? "POST" : "GET",
        headers: {
          Cookie: cookie,
          Origin: origin,
          "Content-Type": "application/json",
        },
        ...(data ? { body: JSON.stringify(data) } : {}),
      },
    );
    assert.ok(response.ok, await response.clone().text());
    return response.json();
  }
  async function widths(kind, controls) {
    for (const [width, height] of [
      [320, 480],
      [768, 1024],
      [1440, 1000],
    ]) {
      await page.setViewportSize({ width, height });
      for (const name of controls) {
        await button(name).scrollIntoViewIfNeeded();
        const bounds = await button(name).boundingBox();
        assert.ok(
          bounds &&
            bounds.height >= 44 &&
            bounds.x >= 0 &&
            bounds.x + bounds.width <= width + 1,
          `${name} reachable at ${width}`,
        );
      }
      const status = kind === "chat-stale"
        ? page.getByText(/Live show unavailable. Showing last known state/)
        : page.getByText("LAST KNOWN", { exact: true });
      assert.ok(await status.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize) >= 12), "Operational status is at least 12px");
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      );
      await page.screenshot({
        path: `/tmp/showpilot-native-connection-${kind}-${width}.png`,
        fullPage: true,
      });
    }
  }
  async function relay(action, payload = {}) {
    const detail = await api("");
    const path = `/api/rundown/${orgId}/command?showId=${showId}&serviceDate=${detail.show.serviceDate}`;
    const result = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id: crypto.randomUUID(), action, payload }),
    });
    assert.ok(result.ok, await result.clone().text());
    return result.json();
  }
  try {
    await relay("add-item", { id: "welcome", title: "Welcome", type: "segment", duration: 60000,
      notes: "Connection fixture", assignee: "Operator", cue: "", status: "upcoming", sortOrder: 0, hardStop: false });
    await relay("timer-start", { itemId: "welcome" });
    const original = await api("");
    const showCard = () => page.getByRole("button").filter({ has: page.getByText(original.show.name, { exact: true }) });
    await page.goto(`${nativeOrigin}/shows`);
    await showCard().click();
    await page.getByText(/live connection timed out/).first().waitFor({ timeout: 20000 });
    assert.equal(await button("Pause").isEnabled(), false);
    await page.getByText("LAST KNOWN", { exact: true }).waitFor();
    assert.equal(await page.getByText("NOW LIVE", { exact: true }).count(), 0);
    const frozenTimer = await page.getByTestId("rundown-timer-value").innerText();
    await new Promise(done => setTimeout(done, 1100));
    assert.equal(await page.getByTestId("rundown-timer-value").innerText(), frozenTimer);
    await widths("timeout", ["Retry live connection"]);
    mode = "normal";
    await button("Retry live connection").click();
    await wait(() => button("Pause").isEnabled(), "explicit retry hydrates real state");
    await button("Pause").click();
    await wait(async () => (await api("")).timer.playback === "pause", "fresh control works");
    await relay("timer-resume");

    mode = "silent";
    await page.goto(`${nativeOrigin}/live-show`);
    await page.getByText("LAST KNOWN", { exact: true }).waitFor();
    assert.equal(await page.getByText("LIVE", { exact: true }).count(), 0);
    assert.equal(await page.getByText("Synchronized across operators", { exact: true }).count(), 0);
    await page.getByText(/live connection timed out/).first().waitFor({ timeout: 20000 });
    await widths("live-stale", ["Retry live connection"]);
    mode = "normal";
    await button("Retry live connection").click();
    await page.getByText("LIVE", { exact: true }).waitFor();
    await page.getByText("Synchronized across operators", { exact: true }).waitFor();

    mode = "silent";
    await page.goto(`${nativeOrigin}/chat`);
    await page.getByText(/Live show unavailable. Showing last known state/).waitFor();
    assert.equal(await page.getByText("LIVE NOW", { exact: true }).count(), 0);
    await widths("chat-stale", ["Retry live connection"]);
    mode = "normal";
    await button("Retry live connection").click();
    await page.getByText("LIVE NOW", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({result:"pass", realAuth:true, realRelay:true,
      handshakeDeadline:true, controlsBlockedUntilHydration:true, explicitRetry:true,
      liveShowCachedStateHonest:true, chatCachedStateHonest:true, freshControlWorks:true,
      viewports:[320,768,1440], errors}));
  } catch (error) {
    console.error(
      JSON.stringify({
        body: await page.locator("body").innerText(),
        errors,
      }),
    );
    throw error;
  } finally {
    for (const socket of sockets) socket.close();
    await browser.close();
    await new Promise((done) => server.close(done));
  }
});
