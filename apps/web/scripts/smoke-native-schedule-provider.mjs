// Render the exported Expo web app with its native personal assignment responses. All API traffic is
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
    // Native AbortSignal implementations need only the aborted flag/event.
    await page.addInitScript(() => {
      AbortSignal.prototype.throwIfAborted = undefined;
    });
    const errors = [],
      calls = [],
      held = [],
      deliveries = [];
    let mode = "normal",
      failReads = false,
      failProviderRead = true;
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", async (route) => {
      const request = route.request(),
        url = new URL(request.url()),
        body = request.postData();
      if (!url.pathname.startsWith("/api/"))
        return url.origin === nativeOrigin ? route.continue() : route.abort();
      const provider = url.pathname === "/api/mobile/v1/schedule/provider";
      if (
        request.method() === "GET" &&
        ((provider && failProviderRead) ||
          (failReads &&
            ["/api/mobile/v1/schedule", "/api/mobile/v1/bootstrap"].includes(
              url.pathname,
            )))
      )
        return route.fulfill({
          status: 503,
          headers: {
            "content-type": "application/json",
            "access-control-allow-origin": nativeOrigin,
            "access-control-allow-credentials": "true",
          },
          body: JSON.stringify({ error: "Fixture schedule read failed" }),
        });
      const command = provider && request.method() === "POST",
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
      if (command) deliveries.push(JSON.parse(bytes));
      if (command && delivery === "after")
        await new Promise((done) => held.push(done));
      await route
        .fulfill({
          status: result.status,
          headers: {
            "content-type": "application/json",
            "access-control-allow-origin": nativeOrigin,
            "access-control-allow-credentials": "true",
          },
          body: bytes,
        })
        .catch(() => {});
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
    async function current() {
      const response = await fetch(
        `${origin}/api/mobile/v1/schedule/provider?${new URLSearchParams({ orgId, userId: "smoke-operator" })}`,
        { headers: { Cookie: cookie } },
      );
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    }
    async function laterEdit() {
      const snapshot = await current();
      const response = await fetch(
        `${origin}/api/mobile/v1/schedule/provider?orgId=${orgId}`,
        {
          method: "POST",
          headers: {
            Cookie: cookie,
            Origin: origin,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            orgId,
            userId: "smoke-operator",
            requestId: crypto.randomUUID(),
            expectedRevision: snapshot.revision,
            config: {
              provider: "faithteams",
              url: "https://newer.example.test/team",
              label: "",
            },
          }),
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
          path: `/tmp/showpilot-native-provider-${kind}-${width}.png`,
          fullPage: true,
        });
      }
    }
    try {
      await page.goto(`${nativeOrigin}/schedule?date=2099-01-01`);
      await button("Schedule settings").click();
      await button("Retry loading source").waitFor();
      assert.equal(calls.length, 0);
      failProviderRead = false;
      await button("Retry loading source").click();
      await page
        .getByRole("radio", { name: "Other platform", exact: true })
        .click();
      await field("Platform name").fill("Retained planner");
      await field("Scheduling workspace URL").fill(
        "https://planner.example.test/team",
      );
      await button("Close Schedule settings").click();
      await button("Resume source change").click();
      assert.equal(
        await field("Platform name").inputValue(),
        "Retained planner",
        "Closing preserves the original draft",
      );
      await button("Discard source draft…").click();
      await button("Keep draft").click();
      assert.equal(
        await field("Platform name").inputValue(),
        "Retained planner",
      );
      mode = "after";
      failReads = true;
      await button("Save schedule settings").click();
      await wait(() => held.length === 1, "save committed with lost reply");
      assert.equal((await current()).config.label, "Retained planner");
      assert.equal(await field("Platform name").isEditable(), false);
      await button("Close Schedule settings").click();
      await button("Resume source change").click();
      await button("Retry original source change").waitFor({ timeout: 20000 });
      await widths("unknown", [
        "Retry original source change",
        "Close Schedule settings",
      ]);
      mode = "normal";
      await button("Retry original source change").click();
      await button("Refresh Schedule only").waitFor();
      assert.deepEqual(calls[1], calls[0]);
      assert.ok(
        await page
          .getByText("Scheduling source saved.", { exact: true })
          .isVisible(),
      );
      assert.equal(await button("Retry original source change").count(), 0);
      await widths("refresh", ["Refresh Schedule only"]);
      failReads = false;
      await button("Refresh Schedule only").click();
      await button("Finish source change").waitFor();
      assert.equal(calls.length, 2);
      held.splice(0).forEach((release) => release());
      await button("Finish source change").click();
      await button("Schedule settings").click();
      await field("Platform name").fill("Retained conflicting draft");
      await laterEdit();
      await button("Save schedule settings").click();
      await button("Load current source…").waitFor();
      assert.equal(deliveries.at(-1).outcome, "conflict");
      assert.equal(
        await field("Platform name").inputValue(),
        "Retained conflicting draft",
      );
      assert.equal((await current()).config.provider, "faithteams");
      await widths("conflict", [
        "Load current source…",
        "Discard source draft…",
      ]);
      await button("Load current source…").click();
      await button("Keep draft").click();
      assert.equal(
        await field("Platform name").inputValue(),
        "Retained conflicting draft",
      );
      failProviderRead = true;
      await button("Load current source…").click();
      await button("Replace with current source").click();
      await page
        .getByText("Fixture schedule read failed", { exact: true })
        .waitFor();
      assert.equal(
        await field("Platform name").inputValue(),
        "Retained conflicting draft",
      );
      failProviderRead = false;
      await button("Load current source…").click();
      await button("Replace with current source").click();
      await wait(
        async () =>
          (await field("Scheduling workspace URL").inputValue()) ===
          "https://newer.example.test/team",
        "explicitly adopted current source",
      );
      await page
        .getByRole("radio", { name: "Other platform", exact: true })
        .click();
      await field("Platform name").fill("Final reviewed source");
      await button("Save schedule settings").click();
      await button("Finish source change").waitFor();
      assert.notEqual(calls[3].requestId, calls[2].requestId);
      assert.equal((await current()).config.label, "Final reviewed source");
      await button("Finish source change").click();
      await button("Schedule settings").click();
      await field("Platform name").fill("Discard me");
      await button("Discard source draft…").click();
      await button("Discard draft").click();
      await button("Schedule settings").click();
      assert.equal(
        await field("Platform name").inputValue(),
        "Final reviewed source",
      );
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          result: "pass",
          initialReadRecovery: true,
          retainedDraft: true,
          exactRetry: true,
          refreshOnly: true,
          conflictPreservesDraft: true,
          explicitAdoption: true,
          failedReloadPreservesDraft: true,
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
      held.splice(0).forEach((release) => release());
      await browser.close();
      await new Promise((done) => server.close(done));
    }
  },
  { personalAssignments: true },
);
