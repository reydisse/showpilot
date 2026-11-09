// Exercise the compiled native controls against a local command-receipt stub.
// Authentication and live rundown hydration use the disposable Worker; no production traffic.
// Real receipt persistence, permissions and Bridge dispatch are covered by Worker/Bridge tests.
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
      failCheck = false;
    const receipts = new Map(),
      executed = [];
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
      const operation = url.pathname.match(
        /\/propresenter\/(prepare|execute|check)$/,
      )?.[1];
      if (operation) {
        const command = JSON.parse(body);
        calls.push({ operation, ...command });
        if (operation === "check" && failCheck)
          return route.fulfill({
            status: 503,
            headers,
            body: JSON.stringify({ error: "Fixture status read failed" }),
          });
        let receipt = receipts.get(command.requestId);
        if (operation === "prepare" && !receipt) {
          receipt = {
            ...command,
            status: "prepared",
            message: "Slide command ready.",
            expires: Date.now() + 5000,
          };
          receipts.set(command.requestId, receipt);
        }
        if (operation === "execute" && receipt?.status === "prepared") {
          executed.push(command);
          receipt = {
            ...command,
            status: mode === "uncertain" ? "uncertain" : "confirmed",
            message:
              mode === "uncertain"
                ? "ProPresenter did not confirm this command. It may have changed the slide. Check the output before sending another command."
                : "ProPresenter confirmed the command.",
          };
          receipts.set(command.requestId, receipt);
        }
        if (receipt?.status === "prepared" && receipt.expires <= Date.now())
          receipt = {
            ...command,
            status: "rejected",
            message: "This command expired before it was sent.",
          };
        if (!receipt)
          receipt = {
            ...command,
            status: "rejected",
            message: "This command was not sent.",
          };
        if (
          (operation === "execute" && mode === "after") ||
          (operation === "prepare" && mode === "before")
        )
          await new Promise((done) => held.push(done));
        return route
          .fulfill({
            status: 200,
            headers,
            body: JSON.stringify(
              Object.fromEntries(
                Object.entries(receipt).filter(([key]) => key !== "expires"),
              ),
            ),
          })
          .catch(() => {});
      }
      const result = await fetch(`${origin}${url.pathname}${url.search}`, {
        method: request.method(),
        headers: {
          Cookie: cookie,
          Origin: origin,
          "Content-Type": "application/json",
        },
        ...(body ? { body } : {}),
      });
      let bytes = Buffer.from(await result.arrayBuffer());
      if (request.method() === "GET" && url.pathname === base && result.ok) {
        const detail = JSON.parse(bytes);
        detail.proPresenter = {
          configured: true,
          cuesEnabled: true,
          stageDisplayEnabled: false,
          bridgeOnline: true,
          connected: true,
        };
        bytes = Buffer.from(JSON.stringify(detail));
      }
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
          path: `/tmp/showpilot-native-propresenter-${kind}-${width}.png`,
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
      await wait(() => button("Next slide").isEnabled(), "live slide controls");
      await widths("ready", ["Previous slide", "Next slide", "Clear"]);
      await button("Clear").click();
      assert.equal(executed.length, 0);
      await widths("clear-review", ["Clear ProPresenter output", "Cancel"]);
      await button("Cancel").click();
      assert.equal(executed.length, 0);
      mode = "after";
      await button("Next slide").click();
      await wait(() => held.length === 1, "lost accepted Next reply");
      assert.equal(executed.length, 1);
      await wait(
        () => button("Check command status").isVisible(),
        "bounded request timeout",
      );
      assert.equal(await button("Next slide").isEnabled(), false);
      await widths("lost-reply", ["Check command status"]);
      failCheck = true;
      await button("Check command status").click();
      await page
        .getByText("Fixture status read failed", { exact: true })
        .waitFor();
      assert.equal(executed.length, 1);
      failCheck = false;
      mode = "normal";
      held.splice(0).forEach((done) => done());
      await button("Check command status").click();
      await wait(
        () => button("Next slide").isEnabled(),
        "original Next confirmed",
      );
      assert.equal(executed.length, 1);
      assert.equal(calls.filter((c) => c.operation === "execute").length, 1);
      mode = "uncertain";
      await button("Clear").click();
      assert.equal(executed.length, 1);
      await button("Clear ProPresenter output").click();
      await button("I checked the output").waitFor();
      assert.equal(executed.length, 2);
      assert.equal(executed[1].command, "clear");
      await button("Check command status").click();
      await wait(
        () => button("I checked the output").isVisible(),
        "uncertain result preserved",
      );
      assert.equal(await button("Next slide").isEnabled(), false);
      await widths("uncertain", [
        "Check command status",
        "I checked the output",
      ]);
      await button("I checked the output").click();
      await wait(
        () => button("Next slide").isEnabled(),
        "explicit output check",
      );
      mode = "before";
      await button("Previous slide").click();
      await wait(() => held.length === 1, "preparation response held");
      await wait(
        () => button("Check command status").isVisible(),
        "preparation timeout",
      );
      mode = "normal";
      held.splice(0).forEach((done) => done());
      await button("Check command status").click();
      await button("I checked the output").waitFor();
      assert.equal(executed.length, 2, "late preparation never executes");
      assert.equal(calls.filter((c) => c.operation === "execute").length, 2);
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          result: "PASS",
          lostReply: true,
          statusFailure: true,
          noDuplicateNext: true,
          clearConfirmation: true,
          uncertainAcknowledgement: true,
          latePreparationBlocked: true,
          widths: [320, 768, 1440],
        }),
      );
    } catch (error) {
      await page.screenshot({
        path: "/tmp/showpilot-native-propresenter-failure.png",
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
