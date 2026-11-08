// Render the exported Expo web app with its native show edit/delete forms. All API traffic is
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
      const command = url.pathname === "/api/mobile/v1/schedule/shows/command",
        delivery = mode;
      if (command) calls.push(JSON.parse(body));
      if (url.pathname === "/api/mobile/v1/schedule/shows/review")
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
          deliveries.push({ command: JSON.parse(body), status: result.status, result: JSON.parse(response.body.toString()) });
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
    const row = async () =>
      (
        await queryFixture(
          "SELECT id,name,location,updatedAt FROM rundown WHERE orgId='display-smoke' AND id='assignment-show'",
        )
      )[0];
    const openEdit = async () => {
      await page
        .getByRole("button", { name: "Edit", exact: true })
        .first()
        .click();
      await page.getByLabel("Show name").waitFor();
    };
    async function checkWidths(kind, controls) {
      for (const [width, height] of [
        [320, 568],
        [768, 1024],
        [1440, 1000],
      ]) {
        await page.setViewportSize({ width, height });
        for (const name of controls) {
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
        await button(controls[0]).scrollIntoViewIfNeeded();
        await page.screenshot({
          path: `/tmp/showpilot-native-show-${kind}-${width}.png`,
        });
      }
    }
    async function serverRequest(path, body) {
      const response = await fetch(`${origin}${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          Cookie: cookie,
          Origin: origin,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    }
    try {
      await page.goto(`${nativeOrigin}/schedule?date=2099-01-01`);
      await openEdit();
      await page.getByLabel("Show name").fill("Retained native show");
      await page.getByLabel("Venue or location").fill("Booth");
      await button("Close show change").click();
      await page.getByRole("button", { name: /^Resume show edit:/ }).click();
      assert.equal(
        await page.getByLabel("Show name").inputValue(),
        "Retained native show",
      );
      mode = "after";
      await button("Save show").click();
      await wait(() => calls.length === 1 && held.length === 1);
      await button("Close show change").click();
      await button("Delete").click();
      await page.getByText(/Your earlier edit is retained/).waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: "Delete show…", exact: true })
          .count(),
        0,
      );
      await button("Retry original save").waitFor({ timeout: 20000 });
      assert.equal(await page.getByLabel("Show name").isEditable(), false);
      await checkWidths("edit", [
        "Retry original save",
        "Review original save",
        "Close show change",
      ]);
      mode = "normal";
      failReads = true;
      await button("Retry original save").click();
      await button("Refresh only").waitFor({ timeout: 20000 });
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0], calls[1]);
      assert.equal((await row()).name, "Retained native show");
      failReads = false;
      await button("Refresh only").click();
      await button("Finish").click();
      held.splice(0).forEach((done) => done());
      assert.equal(
        await page.getByRole("button", { name: /^Resume show edit:/ }).count(),
        0,
      );

      await openEdit();
      await page.getByLabel("Venue or location").fill("Before review");
      mode = "before";
      await button("Save show").click();
      await button("Retry original save").waitFor({ timeout: 20000 });
      await button("Review original save").click();
      await button("Edit unapplied draft").waitFor();
      assert.deepEqual(reviews[0], calls[2]);
      held.splice(0).forEach((done) => done());
      await wait(() =>
        deliveries.some(
          (value) => value.command.requestId === calls[2].requestId,
        ),
      );
      assert.equal(
        deliveries.find(
          (value) => value.command.requestId === calls[2].requestId,
        ).result.result.outcome,
        "cancelled",
      );
      assert.equal((await row()).location, "Booth");
      await button("Edit unapplied draft").click();
      const current = await serverRequest(
        `/api/mobile/v1/schedule/shows/assignment-show?orgId=${orgId}&userId=${calls[2].userId}`,
      );
      await serverRequest(
        `/api/mobile/v1/schedule/shows/command?orgId=${orgId}`,
        {
          ...calls[2],
          requestId: crypto.randomUUID(),
          expectedUpdatedAt: current.snapshot.updatedAt,
          name: "Other operator",
          location: "Other booth",
        },
      );
      mode = "normal";
      await button("Save show").click();
      await page.getByText(/This show changed on another device/).waitFor();
      assert.equal(
        await page.getByLabel("Venue or location").inputValue(),
        "Before review",
      );
      await button("Load current show…").click();
      await button("Keep draft").click();
      assert.equal(
        await page.getByLabel("Venue or location").inputValue(),
        "Before review",
      );
      await button("Load current show…").click();
      await button("Load current and replace draft").click();
      await wait(
        async () =>
          (await page.getByLabel("Show name").inputValue()) ===
          "Other operator",
      );
      await page.getByLabel("Venue or location").fill("My final booth");
      await button("Save show").click();
      await button("Finish").click();
      assert.equal((await row()).location, "My final booth");
      assert.equal(calls.length, 5);

      await button("Delete").click();
      await button("Delete show…").click();
      await button("Keep show").click();
      assert.equal(calls.length, 5);
      assert.ok(await row());
      await button("Delete show…").click();
      mode = "after";
      await button("Delete reviewed show").click();
      await wait(() =>
        deliveries.some(
          (value) => value.command.requestId === calls[5]?.requestId,
        ),
      );
      assert.equal(await row(), undefined);
      await button("Close show change").click();
      await page
        .getByRole("button", { name: /^Resume show deletion:/ })
        .click();
      await button("Retry original deletion").waitFor({ timeout: 20000 });
      await checkWidths("delete", [
        "Retry original deletion",
        "Close show change",
      ]);
      assert.equal(
        await page
          .getByRole("button", { name: "Discard retained draft…", exact: true })
          .count(),
        0,
      );
      mode = "normal";
      failReads = true;
      await button("Retry original deletion").click();
      await button("Refresh only").waitFor({ timeout: 20000 });
      assert.deepEqual(calls[6], calls[5]);
      assert.equal(calls.length, 7);
      failReads = false;
      await button("Refresh only").click();
      await button("Finish").click();
      assert.equal(
        await page
          .getByRole("button", { name: /^Resume show deletion:/ })
          .count(),
        0,
      );
      assert.deepEqual(
        await queryFixture(
          "SELECT stage FROM show_deletion WHERE orgId='display-smoke' AND showId='assignment-show'",
        ),
        [{ stage: "deleted" }],
      );
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          retainedEdit: true,
          competingDeleteBlocked: true,
          exactSaveRetry: true,
          refreshOnly: true,
          reviewFencesLateSave: true,
          conflictPreservesDraft: true,
          explicitCurrentRead: true,
          deleteCancelSendsNothing: true,
          deletedRowResume: true,
          exactDeleteRetry: true,
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
          inputs: await page.locator("input").evaluateAll((nodes) =>
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
