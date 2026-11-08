// Render the exported Expo web app with the native rundown removal controls. All API traffic is
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
    const command = url.pathname === `${base}/change`,
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
        path: `/tmp/showpilot-native-rundown-change-${kind}-${width}.png`,
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
        title:
          id === "welcome" ? "Welcome and opening announcements" : "Next item",
        type: "segment",
        duration: 60000,
        notes: "",
        assignee: "",
        cue: "",
        status: "upcoming",
        sortOrder: id === "welcome" ? 0 : 1,
        hardStop: false,
      });
    const scope = {
      orgId,
      userId: "smoke-operator",
      showId,
      serviceDate: (await api("")).show.serviceDate,
      requestId: crypto.randomUUID(),
      expectedRevision: 0,
      action: "remove-item",
      itemId: "welcome",
    };
    for (const [change, status] of [
      [{ userId: "another-account" }, 403],
      [{ showId: "another-show" }, 403],
      [{ expectedRevision: undefined }, 400],
    ]) {
      const rejected = await fetch(`${origin}${base}/change?orgId=${orgId}`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...scope, ...change }),
      });
      assert.equal(rejected.status, status, await rejected.clone().text());
      await rejected.arrayBuffer();
      assert.equal((await api("")).items.length, 2);
    }
    await relay("timer-start", { itemId: "welcome" });
    const originalName = (await api()).snapshot.name;
    const showCard = () =>
      page
        .getByRole("button")
        .filter({ has: page.getByText(originalName, { exact: true }) });
    const itemTitle = "Welcome and opening announcements";
    await page.goto(`${nativeOrigin}/shows`);
    await showCard().click();
    await wait(
      () => button("Edit show details").isEnabled(),
      "real relay hydration",
    );
    await button(`Edit ${itemTitle}`).click();
    await button("Delete rundown item").click();
    await page.getByText(/Removing it stops its timer/).waitFor();
    await widths("confirm", [
      "Keep item",
      "Confirm item removal",
      "Close rundown item editor",
    ]);
    assert.equal(calls.length, 0);
    await button("Keep item").click();
    assert.equal(calls.length, 0);
    await button("Delete rundown item").click();
    await button("Confirm item removal").click();
    await button(`Undo removal of ${itemTitle}`).waitFor();
    const removed = await api("");
    assert.deepEqual(
      removed.items.map((i) => i.id),
      ["next"],
    );
    assert.equal(removed.timer.playback, "stop");
    await button(`Undo removal of ${itemTitle}`).click();
    await button("Dismiss rundown result").waitFor();
    assert.equal(calls[1].action, "restore-item");
    assert.notEqual(calls[0].requestId, calls[1].requestId);
    const restored = await api("");
    assert.deepEqual(
      restored.items.map((i) => i.id),
      ["welcome", "next"],
    );
    assert.equal(restored.timer.playback, "stop");
    await button("Dismiss rundown result").click();
    await button(`Edit ${itemTitle}`).click();
    await button("Delete rundown item").click();
    await relay("timer-start", { itemId: "next" });
    await button("Review current item").waitFor();
    assert.equal(await button("Confirm item removal").isEnabled(), false);
    await button("Review current item").click();
    mode = "after";
    failShow = true;
    await button("Confirm item removal").click();
    await wait(() => held.length === 1, "committed removal with held reply");
    const original = calls[2];
    assert.equal((await api("")).timer.currentItemId, "next");
    await relay("restore-item", { id: "welcome" });
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
    assert.deepEqual(calls[3], original);
    await widths("refresh", ["Refresh rundown result"]);
    failShow = false;
    await button("Refresh rundown result").click();
    await button("Dismiss rundown result").waitFor();
    assert.equal(calls.length, 4);
    assert.equal((await api("")).items.length, 2);
    held.splice(0).forEach((done) => done());
    await button("Dismiss rundown result").click();
    await button("Clear rundown").click();
    await widths("clear", ["Keep rundown", "Confirm clear rundown"]);
    assert.equal(calls.length, 4);
    await button("Keep rundown").click();
    assert.equal(calls.length, 4);
    await button("Clear rundown").click();
    await relay("stage-message", {
      message: "Another operator changed the show",
    });
    await button("Review current rundown").waitFor();
    assert.equal(await button("Confirm clear rundown").isEnabled(), false);
    await button("Review current rundown").click();
    await button("Confirm clear rundown").click();
    await button("Dismiss rundown result").waitFor();
    const cleared = await api("");
    assert.deepEqual(cleared.items, []);
    assert.equal(cleared.timer.playback, "stop");
    assert.equal(calls[4].action, "clear-all");
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        result: "pass",
        realAuth: true,
        realRelay: true,
        routeIdentity: true,
        visibleConfirmation: true,
        keepWithoutDelete: true,
        activeItemAtomic: true,
        undo: true,
        revisionReview: true,
        uncertainDeadline: true,
        navigationRetained: true,
        exactRetry: true,
        refreshOnly: true,
        restoredItemPreserved: true,
        clearConfirmed: true,
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
