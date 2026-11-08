// Render the exported Expo web app with the native rundown details editor. All API traffic is
// sent to disposable local fixtures; no request reaches a production API.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
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
await withLocalSmokeFixture(
  async ({ origin, orgId, operatorCookie, queryFixture }) => {
    const activated = await fetch(
      `${origin}/api/auth/organization/set-active`,
      {
        method: "POST",
        headers: {
          Cookie: operatorCookie,
          Origin: origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ organizationId: orgId }),
      },
    );
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
      failDetails = true,
      failShow = false,
      holdInitialShow = true;
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
      if (
        request.method() === "GET" &&
        url.pathname === base &&
        holdInitialShow
      ) {
        holdInitialShow = false;
        await new Promise((done) => held.push(done));
      }
      const headers = {
        "content-type": "application/json",
        "access-control-allow-origin": nativeOrigin,
        "access-control-allow-credentials": "true",
      };
      if (
        request.method() === "GET" &&
        ((failDetails && url.pathname === `${base}/details`) ||
          (failShow && url.pathname === base))
      )
        return route.fulfill({
          status: 503,
          headers,
          body: JSON.stringify({ error: "Fixture show read failed" }),
        });
      const command = url.pathname === `${base}/details/command`,
        review = url.pathname === `${base}/details/review`,
        delivery = mode;
      if (command || review) calls.push({ review, command: JSON.parse(body) });
      if (command && delivery === "before")
        await new Promise((done) => held.push(done));
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
      if (command || review)
        deliveries.push({
          review,
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
    const field = (name) => page.getByRole("textbox", { name, exact: true });
    const title = () => field("Service title");
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
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    }
    async function laterEdit() {
      const current = await api();
      return api("/details/command", {
        orgId,
        userId: "smoke-operator",
        showId,
        requestId: crypto.randomUUID(),
        serviceDate: current.snapshot.serviceDate,
        expectedRevision: current.revision,
        expectedUpdatedAt: current.snapshot.updatedAt,
        name: "Another operator",
        location: "Other venue",
        startTime: "",
        callTime: "",
        timeZone: current.timeZone,
      });
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
          path: `/tmp/showpilot-native-rundown-${kind}-${width}.png`,
          fullPage: true,
        });
      }
    }
    try {
      const originalName = (await api()).snapshot.name;
      const showCard = () =>
        page
          .getByRole("button")
          .filter({ has: page.getByText(originalName, { exact: true }) });
      await page.goto(`${nativeOrigin}/shows`);
      await showCard().click();
      await button("Try again").waitFor({ timeout: 20000 });
      held.splice(0).forEach((done) => done());
      await button("Try again").click();
      await wait(
        () => button("Edit show details").isEnabled(),
        "real relay hydration",
      );
      await widths("header", ["Edit show details", "Share stage display link"]);
      await button("Edit show details").click();
      await button("Retry loading details").waitFor();
      assert.equal(calls.length, 0);
      failDetails = false;
      await button("Retry loading details").click();
      await title().fill("Retained rundown title");
      await field("Venue or location").fill("Retained venue");
      await button("Close show details").click();
      await button("Back to shows").click();
      await showCard().click();
      await button("Resume rundown details").click();
      assert.equal(await title().inputValue(), "Retained rundown title");
      await button("Discard details draft…").click();
      await button("Keep draft").click();
      mode = "after";
      failShow = true;
      await button("Save details").click();
      await wait(() => held.length === 1, "saved details with lost reply");
      assert.equal((await api()).snapshot.name, "Retained rundown title");
      await button("Close show details").click();
      await button("Resume rundown details").click();
      await button("Retry original details save").waitFor({ timeout: 20000 });
      assert.equal(await title().isEditable(), false);
      await widths("unknown", [
        "Retry original details save",
        "Review original details save",
        "Close show details",
      ]);
      mode = "normal";
      await button("Retry original details save").click();
      await button("Refresh show only").waitFor();
      assert.deepEqual(calls[1], calls[0]);
      await widths("refresh", ["Refresh show only"]);
      failShow = false;
      await button("Refresh show only").click();
      await button("Finish details change").waitFor();
      assert.equal(calls.length, 2);
      held.splice(0).forEach((done) => done());
      await button("Finish details change").click();

      await button("Edit show details").click();
      await title().fill("Cancelled draft");
      mode = "before";
      await button("Save details").click();
      await wait(() => held.length === 1, "save held before delivery");
      await button("Review original details save").waitFor({ timeout: 20000 });
      mode = "normal";
      await button("Review original details save").click();
      await button("Edit cancelled details").waitFor();
      assert.equal(deliveries.at(-1).result.outcome, "cancelled");
      const delivered = deliveries.length;
      held.splice(0).forEach((done) => done());
      await wait(() => deliveries.length > delivered, "late cancelled save");
      assert.equal(deliveries.at(-1).result.outcome, "cancelled");
      assert.equal((await api()).snapshot.name, "Retained rundown title");
      await button("Edit cancelled details").click();
      await title().fill("Reviewed second title");
      await button("Save details").click();
      await button("Finish details change").waitFor();
      assert.notEqual(
        calls.at(-1).command.requestId,
        calls.at(-2).command.requestId,
      );
      await button("Finish details change").click();

      await button("Edit show details").click();
      await title().fill("My conflicting title");
      await laterEdit();
      await button("Save details").click();
      await button("Load current details…").waitFor();
      assert.equal(deliveries.at(-1).result.outcome, "conflict");
      assert.equal(await title().inputValue(), "My conflicting title");
      await widths("conflict", [
        "Load current details…",
        "Discard details draft…",
      ]);
      await button("Load current details…").click();
      await button("Keep draft").click();
      assert.equal(await title().inputValue(), "My conflicting title");
      failDetails = true;
      await button("Load current details…").click();
      await button("Replace with current details").click();
      await page
        .getByText("Fixture show read failed", { exact: true })
        .waitFor();
      assert.equal(await title().inputValue(), "My conflicting title");
      failDetails = false;
      await button("Load current details…").click();
      await button("Replace with current details").click();
      await wait(
        async () => (await title().inputValue()) === "Another operator",
        "explicit current revision adoption",
      );
      await title().fill("Final reviewed title");
      await button("Save details").click();
      await button("Finish details change").waitFor();
      assert.equal((await api()).snapshot.name, "Final reviewed title");
      assert.notEqual(
        calls.at(-1).command.requestId,
        calls.at(-2).command.requestId,
      );
      assert.ok(
        calls.at(-1).command.expectedRevision >
          calls.at(-2).command.expectedRevision,
      );
      await button("Finish details change").click();
      await page.getByText("Final reviewed title", { exact: true }).waitFor();
      await button("Edit show details").click();
      await title().fill("Discard me");
      await button("Discard details draft…").click();
      await button("Discard draft").click();
      await button("Edit show details").click();
      await wait(
        async () => (await title().inputValue()) === "Final reviewed title",
        "fresh form after discard",
      );
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          result: "pass",
          realRelay: true,
          initialReadRetry: true,
          navigationRetainsDraft: true,
          exactRetry: true,
          refreshFailureKeepsEditor: true,
          cancellationBeforeDelivery: true,
          revisionConflictKeepsDraft: true,
          explicitAdoption: true,
          failedReadKeepsDraft: true,
          confirmedDiscard: true,
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
  },
);
