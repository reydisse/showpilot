// Render the exported Expo web app with the native stage-message editor. All API traffic is
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
      sockets = new Set(),
      httpRequests = new Set();
    let closing = false;
    await page
      .context()
      .route("**/*", (route) =>
        new URL(route.request().url()).origin === nativeOrigin
          ? route.continue()
          : route.abort(),
      );
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
      let cancelled = false;
      route.onClose(() => {
        cancelled = socket.readyState === WebSocket.CONNECTING;
        socket.close();
      });
      socket.on("open", () =>
        queue.splice(0).forEach((message) => socket.send(message)),
      );
      socket.on("message", (message) => route.send(message.toString()));
      socket.on("error", (error) => {
        if (
          !cancelled ||
          error.message !==
            "WebSocket was closed before the connection was established"
        )
          errors.push(error.message);
      });
      socket.on("close", () => {
        sockets.delete(socket);
        void route.close().catch(() => {});
      });
    });
    async function forward(route) {
      const request = route.request(),
        url = new URL(request.url()),
        body = request.postData();
      if (!url.pathname.startsWith("/api/")) {
        try {
          return await (url.origin === nativeOrigin
            ? route.continue()
            : route.abort());
        } catch (error) {
          if (!closing) throw error;
          return;
        }
      }
      const headers = {
        "content-type": "application/json",
        "access-control-allow-origin": nativeOrigin,
        "access-control-allow-credentials": "true",
      };
      if (failShow && request.method() === "GET" && url.pathname === base)
        return route.fulfill({
          status: 503,
          headers,
          body: JSON.stringify({ error: "Fixture rundown read failed" }),
        });
      const command = url.pathname === `${base}/stage`,
        delivery = mode;
      if (command) calls.push(JSON.parse(body));
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
      if (command)
        deliveries.push({ status: result.status, result: JSON.parse(bytes) });
      if (command && delivery === "after")
        await new Promise((done) => held.push(done));
      await route
        .fulfill({ status: result.status, headers, body: bytes })
        .catch(() => {});
    }
    await page.route("**/*", (route) => {
      const task = forward(route);
      httpRequests.add(task);
      task.then(
        () => httpRequests.delete(task),
        () => httpRequests.delete(task),
      );
      return task;
    });
    const button = (name) => page.getByRole("button", { name, exact: true });
    const field = (name) => page.getByRole("textbox", { name, exact: true });
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
    async function rawStage(message) {
      const current = await api();
      const result = await fetch(
        `${origin}/api/rundown/${orgId}/command?showId=${showId}&serviceDate=${current.snapshot.serviceDate}`,
        {
          method: "POST",
          headers: {
            Cookie: cookie,
            Origin: origin,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            id: crypto.randomUUID(),
            expectedRevision: current.revision,
            action: "stage-message",
            payload: { message },
          }),
        },
      );
      assert.equal(result.status, 200, await result.clone().text());
      await result.arrayBuffer();
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
          await button(name).click({ trial: true });
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
          path: `/tmp/showpilot-native-stage-${kind}-${width}.png`,
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
      const liveMessage = async () =>
        (
          await queryFixture(
            "SELECT value FROM app_setting WHERE orgId='display-smoke' AND key='rundown-message:smoke-show'",
          )
        )[0]?.value ?? "";
      await page.goto(`${nativeOrigin}/shows`);
      await showCard().click();
      await wait(
        () => field("Stage message").isEditable(),
        "stage message hydration",
      );
      await field("Stage message").fill("My unsent stage message");
      await page
        .getByRole("checkbox", { name: "Priority stage message", exact: true })
        .click();
      assert.equal(
        await page
          .getByRole("checkbox", {
            name: "Priority stage message",
            exact: true,
          })
          .getAttribute("aria-checked"),
        "true",
      );
      await rawStage("Another operator's current message");
      await page
        .getByText("Another operator's current message", { exact: true })
        .waitFor();
      assert.equal(
        await field("Stage message").inputValue(),
        "My unsent stage message",
      );
      await button("Back to shows").click();
      await showCard().click();
      assert.equal(
        await field("Stage message").inputValue(),
        "My unsent stage message",
      );
      await button("Send message").click();
      assert.equal(calls.length, 0);
      await rawStage("Changed during review");
      await page.getByText("Changed during review", { exact: true }).waitFor();
      assert.equal(
        await button("Confirm send stage message").isEnabled(),
        false,
      );
      await button("Review current stage message again").click();
      await button("Keep stage message draft").click();
      assert.equal(calls.length, 0);
      await button("Send message").click();
      mode = "after";
      failShow = true;
      await button("Confirm send stage message").click();
      await wait(() => held.length === 1, "accepted send with lost response");
      assert.equal(await liveMessage(), "!!PRIORITY!!My unsent stage message");
      await rawStage("Later message must survive retry");
      await button("Retry original stage message action").waitFor({
        timeout: 20000,
      });
      assert.equal(await field("Stage message").isEditable(), false);
      await widths("uncertain", ["Retry original stage message action"]);
      mode = "normal";
      await button("Retry original stage message action").click();
      await wait(
        () => button("Refresh stage message result").isEnabled(),
        "failed show refresh",
      );
      assert.deepEqual(calls[1], calls[0]);
      assert.equal(await liveMessage(), "Later message must survive retry");
      failShow = false;
      await button("Refresh stage message result").click();
      await button("Continue editing stage message").waitFor();
      assert.equal(calls.length, 2);
      held.splice(0).forEach((done) => done());
      await button("Continue editing stage message").click();
      await button("Use current message in draft").click();
      await button("Keep stage message draft").click();
      assert.equal(
        await field("Stage message").inputValue(),
        "My unsent stage message",
      );
      await button("Use current message in draft").click();
      await button("Confirm replace stage draft").click();
      assert.equal(
        await field("Stage message").inputValue(),
        "Later message must survive retry",
      );
      assert.equal(
        await page
          .getByRole("checkbox", {
            name: "Priority stage message",
            exact: true,
          })
          .getAttribute("aria-checked"),
        "false",
      );
      await field("Stage message").fill("Keep draft through clear");
      await button("Clear stage message").click();
      assert.equal(calls.length, 2);
      await rawStage("Do not clear without reviewing");
      await page
        .getByText("Do not clear without reviewing", { exact: true })
        .waitFor();
      assert.equal(
        await button("Confirm clear stage message").isEnabled(),
        false,
      );
      await button("Review current stage message again").click();
      mode = "before";
      await button("Confirm clear stage message").click();
      await wait(() => held.length === 1, "clear held before server");
      await rawStage("Concurrent message wins");
      mode = "normal";
      held.splice(0).forEach((done) => done());
      await button("Continue editing stage message").waitFor();
      assert.equal(deliveries.at(-1).result.outcome, "conflict");
      assert.equal(await liveMessage(), "Concurrent message wins");
      assert.equal(
        await field("Stage message").inputValue(),
        "Keep draft through clear",
      );
      await button("Continue editing stage message").click();
      await button("Clear stage message").click();
      await widths("clear-review", [
        "Confirm clear stage message",
        "Keep stage message draft",
      ]);
      mode = "after";
      await button("Confirm clear stage message").click();
      await wait(() => held.length === 1, "accepted clear with lost response");
      assert.equal(await liveMessage(), "");
      await rawStage("New message after clear");
      await button("Retry original stage message action").waitFor({
        timeout: 20000,
      });
      mode = "normal";
      await button("Retry original stage message action").click();
      await button("Continue editing stage message").waitFor();
      assert.deepEqual(calls.at(-1), calls.at(-2));
      assert.equal(await liveMessage(), "New message after clear");
      held.splice(0).forEach((done) => done());
      await button("Continue editing stage message").click();
      assert.equal(
        await field("Stage message").inputValue(),
        "Keep draft through clear",
      );
      const longMessage = "Long stage message with wrapped operator notes. "
        .repeat(35)
        .trim();
      await field("Stage message").fill(longMessage);
      await button("Send message").click();
      await widths("long-review", [
        "Confirm send stage message",
        "Keep stage message draft",
      ]);
      await button("Keep stage message draft").click();
      assert.equal(await field("Stage message").inputValue(), longMessage);
      await rawStage("x".repeat(2000));
      await page.getByText("x".repeat(2000), { exact: true }).waitFor();
      await button("Use current message in draft").click();
      await button("Confirm replace stage draft").click();
      assert.equal((await field("Stage message").inputValue()).length, 2000);
      await page
        .getByText("Shorten this draft to 1,980 characters before sending.", {
          exact: true,
        })
        .waitFor();
      assert.equal(await button("Send message").isEnabled(), false);
      await widths("overlong",["Use current message in draft","Clear stage message"]);
      await field("Stage message").fill("Shortened draft");
      assert.equal(await button("Send message").isEnabled(), true);
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          result: "pass",
          realRelay: true,
          incomingUpdateKeepsDraft: true,
          navigationRetainsDraft: true,
          explicitSendClearReplace: true,
          staleReviewBlocked: true,
          exactSendAndClearRetries: true,
          laterMessagesPreserved: true,
          refreshOnlyRetry: true,
          longMessage: true,
          widths: [320, 768, 1440],
        }),
      );
    } catch (error) {
      await page.screenshot({
        path: "/tmp/showpilot-native-stage-failure.png",
        fullPage: true,
      });
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
      closing = true;
      held.splice(0).forEach((done) => done());
      for (const socket of sockets) socket.close();
      await browser.close();
      await Promise.all([...httpRequests]);
      await new Promise((done) => server.close(done));
    }
  },
);
