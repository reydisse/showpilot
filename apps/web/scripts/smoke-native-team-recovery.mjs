// Render the exported Expo web app with its native team-builder/hook. All API traffic is
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
    queryFixture,
    configureEmail,
    capturedEmails,
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
      const command = url.pathname.endsWith("/assignments/command"),
        delivery = mode;
      if (command) calls.push(JSON.parse(body));
      const delayed =
        command &&
        JSON.parse(body).operation.fields.crewMemberId ===
          "assignment-other-crew";
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
        if (delayed && delivery === "after")
          await new Promise((done) => held.push(done));
        await route.fulfill(response).catch(() => {});
      };
      if (delayed && delivery === "before")
        await new Promise((done) => held.push(done));
      await deliver();
    });
    const button = (name) => page.getByRole("button", { name, exact: true });
    const open = async () => {
      await button("Team").first().click();
      await page.getByLabel("Team or department", { exact: true }).waitFor();
    };
    const selectTeam = async (department) => {
      await open();
      await page.getByLabel("Team or department").fill(department);
      await page.getByRole("checkbox", { name: /Fixture operator/ }).click();
      await page.getByRole("checkbox", { name: /Other crew/ }).click();
      await page.getByLabel("Role for Fixture operator").fill("Expo camera");
      await page.getByLabel("Role for Other crew").fill("Expo audio");
    };
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
        "SELECT id,role,department FROM service_assignment WHERE orgId='display-smoke' AND role LIKE 'Expo %'",
      );
    try {
      await page.goto(`${nativeOrigin}/schedule?date=2099-01-01`);
      await selectTeam("Expo broadcast");
      await button("Close Build a team").click();
      await page
        .getByRole("button", { name: /^Resume team: Expo broadcast/ })
        .click();
      assert.equal(
        await page.getByLabel("Role for Fixture operator").inputValue(),
        "Expo camera",
      );
      await button("Create team and send 2 invitations").click();
      await button("Cancel team creation").click();
      assert.equal(calls.length, 0);
      assert.equal((await capturedEmails()).length, 0);
      await configureEmail("partial-schedule");
      mode = "after";
      await button("Create team and send 2 invitations").click();
      await button("Create reviewed team").click();
      await button("Retry unresolved team positions").waitFor({
        timeout: 20000,
      });
      assert.equal(
        await page.getByLabel("Team or department").isEditable(),
        false,
      );
      assert.ok(
        await page.getByText("Position saved.", { exact: true }).count(),
      );
      assert.ok(
        await page
          .getByText("Position save is unconfirmed.", { exact: true })
          .count(),
      );
      const first = await capturedEmails();
      assert.equal(first.length, 2);
      const uncertain = first.find(
        (email) => email.to === "other@display-smoke.invalid",
      );
      const token = uncertain.html.match(
        /\/crew\/schedule\/([A-Za-z0-9_-]+)/,
      )?.[1];
      assert.ok(token);
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
          "Retry unresolved team positions",
          "Review original team requests",
          "Close Build a team",
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
        await button(
          "Retry unresolved team positions",
        ).scrollIntoViewIfNeeded();
        await writeFile(
          `/tmp/showpilot-native-team-${width}.png`,
          await page.screenshot(),
        );
      }
      mode = "normal";
      failReads = true;
      await configureEmail("success");
      await button("Retry unresolved team positions").click();
      await button("Refresh team schedule").waitFor({ timeout: 20000 });
      assert.equal(calls.length, 3);
      assert.deepEqual(
        calls[2],
        calls.find(
          (call) =>
            call.operation.fields.crewMemberId === "assignment-other-crew",
        ),
      );
      const recovered = await capturedEmails();
      assert.equal(recovered.length, 3);
      assert.equal(recovered[2].idempotencyKey, uncertain.idempotencyKey);
      assert.equal(recovered[2].replayed, true);
      assert.ok(recovered[2].html.includes(token));
      assert.equal((await rows()).length, 2);
      const beforeRefresh = calls.length;
      failReads = false;
      await button("Refresh team schedule").click();
      await button("Finish team and close").waitFor();
      assert.equal(calls.length, beforeRefresh);
      assert.equal((await capturedEmails()).length, 3);
      held.splice(0).forEach((done) => done());
      await button("Finish team and close").click();
      await wait(
        async () =>
          (await page
            .getByRole("button", { name: /^Resume team: Expo broadcast/ })
            .count()) === 0,
      );
      await selectTeam("Expo second team");
      mode = "before";
      await button("Create team and send 2 invitations").click();
      await button("Create reviewed team").click();
      await button("Review original team requests").waitFor({ timeout: 20000 });
      const cancelled = calls.at(-1);
      assert.equal(
        cancelled.operation.fields.crewMemberId,
        "assignment-other-crew",
      );
      await button("Review original team requests").click();
      await button("Edit unapplied positions").click();
      assert.equal(
        await page.getByLabel("Role for Fixture operator").count(),
        0,
      );
      assert.equal(
        await page.getByLabel("Role for Other crew").inputValue(),
        "Expo audio",
      );
      mode = "normal";
      held.splice(0).forEach((done) => done());
      await page.getByLabel("Role for Other crew").fill("Expo reviewed audio");
      await button("Create team and send 1 invitation").click();
      await button("Create reviewed team").click();
      await button("Finish team and close").waitFor();
      assert.notEqual(calls.at(-1).requestId, cancelled.requestId);
      assert.equal((await rows()).length, 4);
      assert.equal((await capturedEmails()).length, 5);
      assert.equal(
        (
          await queryFixture(
            `SELECT outcome FROM schedule_assignment_request WHERE orgId='display-smoke' AND requestId='${cancelled.requestId}'`,
          )
        )[0].outcome,
        "conflict",
      );
      await button("Finish team and close").click();
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          exportedExpoTeamBuilder: true,
          retainedSelection: true,
          cancelSendsNothing: true,
          partialResultsVisible: true,
          onlyUnresolvedRetried: true,
          stableProviderKeyAndToken: true,
          acceptedEmailNotRepeated: true,
          refreshOnly: true,
          reviewFencesLateRequest: true,
          editsOnlyUnappliedRows: true,
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
