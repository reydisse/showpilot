// Render the exported Expo web app with the native transport expiry and recovery. All API traffic is
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
  let mode = "normal";
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
    route.onMessage((message) => {
      const value = JSON.parse(message);
      const transport =
        value.type === "command" &&
        value.action?.startsWith("timer-") &&
        value.action !== "timer-mode";
      if (transport) {
        calls.push(value);
        if (mode === "before") {
          held.push(value);
          return;
        }
      }
      if (socket.readyState === WebSocket.OPEN) socket.send(message);
      else queue.push(message);
    });
    route.onClose(() => socket.close());
    socket.on("open", () =>
      queue.splice(0).forEach((message) => socket.send(message)),
    );
    socket.on("message", (message) => {
      const value = JSON.parse(message.toString());
      if (
        value.type === "command-result" &&
        calls.some((call) => call.id === value.id)
      ) {
        deliveries.push(value);
        if (mode === "after") return;
      }
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
        assert.ok(
          await button(name).evaluate(
            (element) => element.scrollWidth <= element.clientWidth + 1,
          ),
          `${name} text fits at ${width}`,
        );
      }
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      );
      await page.screenshot({
        path: `/tmp/showpilot-native-transport-${kind}-${width}.png`,
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
        notes: "",
        assignee: "",
        cue: "",
        status: "upcoming",
        sortOrder: id === "welcome" ? 0 : 1,
        hardStop: false,
      });
    const originalName = (await api()).snapshot.name;
    await page.goto(`${nativeOrigin}/shows`);
    await page
      .getByRole("button")
      .filter({ has: page.getByText(originalName, { exact: true }) })
      .click();
    await wait(() => button("Start").isEnabled(), "hydrated transport");
    await button("Start").click();
    await wait(() => button("Pause").isEnabled(), "start acknowledged");
    assert.equal(calls[0].action, "timer-start");
    assert.ok(Number.isFinite(calls[0].expiresAt));
    assert.equal((await api("")).timer.currentItemId, "welcome");
    mode = "before";
    await button("Next").click();
    await wait(() => held.length === 1, "Next intercepted before delivery");
    assert.equal(await button("Next").isEnabled(), false);
    const missed = held[0];
    assert.ok(
      missed.expiresAt <= Date.now() + 5000 && missed.expiresAt > Date.now(),
    );
    await page
      .getByText(/transport command expired and will not be retried/)
      .waitFor({ timeout: 15000 });
    await wait(
      () => button("Next").isEnabled(),
      "reconnected after missed acknowledgement",
    );
    assert.equal(
      calls.filter((call) => call.action === "timer-next").length,
      1,
    );
    assert.equal((await api("")).timer.currentItemId, "welcome");
    const detail = await api("");
    const late = await fetch(
      `${origin}/api/rundown/${orgId}/command?showId=${showId}&serviceDate=${detail.show.serviceDate}`,
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(missed),
      },
    );
    assert.equal(late.status, 409);
    assert.equal((await late.json()).reason, "expired");
    await relay("stage-message", {
      message: "New snapshot while an expired-action notice is visible",
    });
    await page
      .getByText(/transport command expired and will not be retried/)
      .waitFor();
    await widths("expired", [
      "Dismiss rundown notice",
      "Pause",
      "Next",
      "−30 sec",
      "+30 sec",
      "Stop",
      "Reset",
      "Subtract",
      "Add",
    ]);
    await button("Dismiss rundown notice").click();
    assert.equal(
      await page
        .getByText(/transport command expired and will not be retried/)
        .count(),
      0,
    );
    mode = "normal";
    await button("Next").click();
    await wait(
      async () => (await api("")).timer.currentItemId === "next",
      "fresh Next applies",
    );
    await wait(() => button("Pause").isEnabled(), "Next acknowledged");
    mode = "after";
    await button("Pause").click();
    await wait(
      async () => (await api("")).timer.playback === "pause",
      "pause applied with lost acknowledgement",
    );
    await page.getByText(/It may have completed/).waitFor({ timeout: 15000 });
    await wait(
      () => button("Resume").isEnabled(),
      "hydration confirms paused state",
    );
    assert.equal(
      calls.filter((call) => call.action === "timer-pause").length,
      1,
    );
    await widths("uncertain", [
      "Dismiss rundown notice",
      "Resume",
      "Next",
      "−30 sec",
      "+30 sec",
      "Stop",
      "Reset",
      "Subtract",
      "Add",
    ]);
    assert.equal((await api("")).timer.playback, "pause");
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        result: "pass",
        realAuth: true,
        realRelay: true,
        serverDeadline: true,
        controlsDisabledWhileUnconfirmed: true,
        expiredNotReplayed: true,
        serverRejectsLateDelivery: true,
        noticeSurvivesSnapshot: true,
        noticeDismissible: true,
        freshCommandWorks: true,
        lostAppliedReplyHonest: true,
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
    for (const socket of sockets) socket.close();
    await browser.close();
    await new Promise((done) => server.close(done));
  }
});
