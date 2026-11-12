// Render the exported Expo web app with the native crew roster editor. All API traffic is
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
      failRoster = true,
      failProfile = false;
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", async (route) => {
      const request = route.request(),
        url = new URL(request.url()),
        body = request.postData();
      if (!url.pathname.startsWith("/api/"))
        return url.origin === nativeOrigin ? route.continue() : route.abort();
      const headers = {
        "content-type": "application/json",
        "access-control-allow-origin": nativeOrigin,
        "access-control-allow-credentials": "true",
      };
      if (
        request.method() === "GET" &&
        ((failRoster && url.pathname === "/api/mobile/v1/team/crew") ||
          (failProfile && url.pathname === "/api/mobile/v1/team/crew/profile"))
      )
        return route.fulfill({
          status: 503,
          headers,
          body: JSON.stringify({ error: "Fixture crew read failed" }),
        });
      const command = url.pathname === "/api/mobile/v1/team/crew/command",
        review = url.pathname === "/api/mobile/v1/team/crew/review",
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
    const wait = async (check, label) => {
      const end = Date.now() + 20000;
      while (!(await check())) {
        if (Date.now() > end) throw new Error(`Timed out: ${label}`);
        await new Promise((done) => setTimeout(done, 50));
      }
    };
    async function api(path, data) {
      const response = await fetch(
        `${origin}/api/mobile/v1/team/crew${path}${data ? `?orgId=${encodeURIComponent(orgId)}` : ""}`,
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
    const roster = () => api(`?orgId=${orgId}`);
    async function fill(name, badge) {
      await field("Crew member ID").fill(badge);
      await field("Crew member name").fill(name);
      await page
        .getByRole("radio", { name: "Camera Operator", exact: true })
        .click();
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
          path: `/tmp/showpilot-native-crew-${kind}-${width}.png`,
          fullPage: true,
        });
      }
    }
    const longName = "Long crew member name ".repeat(9).trim();
    try {
      await api("/command", {
        orgId,
        userId: "smoke-operator",
        requestId: crypto.randomUUID(),
        kind: "create",
        memberId: "BADGE".repeat(25),
        name: longName,
        role: "Camera Operator",
        email: "",
        photoUrl: "",
      });
      await page.goto(`${nativeOrigin}/operations`);
      await page.getByRole("button", { name: /Crew roster/ }).click();
      await button("Retry crew roster").waitFor();
      assert.equal(await button("Add").isEnabled(), false);
      failRoster = false;
      await button("Retry crew roster").click();
      await wait(() => button("Add").isEnabled(), "roster recovered");
      await widths("roster", ["Add", `Edit ${longName}`, `Remove ${longName}`]);
      await button("Add").click();
      await fill("Retained operator", "RETAIN42");
      await button("Close crew member form").click();
      await button("Back to operations").click();
      await page.getByRole("button", { name: /Crew roster/ }).click();
      await button("Resume crew change: Retained operator").click();
      assert.equal(
        await field("Crew member name").inputValue(),
        "Retained operator",
      );
      await button("Discard crew draft…").click();
      await button("Keep draft").click();
      mode = "after";
      failRoster = true;
      await button("Add crew member").click();
      await wait(() => held.length === 1, "create saved with lost reply");
      assert.equal(
        (await roster()).members.filter((row) => row.memberId === "RETAIN42")
          .length,
        1,
      );
      await button("Close crew member form").click();
      await button("Resume crew change: Retained operator").click();
      await button("Retry original crew change").waitFor({ timeout: 20000 });
      assert.equal(await field("Crew member name").isEditable(), false);
      await widths("unknown", [
        "Retry original crew change",
        "Review original crew change",
        "Close crew member form",
      ]);
      mode = "normal";
      await button("Retry original crew change").click();
      await button("Refresh roster only").waitFor();
      assert.deepEqual(calls[1], calls[0]);
      await widths("refresh", ["Refresh roster only"]);
      failRoster = false;
      await button("Refresh roster only").click();
      await button("Finish crew change").waitFor();
      assert.equal(calls.length, 2);
      held.splice(0).forEach((done) => done());
      await button("Finish crew change").click();

      // An undelivered create must remain cancelled after Review and late delivery.
      await button("Add").click();
      await fill("Cancelled operator", "CANCEL42");
      mode = "before";
      await button("Add crew member").click();
      await wait(() => held.length === 1, "create held before delivery");
      await button("Review original crew change").waitFor({ timeout: 20000 });
      mode = "normal";
      await button("Review original crew change").click();
      await button("Edit cancelled crew change").waitFor();
      assert.equal(deliveries.at(-1).result.outcome, "cancelled");
      assert.deepEqual(calls.at(-1).command, calls.at(-2).command);
      await widths("cancelled", [
        "Edit cancelled crew change",
        "Discard crew draft…",
      ]);
      const delivered = deliveries.length;
      held.splice(0).forEach((done) => done());
      await wait(
        () => deliveries.length > delivered,
        "late cancelled delivery",
      );
      assert.equal(deliveries.at(-1).result.outcome, "cancelled");
      assert.equal(
        (await roster()).members.filter((row) => row.memberId === "CANCEL42")
          .length,
        0,
      );
      await button("Edit cancelled crew change").click();
      await field("Crew member name").fill("Reviewed operator");
      await button("Add crew member").click();
      await button("Finish crew change").waitFor();
      assert.notEqual(
        calls.at(-1).command.requestId,
        calls.at(-2).command.requestId,
      );
      await button("Finish crew change").click();

      // A concurrent edit keeps the original draft until explicit adoption.
      await button("Edit Retained operator").click();
      await field("Crew member name").fill("My conflicting draft");
      const row = (await roster()).members.find(
        (row) => row.memberId === "RETAIN42",
      );
      const { memberId, role, email, photoUrl } = row;
      await api("/command", {
        orgId,
        userId: "smoke-operator",
        requestId: crypto.randomUUID(),
        kind: "update",
        id: row.id,
        expectedRevision: row.profileRevision,
        memberId,
        role,
        email,
        photoUrl,
        name: "Another operator",
      });
      await button("Update crew member").click();
      await button("Review original crew change").waitFor();
      assert.equal(
        await field("Crew member name").inputValue(),
        "My conflicting draft",
      );
      await button("Review original crew change").click();
      await button("Edit cancelled crew change").waitFor();
      await button("Load current crew profile…").click();
      await button("Keep draft").click();
      assert.equal(
        await field("Crew member name").inputValue(),
        "My conflicting draft",
      );
      failProfile = true;
      await button("Load current crew profile…").click();
      await button("Replace with current profile").click();
      await page
        .getByText("Fixture crew read failed", { exact: true })
        .waitFor();
      assert.equal(
        await field("Crew member name").inputValue(),
        "My conflicting draft",
      );
      failProfile = false;
      await button("Load current crew profile…").click();
      await button("Replace with current profile").click();
      await wait(
        async () =>
          (await field("Crew member name").inputValue()) === "Another operator",
        "adopted current profile",
      );
      await field("Crew member name").fill("Final operator");
      await button("Update crew member").click();
      await button("Finish crew change").waitFor();
      assert.equal(
        calls.at(-1).command.expectedRevision,
        row.profileRevision + 1,
      );
      await button("Finish crew change").click();

      // Delete needs confirmation and stays recoverable after the row is gone.
      await button("Remove Final operator").click();
      const beforeDelete = calls.length;
      await button("Remove crew member…").click();
      await button("Keep crew member").click();
      assert.equal(calls.length, beforeDelete);
      await button("Remove crew member…").click();
      await widths("delete", ["Remove crew member", "Keep crew member"]);
      mode = "after";
      await button("Remove crew member").click();
      await wait(() => held.length === 1, "removal saved with lost reply");
      assert.equal(
        (await roster()).members.some((member) => member.id === row.id),
        false,
      );
      await button("Close crew member form").click();
      await button("Resume crew change: Final operator").click();
      await button("Retry original crew change").waitFor({ timeout: 20000 });
      mode = "normal";
      await button("Retry original crew change").click();
      await button("Finish crew change").waitFor();
      assert.deepEqual(calls.at(-1), calls.at(-2));
      held.splice(0).forEach((done) => done());
      await button("Finish crew change").click();
      assert.equal(
        await button("Resume crew change: Final operator").count(),
        0,
      );
      await button("Add").click();
      await fill("Discard me", "DISCARD");
      await button("Discard crew draft…").click();
      await button("Discard draft").click();
      await button("Add").click();
      assert.equal(await field("Crew member name").inputValue(), "");
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          result: "pass",
          initialReadRecovery: true,
          navigationRetainsDraft: true,
          exactCreateAndDeleteRetry: true,
          refreshOnly: true,
          cancelBeforeDelivery: true,
          staleRevisionPreservesDraft: true,
          explicitAdoption: true,
          failedReadKeepsDraft: true,
          confirmedDeleteAndDiscard: true,
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
      await browser.close();
      await new Promise((done) => server.close(done));
    }
  },
  { personalAssignments: true },
);
