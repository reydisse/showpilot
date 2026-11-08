// Render the exported Expo web app with the native template deletion controls. All API traffic is
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
      failTemplates = false,
      failShow = false,
      holdInitialShow = false,
      holdInitialTemplates = false;
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
      if (
        request.method() === "GET" &&
        url.pathname === `${base}/templates` &&
        holdInitialTemplates
      ) {
        holdInitialTemplates = false;
        await new Promise((done) => held.push(done));
      }
      const headers = {
        "content-type": "application/json",
        "access-control-allow-origin": nativeOrigin,
        "access-control-allow-credentials": "true",
      };
      if (
        request.method() === "GET" &&
        ((failTemplates && url.pathname === `${base}/templates`) ||
          (failShow && url.pathname === base))
      )
        return route.fulfill({
          status: 503,
          headers,
          body: JSON.stringify({ error: "Fixture template list failed" }),
        });
      const command = url.pathname.startsWith(`${base}/templates/`) && url.pathname.endsWith("/remove"),
        review = false,
        delivery = mode;
      if (command || review) calls.push({ templateId: url.pathname.split("/").at(-2), command: JSON.parse(body) });
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
          path: `/tmp/showpilot-native-template-delete-${kind}-${width}.png`,
          fullPage: true,
        });
      }
    }
    try {
      const templateId = crypto.randomUUID();
      const templateName = "Sunday production template with a long descriptive name";
      const keptId = crypto.randomUUID();
      await api("/templates", { requestId: templateId, name: templateName });
      await api("/templates", { requestId: keptId, name: "Keep this template" });
      const originalName = (await api()).snapshot.name;
      const showCard = () => page.getByRole("button").filter({ has: page.getByText(originalName, { exact: true }) });
      await page.goto(`${nativeOrigin}/shows`);
      await showCard().click();
      await wait(() => button("Edit show details").isEnabled(), "real relay hydration");
      await button("Open rundown templates").click();
      await button(`Delete ${templateName}`).click();
      await widths("confirm", ["Confirm template deletion", "Keep template", "Close rundown templates"]);
      assert.equal(calls.length, 0);
      await button("Keep template").click();
      assert.equal(calls.length, 0);
      assert.ok((await api("/templates")).templates.some(t => t.id === templateId));
      await button(`Delete ${templateName}`).click();
      mode = "after";
      failTemplates = true;
      await button("Confirm template deletion").click();
      await wait(() => held.length === 1, "delete committed with reply held");
      assert.equal(calls[0].templateId, templateId);
      assert.equal((await api("/templates")).templates.some(t => t.id === templateId), false);
      const first = calls[0];
      await button("Close rundown templates").click();
      await button("Back to shows").click();
      await showCard().click();
      await button("Resume template deletion").click();
      await button(`Retry deletion of ${templateName}`).waitFor({timeout: 20000});
      await widths("unknown", [`Retry deletion of ${templateName}`, "Close rundown templates"]);
      mode = "normal";
      await button(`Retry deletion of ${templateName}`).click();
      await page.getByText("Template deleted. Existing shows are not affected.", {exact:true}).waitFor();
      await page.getByText("Fixture template list failed", {exact:true}).first().waitFor();
      assert.deepEqual(calls[1], first);
      await widths("refresh", ["Refresh saved templates", "Close rundown templates"]);
      failTemplates = false;
      await button("Refresh saved templates").click();
      await button("Dismiss deletion result").waitFor();
      assert.equal(calls.length, 2);
      await widths("confirmed", ["Dismiss deletion result", "Close rundown templates"]);
      await button("Dismiss deletion result").click();
      assert.equal(await button(`Delete ${templateName}`).count(), 0);
      assert.equal(await button("Delete Keep this template").count(), 1);
      // Releasing the obsolete response cannot change the confirmed outcome.
      held.splice(0).forEach(done => done());
      assert.equal((await api("/templates")).templates.some(t => t.id === templateId), false);
      const receipt = await queryFixture(`SELECT key FROM app_setting WHERE orgId='${orgId}' AND key='rundown-template-save:${templateId}'`);
      assert.equal(receipt.length, 1);
      const detail = await api();
      assert.equal(detail.snapshot.name, originalName);
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ result: "pass", realAuth: true, realRelay: true, visibleConfirmation: true, keepWithoutDelete: true, uncertainDeadline: true, navigationRetained: true, exactRetry: true, refreshOnly: true, otherTemplatePreserved: true, showPreserved: true, viewports: [320,768,1440], errors }));
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
