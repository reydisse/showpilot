// Render the exported Expo web app with the native timing reset controls. All API traffic is
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
  const errors = [],
    calls = [],
    held = [],
    deliveries = [],
    sockets = new Set();
  let mode = "normal",
    failShow = false;
  const showId = "smoke-show",
    base = `/api/mobile/v1/rundowns/${showId}`;
  page.on("pageerror", (error) => errors.push(error.message));
  // Forward real relay traffic to the disposable Worker with the fixture session.
  // No production socket is opened. Native hydration and broadcasts remain real.
  await page.routeWebSocket("**/*", (route) => {
    const url = new URL(route.url());
    if (!url.pathname.startsWith(`/api/rundown/${orgId}/`))
      return route.close();
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
    socket.on("message", (message) => route.send(message.toString()));
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
    if (request.method() === "GET" && failShow && url.pathname === base)
      return route.fulfill({
        status: 503,
        headers,
        body: JSON.stringify({ error: "Fixture rundown refresh failed" }),
      });
    const command = url.pathname === `${base}/reset`,
      delivery = mode;
    if (command) calls.push(JSON.parse(body));
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
    if (command)
      deliveries.push({
        status: result.status,
        result: JSON.parse(bytes),
      });
    if (command && delivery === "after")
      await new Promise((done) => held.push(done));
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
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      );
      await page.screenshot({
        path: `/tmp/showpilot-native-reset-${kind}-${width}.png`,
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
    for (const id of ["welcome", "next"])
      await relay("add-item", {
        id,
        title: id === "welcome" ? "Welcome" : "Next item",
        type: "segment",
        duration: 60000,
        notes: "Keep these notes",
        assignee: "Operator",
        cue: "",
        status: "upcoming",
        sortOrder: id === "welcome" ? 0 : 1,
        hardStop: false,
      });
    await relay("timer-start", { itemId: "welcome" });
    await relay("timer-next");
    await relay("timer-pause");
    const original = await api("");
    const showCard = () =>
      page
        .getByRole("button")
        .filter({ has: page.getByText(original.show.name, { exact: true }) });
    await page.goto(`${nativeOrigin}/shows`);
    await showCard().click();
    await wait(() => button("Reset").isEnabled(), "hydrated paused show");
    await button("Reset").click();
    await button("Confirm timing reset").waitFor({ timeout: 3000 });
    await widths("confirm", ["Keep timing", "Confirm timing reset"]);
    assert.equal(calls.length, 0);
    assert.deepEqual((await api("")).items, original.items);
    assert.equal((await api("")).timer.playback, "pause");
    await button("Keep timing").click();
    assert.equal(calls.length, 0);
    await button("Reset").click();
    await relay("timer-resume");
    await page
      .getByText("Pause or stop the show before resetting timing.", {
        exact: true,
      })
      .waitFor();
    assert.equal(await button("Confirm timing reset").isEnabled(), false);
    await relay("timer-pause");
    await button("Review current timing").click();
    mode = "after";
    failShow = true;
    await button("Confirm timing reset").click();
    await wait(() => held.length === 1, "reset committed with reply held");
    assert.equal(calls[0].action, "reset");
    const request = calls[0];
    const reset = await api("");
    assert.equal(reset.timer.playback, "stop");
    assert.equal(reset.timer.currentItemId, null);
    assert.ok(
      reset.items.every(
        (item) =>
          item.status === "upcoming" &&
          item.actualStart === null &&
          item.actualEnd === null,
      ),
    );
    assert.deepEqual(
      reset.items.map(({ id, title, notes, assignee }) => ({
        id,
        title,
        notes,
        assignee,
      })),
      original.items.map(({ id, title, notes, assignee }) => ({
        id,
        title,
        notes,
        assignee,
      })),
    );
    await relay("timer-start", { itemId: "next" });
    await relay("timer-pause");
    failShow = false;
    await button("Back to shows").click();
    await showCard().click();
    await button("Retry original rundown action").waitFor({ timeout: 20000 });
    await widths("unknown", ["Retry original rundown action"]);
    mode = "normal";
    failShow = true;
    await button("Retry original rundown action").click();
    await page
      .getByText("Fixture rundown refresh failed", { exact: false })
      .first()
      .waitFor();
    assert.deepEqual(calls[1], request);
    assert.equal((await api("")).timer.playback, "pause");
    assert.equal((await api("")).timer.currentItemId, "next");
    await widths("refresh", ["Refresh rundown result"]);
    failShow = false;
    await button("Refresh rundown result").click();
    await button("Dismiss rundown result").waitFor();
    assert.equal(calls.length, 2);
    held.splice(0).forEach((done) => done());
    assert.equal((await api("")).timer.currentItemId, "next");
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        result: "pass",
        realAuth: true,
        realRelay: true,
        visibleConfirmation: true,
        keepTiming: true,
        playingBlocked: true,
        revisionReview: true,
        itemsPreserved: true,
        timingReset: true,
        uncertainDeadline: true,
        navigationRetained: true,
        exactRetryPreservesLaterRun: true,
        refreshOnly: true,
        viewports: [320, 768, 1440],
        errors,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        body: await page.locator("body").innerText(),
        errors,
        calls,
        deliveries,
      }),
    );
    throw error;
  } finally {
    held.splice(0).forEach((done) => done());
    for (const socket of sockets) socket.close();
    await browser.close();
    await new Promise((done) => server.close(done));
  }
});
