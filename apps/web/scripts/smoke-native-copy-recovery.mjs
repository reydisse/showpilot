// Render the exported Expo web app with its native team copy controls/hook. All API traffic is
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
  async ({
    origin,
    orgId,
    operatorCookie,
    configureEmail,
    capturedEmails,
    queryFixture,
  }) => {
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
      const command = url.pathname.endsWith("/schedule/copy-team"),
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
    const wait = async (check) => {
      const end = Date.now() + 20000;
      while (!(await check())) {
        if (Date.now() > end)
          throw new Error("Native browser assertion timed out");
        await new Promise((done) => setTimeout(done, 50));
      }
    };
    async function api(path, body) {
      const response = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      assert.ok(response.ok, await response.clone().text());
      return response.json();
    }
    async function createTarget(name, startTime) {
      return api("/api/mobile/v1/rundowns", {
        orgId,
        requestId: crypto.randomUUID(),
        serviceDate: "2099-01-01",
        name,
        startTime,
      });
    }
    try {
      const target = await createTarget("Copy destination", "22:00");
      await configureEmail("partial-schedule");
      await page.goto(`${nativeOrigin}/schedule?date=2099-01-01`);
      await button("Copy team").click();
      await button("Cancel team copy").click();
      assert.equal(calls.length, 0);
      assert.equal((await capturedEmails()).length, 0);
      await button("Copy team").click();
      mode = "after";
      await button("Copy and invite").click();
      await button("Retry team copy").waitFor({ timeout: 20000 });
      const first = await capturedEmails();
      assert.equal(first.length, 3);
      const uncertain = first.find(
        (email) => email.to === "other@display-smoke.invalid",
      );
      assert.ok(uncertain?.delivered);
      const token = uncertain.html.match(
        /\/crew\/schedule\/([A-Za-z0-9_-]+)/,
      )?.[1];
      assert.ok(token);
      await api(`/api/mobile/v1/schedule/assignments?orgId=${orgId}`, {
        requestId: "native-copy-added-later",
        showId: "assignment-show",
        role: "Added after original copy",
        department: "Production",
        crewMemberId: null,
        callTime: "",
        notes: "",
        expectedUpdatedAt: null,
      });
      mode = "normal";
      failReads = true;
      await button("Retry team copy").click();
      await button("Refresh copied team").waitFor({ timeout: 20000 });
      assert.deepEqual(calls[1], calls[0]);
      const recovered = await capturedEmails();
      assert.equal(recovered.length, 4);
      assert.equal(recovered[3].replayed, true);
      assert.equal(recovered[3].idempotencyKey, uncertain.idempotencyKey);
      assert.ok(recovered[3].html.includes(token));
      assert.equal(
        (
          await queryFixture(
            `SELECT COUNT(*) AS count FROM service_assignment WHERE orgId='display-smoke' AND showId='${target.showId}'`,
          )
        )[0].count,
        3,
      );
      held.splice(0).forEach((done) => done());
      const confirmedCalls = calls.length;
      failReads = false;
      await button("Refresh copied team").click();
      await button("Dismiss copy result").waitFor();
      assert.equal(calls.length, confirmedCalls);
      assert.equal((await capturedEmails()).length, recovered.length);
      assert.equal(await button("Review and copy again").isDisabled(), true);
      await button("Dismiss copy result").click();
      await createTarget("Second copy destination", "23:00");
      await configureEmail("fail");
      await page.reload();
      await button("Copy team").click();
      await button("Copy and invite").click();
      await button("Retry team copy").waitFor();
      assert.equal((await capturedEmails()).length, 7);
      assert.notEqual(calls[2].requestId, calls[0].requestId);
      assert.equal(
        await page
          .getByText(
            "Email was rejected. Retry the same invitation. App invitation available.",
            { exact: true },
          )
          .count(),
        2,
      );
      for (const [width, height] of [
        [320, 568],
        [768, 1024],
        [1440, 1000],
      ]) {
        await page.setViewportSize({ width, height });
        await button("Retry team copy").scrollIntoViewIfNeeded();
        await wait(async () =>
          button("Retry team copy").evaluate((node) => {
            const b = node.getBoundingClientRect(),
              range = document.createRange();
            range.selectNodeContents(node);
            const t = range.getBoundingClientRect();
            return (
              b.height >= 44 &&
              b.width >= 44 &&
              b.left >= 0 &&
              b.right <= innerWidth &&
              b.top >= 0 &&
              b.bottom <= innerHeight &&
              node.contains(
                document.elementFromPoint(
                  b.x + b.width / 2,
                  b.y + b.height / 2,
                ),
              ) &&
              t.left >= b.left &&
              t.right <= b.right &&
              t.top >= b.top &&
              t.bottom <= b.bottom
            );
          }),
        );
        await writeFile(
          `/tmp/showpilot-native-copy-${width}.png`,
          await page.screenshot(),
        );
      }
      await configureEmail("success");
      await button("Retry team copy").click();
      await button("Dismiss copy result").waitFor();
      assert.deepEqual(calls.at(-1), calls[2]);
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          exportedExpoScreen: true,
          actualNativeHook: true,
          cancelledConfirmationSendsNothing: true,
          exactRetry: true,
          stableProviderKeyAndToken: true,
          frozenSourceRoster: true,
          acceptedEmailNotRepeated: true,
          partialResultsVisible: true,
          confirmedCopyRefreshOnly: true,
          nonemptyTargetCannotCopyAgain: true,
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
  { personalAssignments: true, captureEmail: true, paidPlan: true },
);
