// Render the exported Expo web app with the native template save form. All API traffic is
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
      failTemplates = true,
      failShow = false,
      holdInitialShow = false,
      holdInitialTemplates = true;
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
      const command = url.pathname === `${base}/templates/command`,
        review = url.pathname === `${base}/templates/review`,
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
    const title = () => field("Template name");
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
    async function operatorChange(action, payload) {
      const current = await api();
      const response = await fetch(
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
            action,
            payload,
          }),
        },
      );
      assert.equal(response.status, 200, await response.clone().text());
      await response.arrayBuffer();
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
          path: `/tmp/showpilot-native-template-${kind}-${width}.png`,
          fullPage: true,
        });
      }
    }
    try {
      await operatorChange("add-item", {
        id: "fixture-template-item",
        title: "Original reviewed item",
        type: "segment",
        duration: 60000,
        notes: "Fixture notes",
        assignee: "Host",
        cue: "GO",
        hardStop: false,
      });
      const originalName = (await api()).snapshot.name;
      const showCard = () =>
        page
          .getByRole("button")
          .filter({ has: page.getByText(originalName, { exact: true }) });
      await page.goto(`${nativeOrigin}/shows`);
      await showCard().click();
      await wait(
        () => button("Edit show details").isEnabled(),
        "real relay hydration",
      );
      await button("Open rundown templates").click();
      await button("Retry saved templates").waitFor({ timeout: 20000 });
      held.splice(0).forEach((done) => done());
      assert.equal(
        await page
          .getByText(
            "No saved templates yet. Save the current rundown to create one.",
            { exact: true },
          )
          .count(),
        0,
      );
      failTemplates = false;
      await button("Retry saved templates").click();
      await title().fill("Retained template");
      await button("Close rundown templates").click();
      await button("Back to shows").click();
      await showCard().click();
      await button("Resume template draft").click();
      assert.equal(await title().inputValue(), "Retained template");
      await button("Discard template draft…").click();
      await button("Keep draft").click();
      await laterEdit();
      await operatorChange("update-item", {
        id: "fixture-template-item",
        updates: { title: "Changed live item" },
      });
      assert.ok(
        (await page.getByText(/This reviewed copy has/).innerText()).includes(
          originalName,
        ),
      );
      mode = "after";
      failTemplates = true;
      await button("Save template").click();
      await wait(() => held.length === 1, "save committed with lost reply");
      const firstId = calls[0].command.requestId;
      assert.equal(calls[0].command.serviceName, originalName);
      assert.equal(calls[0].command.items[0].title, "Original reviewed item");
      const stored = await queryFixture(
        `SELECT value FROM app_setting WHERE orgId='${orgId}' AND key='rundown-saved:${firstId}'`,
      );
      assert.equal(
        JSON.parse(stored[0].value).items[0].title,
        "Original reviewed item",
      );
      assert.ok(
        (await api("/templates")).templates.some((t) => t.id === firstId),
      );
      await button("Close rundown templates").click();
      await button("Resume template draft").click();
      await button("Retry original template save").waitFor({ timeout: 20000 });
      assert.equal(await title().isEditable(), false);
      await widths("unknown", [
        "Retry original template save",
        "Review original template save",
        "Close rundown templates",
      ]);
      mode = "normal";
      await button("Retry original template save").click();
      await page
        .getByText(
          /Fixture template list failed The save result above is confirmed/,
        )
        .waitFor();
      assert.deepEqual(calls[1], calls[0]);
      await widths("refresh", ["Refresh templates only"]);
      failTemplates = false;
      await button("Refresh templates only").click();
      await button("Finish template save").waitFor();
      assert.equal(calls.length, 2);
      held.splice(0).forEach((done) => done());
      await button("Finish template save").click();
      await title().fill("Cancelled copy");
      mode = "before";
      await button("Save template").click();
      await wait(() => held.length === 1, "save held before delivery");
      await button("Review original template save").waitFor({ timeout: 20000 });
      mode = "normal";
      await button("Review original template save").click();
      await button("Edit cancelled template save").waitFor();
      assert.equal(deliveries.at(-1).result.outcome, "cancelled");
      const delivered = deliveries.length;
      held.splice(0).forEach((done) => done());
      await wait(() => deliveries.length > delivered, "late cancelled save");
      assert.equal(deliveries.at(-1).result.outcome, "cancelled");
      await widths("cancelled", ["Edit cancelled template save"]);
      const cancelledId = calls.at(-1).command.requestId;
      await button("Edit cancelled template save").click();
      await title().fill("Fresh reviewed copy");
      await button("Save template").click();
      await button("Finish template save").waitFor();
      assert.notEqual(calls.at(-1).command.requestId, cancelledId);
      await button("Finish template save").click();
      await title().fill("Removed before review");
      mode = "after";
      await button("Save template").click();
      await wait(() => held.length === 1, "saved copy to remove");
      const removedId = calls.at(-1).command.requestId;
      await api(`/templates/${removedId}/remove`, {});
      await button("Review original template save").waitFor({ timeout: 20000 });
      mode = "normal";
      await button("Review original template save").click();
      await button("Finish template save").waitFor();
      assert.equal(deliveries.at(-1).result.outcome, "removed");
      assert.ok(
        !(await api("/templates")).templates.some((t) => t.id === removedId),
      );
      held.splice(0).forEach((done) => done());
      await button("Finish template save").click();
      await title().fill("Discard me");
      await button("Use current rundown…").click();
      await button("Keep draft").click();
      await button("Use current rundown…").click();
      await button("Replace reviewed copy").click();
      assert.equal(await title().inputValue(), "Discard me");
      assert.ok(
        (await page.getByText(/This reviewed copy has/).innerText()).includes(
          "Another operator",
        ),
      );
      await button("Discard template draft…").click();
      await button("Discard draft").click();
      await wait(
        async () => (await title().inputValue()) === "",
        "fresh draft after explicit discard",
      );
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          result: "pass",
          realRelay: true,
          readRetry: true,
          stalledReadDeadline: true,
          navigationRetainsDraft: true,
          frozenCopy: true,
          exactRetry: true,
          refreshOnly: true,
          cancellationBeforeDelivery: true,
          removedNotRecreated: true,
          explicitReplacementAndDiscard: true,
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
