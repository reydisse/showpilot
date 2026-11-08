// Render the exported Expo web app with its native assignment editor/hook. All API traffic is
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
      held = [];
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
        url.pathname === "/api/mobile/v1/schedule" &&
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
      const command = url.pathname.endsWith("/assignments/command"),
        delivery = mode;
      if (command) calls.push(JSON.parse(body));
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
        if (command && delivery === "after")
          await new Promise((done) => held.push(done));
        await route.fulfill(response).catch(() => {});
      };
      if (command && delivery === "before")
        await new Promise((done) => held.push(done));
      await deliver();
    });
    const button = (name) => page.getByRole("button", { name, exact: true });
    const open = async () => {
      await button("Position").first().click();
      await page.getByLabel("Position", { exact: true }).waitFor();
    };
    const close = async () => {
      await button("Close Add a position").click();
      await page
        .getByLabel("Position", { exact: true })
        .waitFor({ state: "hidden" });
    };
    const wait = async (check) => {
      const end = Date.now() + 20000;
      while (!(await check())) {
        if (Date.now() > end)
          throw new Error("Native browser assertion timed out");
        await new Promise((done) => setTimeout(done, 50));
      }
    };
    const api = async (path, body) => {
      const response = await fetch(
        `${origin}/api/mobile/v1/schedule/assignments/${path}?orgId=${orgId}`,
        {
          method: body ? "POST" : "GET",
          headers: {
            Cookie: cookie,
            Origin: origin,
            "Content-Type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    const rows = () =>
      queryFixture(
        "SELECT id,role,notes FROM service_assignment WHERE orgId='display-smoke' AND role LIKE 'Expo %'",
      );
    try {
      await page.goto(`${nativeOrigin}/schedule?date=2099-01-01`);
      await open();
      await page
        .getByLabel("Position", { exact: true })
        .fill("Expo retained draft");
      await page
        .getByLabel("Manager note (optional)")
        .fill("Retain preparation notes");
      await close();
      await page
        .getByRole("button", {
          name: /^Resume assignment: Expo retained draft/,
        })
        .click();
      assert.equal(
        await page.getByLabel("Manager note (optional)").inputValue(),
        "Retain preparation notes",
      );
      mode = "after";
      await button("Add open position").click();
      await button("Retry original save").waitFor({ timeout: 20000 });
      assert.equal(
        await page.getByLabel("Position", { exact: true }).isEditable(),
        false,
      );
      for (const [width, height] of [
        [320, 568],
        [768, 1024],
        [1440, 1000],
      ]) {
        await page.setViewportSize({ width, height });
        await wait(() =>
          page.evaluate((expected) => innerWidth === expected, width),
        );
        for (const name of [
          "Retry original save",
          "Review original request",
          "Close Add a position",
        ]) {
          await button(name).scrollIntoViewIfNeeded();
          const bounds = await button(name).evaluate((node) => {
            const b = node.getBoundingClientRect();
            const range = document.createRange();
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
        await button("Retry original save").scrollIntoViewIfNeeded();
        await writeFile(
          `/tmp/showpilot-native-assignment-${width}.png`,
          await page.screenshot(),
        );
      }
      mode = "normal";
      failReads = true;
      await button("Retry original save").click();
      await button("Refresh Schedule").waitFor({ timeout: 20000 });
      assert.deepEqual(calls[1], calls[0]);
      assert.equal((await rows()).length, 1);
      const beforeRefresh = calls.length;
      failReads = false;
      await button("Refresh Schedule").click();
      await button("Finish and close").waitFor();
      assert.equal(calls.length, beforeRefresh);
      held.splice(0).forEach((done) => done());
      await button("Finish and close").click();
      await wait(
        async () =>
          (await page
            .getByRole("button", {
              name: /^Resume assignment: Expo retained draft/,
            })
            .count()) === 0,
      );

      await open();
      await page
        .getByLabel("Position", { exact: true })
        .fill("Expo undelivered draft");
      mode = "before";
      await button("Add open position").click();
      await button("Review original request").waitFor({ timeout: 20000 });
      const cancelled = calls.at(-1);
      await button("Review original request").click();
      await button("Edit original draft").click();
      assert.equal(
        await page.getByLabel("Position", { exact: true }).inputValue(),
        "Expo undelivered draft",
      );
      mode = "normal";
      held.splice(0).forEach((done) => done());
      await page
        .getByLabel("Position", { exact: true })
        .fill("Expo reviewed draft");
      await button("Add open position").click();
      await button("Finish and close").waitFor();
      assert.notEqual(calls.at(-1).requestId, cancelled.requestId);
      assert.equal((await rows()).length, 2);
      assert.equal(
        (
          await queryFixture(
            `SELECT outcome FROM schedule_assignment_request WHERE orgId='display-smoke' AND requestId='${cancelled.requestId}'`,
          )
        )[0].outcome,
        "conflict",
      );
      await button("Finish and close").click();

      // Edit from the rendered row, then change its revision through another client.
      const row = page
        .getByText("Expo retained draft", { exact: true })
        .locator("xpath=../..")
        .locator("..");
      await row.getByRole("button", { name: "Edit", exact: true }).click();
      await page
        .getByLabel("Manager note (optional)")
        .fill("Local unsaved note");
      const id = (await rows()).find(
        (row) => row.role === "Expo retained draft",
      ).id;
      const current = await api(id);
      const other = await api("command", {
        ...calls[0],
        requestId: crypto.randomUUID(),
        operation: {
          kind: "edit",
          id,
          expectedRevision: current.snapshot.revision,
          fields: { ...calls[0].operation.fields, notes: "Other manager note" },
        },
      });
      assert.equal(other.outcome, "applied");
      await button("Save assignment").click();
      await button("Load current position").waitFor();
      assert.equal(
        await page.getByLabel("Manager note (optional)").inputValue(),
        "Local unsaved note",
      );
      await button("Load current position").click();
      await wait(
        async () =>
          (await page.getByLabel("Manager note (optional)").inputValue()) ===
          "Other manager note",
      );
      await page
        .getByLabel("Manager note (optional)")
        .fill("Reviewed final note");
      await button("Save assignment").click();
      await button("Finish and close").click();
      assert.equal((await api(id)).snapshot.notes, "Reviewed final note");

      await row.getByRole("button", { name: "Remove", exact: true }).click();
      await button("Review removal").click();
      const beforeCancel = calls.length;
      await button("Cancel").click();
      assert.equal(calls.length, beforeCancel);
      assert.ok((await api(id)).snapshot);
      await button("Review removal").click();
      await button("Remove position").click();
      await button("Finish and close").click();
      assert.equal((await api(id)).snapshot, null);
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          exportedExpoForm: true,
          retainedDraft: true,
          lockedFields: true,
          exactRetry: true,
          onePositionPerRequest: true,
          refreshOnly: true,
          reviewFencesLateWrite: true,
          revisionConflictRetainsDraft: true,
          explicitCurrentReview: true,
          confirmedRemoval: true,
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
        }),
      );
      throw error;
    } finally {
      held.splice(0).forEach((done) => done());
      await browser.close();
      await new Promise((done) => server.close(done));
    }
  },
  { personalAssignments: true, captureEmail: true },
);
