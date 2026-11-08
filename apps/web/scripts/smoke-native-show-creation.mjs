// Render the exported Expo web app with its shared native show-creation form. All API traffic is
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
    const errors = [],
      calls = [],
      reviews = [],
      held = [],
      deliveries = [];
    let mode = "normal",
      failReads = false;
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.startsWith("/api/")) {
        if (url.origin === nativeOrigin) return route.continue();
        return route.abort();
      }
      if (
        failReads &&
        ["/api/mobile/v1/schedule", "/api/mobile/v1/bootstrap"].includes(
          url.pathname,
        ) &&
        route.request().method() === "GET"
      ) {
        return route.fulfill({
          status: 503,
          headers: {
            "content-type": "application/json",
            "access-control-allow-origin": nativeOrigin,
            "access-control-allow-credentials": "true",
          },
          body: JSON.stringify({ error: "Fixture schedule read failed" }),
        });
      }
      const request = route.request(),
        body = request.postData();
      const command = url.pathname === "/api/mobile/v1/shows/create",
        delivery = mode;
      if (command) calls.push(JSON.parse(body));
      if (url.pathname === "/api/mobile/v1/shows/review-creation")
        reviews.push(JSON.parse(body));
      const delayed = command;
      const deliver = async () => {
        const result = await fetch(`${origin}${url.pathname}${url.search}`, {
          method: request.method(),
          headers: {
            Cookie: cookie,
            Origin: origin,
            "Content-Type": "application/json",
          },
          ...(body ? { body } : {}),
        });
        const response = {
          status: result.status,
          headers: {
            "content-type": "application/json",
            "access-control-allow-origin": nativeOrigin,
            "access-control-allow-credentials": "true",
          },
          body: Buffer.from(await result.arrayBuffer()),
        };
        if (command)
          deliveries.push({ command: JSON.parse(body), status: result.status });
        if (delayed && delivery === "after")
          await new Promise((done) => held.push(done));
        await route.fulfill(response).catch(() => {});
      };
      if (delayed && delivery === "before")
        await new Promise((done) => held.push(done));
      await deliver();
    });
    const button = (name) =>
      page.getByRole("button", { name, exact: true }).last();
    const wait = async (check) => {
      const end = Date.now() + 20000;
      while (!(await check())) {
        if (Date.now() > end)
          throw new Error("Native browser assertion timed out");
        await new Promise((done) => setTimeout(done, 50));
      }
    };
    const rows = () =>
      queryFixture(
        "SELECT id,name,serviceDate,scheduledStartTime FROM rundown WHERE orgId='display-smoke' AND name LIKE 'Expo %'",
      );
    try {
      await page.goto(`${nativeOrigin}/schedule?date=2099-01-01`);
      await button("Create show").click();
      await page
        .getByRole("button", { name: /^Copy rundown:/ })
        .first()
        .click();
      await page.getByLabel("Show name", { exact: true }).fill("Expo evening");
      await page.getByLabel("Show date", { exact: true }).fill("2099-01-02");
      await page
        .getByLabel("Start time (optional)", { exact: true })
        .fill("19:00");
      await button("Close create show").click();
      await page
        .getByRole("button", { name: /^Resume show: Expo evening/ })
        .click();
      assert.equal(
        await page.getByLabel("Start time (optional)").inputValue(),
        "19:00",
      );
      mode = "after";
      await button("Create show").click();
      await wait(() => calls.length === 1 && held.length === 1);
      assert.ok(calls[0].copyFromShowId);
      await button("Close create show").click();
      await page
        .getByRole("button", { name: /^Resume show: Expo evening/ })
        .click();
      await button("Retry original creation").waitFor({ timeout: 20000 });
      assert.equal(await page.getByLabel("Show name").isEditable(), false);
      for (const [width, height] of [
        [320, 568],
        [768, 1024],
        [1440, 1000],
      ]) {
        await page.setViewportSize({ width, height });
        for (const name of [
          "Retry original creation",
          "Review original creation",
          "Close create show",
        ]) {
          await button(name).scrollIntoViewIfNeeded();
          const bounds = await button(name).evaluate((node) => {
            const b = node.getBoundingClientRect(),
              range = document.createRange();
            range.selectNodeContents(node);
            const t = range.getBoundingClientRect();
            return {
              height: b.height,
              width: b.width,
              fits:
                b.left >= 0 &&
                b.right <= innerWidth &&
                b.top >= 0 &&
                b.bottom <= innerHeight,
              hit: node.contains(
                document.elementFromPoint(
                  b.x + b.width / 2,
                  b.y + b.height / 2,
                ),
              ),
              textInside:
                t.left >= b.left &&
                t.right <= b.right &&
                t.top >= b.top &&
                t.bottom <= b.bottom,
            };
          });
          assert.ok(
            bounds.height >= 44 &&
              bounds.width >= 44 &&
              bounds.fits &&
              bounds.hit &&
              (name.startsWith("Close") || bounds.textInside),
            JSON.stringify({ name, ...bounds }),
          );
        }
        await button("Retry original creation").scrollIntoViewIfNeeded();
        await page.screenshot({
          path: `/tmp/showpilot-native-show-${width}.png`,
        });
      }
      mode = "normal";
      failReads = true;
      await button("Retry original creation").click();
      await button("Refresh only").waitFor({ timeout: 20000 });
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0], calls[1]);
      assert.equal((await rows()).length, 1);
      failReads = false;
      await button("Refresh only").click();
      await button("Finish").click();
      assert.equal(calls.length, 2);
      assert.equal(
        await page.getByRole("button", { name: /^Resume show:/ }).count(),
        0,
      );
      held.splice(0).forEach((done) => done());

      await button("Create show").click();
      await page.getByLabel("Show name").fill("Expo unapplied");
      mode = "before";
      await button("Create show").click();
      await button("Retry original creation").waitFor({ timeout: 20000 });
      await button("Review original creation").click();
      await button("Edit unapplied draft").waitFor();
      const cancelled = calls[2];
      assert.deepEqual(reviews[0], cancelled);
      held.splice(0).forEach((done) => done());
      await wait(() =>
        deliveries.some(
          (value) => value.command.requestId === cancelled.requestId,
        ),
      );
      assert.ok(
        deliveries.find(
          (value) => value.command.requestId === cancelled.requestId,
        ).status >= 400,
      );
      assert.equal((await rows()).length, 1);
      await button("Edit unapplied draft").click();
      await page.getByLabel("Show name").fill("Expo reviewed");
      await page.getByLabel("Start time (optional)").fill("18:00");
      mode = "normal";
      await button("Create show").click();
      await button("Open created show").click();
      await button("Create another show").waitFor();
      assert.notEqual(calls[3].requestId, cancelled.requestId);
      assert.equal((await rows()).length, 2);

      // Rundown entry preserves same-day copy and next-hour defaults.
      await button("Create another show").click();
      assert.equal(
        await page.getByLabel("Show date").inputValue(),
        calls[3].serviceDate,
      );
      assert.equal(
        await page.getByLabel("Start time (optional)").inputValue(),
        "19:00",
      );
      await page.getByLabel("Show name").fill("Expo rundown draft");
      await button("Close create show").click();
      await button("Create another show").click();
      assert.equal(
        await page.getByLabel("Show name").inputValue(),
        "Expo rundown draft",
      );
      await button("Create show").click();
      await button("Finish").click();
      assert.equal(calls[4].copyFromShowId, calls[3].requestId);
      assert.equal((await rows()).length, 3);

      // Start a fresh mounted Shows tab and verify its creation entry as well.
      await page.goto(`${nativeOrigin}/shows`);
      await button("Create show").click();
      await page.getByLabel("Show name").fill("Expo shows tab");
      await page.getByLabel("Show date").fill("2099-01-03");
      await button("Close create show").click();
      await page.getByRole("button", { name: /^Expo reviewed/ }).click();
      await button("Create another show").click();
      assert.equal(
        await page.getByLabel("Show name").inputValue(),
        "Expo shows tab",
      );
      assert.equal(
        await page.getByLabel("Show date").inputValue(),
        "2099-01-03",
      );
      await button("Create show").click();
      await button("Finish").click();
      assert.equal((await rows()).length, 4);
      assert.equal(calls.length, 6);
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          draftRetained: true,
          sourceRetained: true,
          exactRetry: true,
          refreshOnly: true,
          reviewFencesLateCreation: true,
          allThreeEntries: true,
          draftSurvivesRouteChange: true,
          sameDayCopy: true,
          viewports: [320, 768, 1440],
          errors,
        }),
      );
    } catch (error) {
      console.log(
        JSON.stringify({
          url: page.url(),
          body: await page.locator("body").innerText(),
          errors,
          inputs: await page
            .locator("input")
            .evaluateAll((nodes) =>
              nodes.map((node) => ({
                label: node.getAttribute("aria-label"),
                value: node.value,
                disabled: node.disabled,
              })),
            ),
        }),
      );
      throw error;
    } finally {
      held.splice(0).forEach((done) => done());
      await browser.close();
      await new Promise((done) => server.close(done));
    }
  },
  { personalAssignments: true, paidPlan: true },
);
