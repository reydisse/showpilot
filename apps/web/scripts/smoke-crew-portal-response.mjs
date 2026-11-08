// Public invitation in compiled Chrome against disposable D1, with local-only email capture.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll } from "./real-browser-fixture.mjs";
const require = createRequire(new URL("../package.json", import.meta.url));
const router = createRequire(require.resolve("@tanstack/react-router"));
const core = createRequire(router.resolve("@tanstack/router-core"));
const { fromJSON, fromCrossJSON } = core("seroval");
const { defaultSerovalPlugins } = router("@tanstack/router-core");
const modules = execFileSync("npm", ["root", "-g"], {
  encoding: "utf8",
}).trim();
const { chromium } = createRequire(join(modules, "agent-browser/package.json"))(
  "playwright-core",
);
const names = [
    "getCrewSchedulePortal",
    "respondToCrewScheduleInvite",
    "reviewCrewScheduleResponse",
  ],
  ids = {};
const assets = resolve(import.meta.dirname, "../dist/server/assets");
for (const file of (await readdir(assets)).filter((file) =>
  file.endsWith(".js"),
)) {
  const source = await readFile(resolve(assets, file), "utf8");
  for (const name of names)
    ids[name] ??= source.match(
      new RegExp(
        `const ${name}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`,
      ),
    )?.[1];
}
assert.ok(
  names.every((name) => ids[name]),
  "Compiled public RPCs exist",
);
await withLocalSmokeFixture(
  async ({ origin, orgId, operatorCookie, capturedEmails, queryFixture }) => {
    const invitation = await fetch(
      `${origin}/api/mobile/v1/schedule/reminders?orgId=${orgId}`,
      {
        method: "POST",
        headers: {
          Cookie: operatorCookie,
          Origin: origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          orgId,
          userId: "smoke-operator",
          requestId: crypto.randomUUID(),
          target: { kind: "assignment", id: "assignment-accept" },
        }),
      },
    );
    assert.equal(invitation.status, 200, await invitation.clone().text());
    const emails = await capturedEmails();
    const token = emails
      .find((email) => email.to === "operator@display-smoke.invalid")
      ?.html.match(/\/crew\/schedule\/([A-Za-z0-9_-]+)/)?.[1];
    assert.ok(token);
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    const errors = [],
      calls = [],
      reviews = [],
      deliveries = [],
      held = [];
    let mode = "normal",
      failReads = false;
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/_serverFn/**", async (route) => {
      const request = route.request(),
        url = new URL(request.url()),
        body = request.postData();
      const command = url.pathname.endsWith(ids.respondToCrewScheduleInvite);
      const review = url.pathname.endsWith(ids.reviewCrewScheduleResponse);
      if (
        !command &&
        !review &&
        !url.pathname.endsWith(ids.getCrewSchedulePortal)
      )
        return route.continue();
      if (!command && !review && failReads)
        return route.fulfill({
          status: 503,
          contentType: "text/plain",
          body: "Fixture schedule read failed",
        });
      const decoded = body ? fromJSON(JSON.parse(body)).data : null;
      if (command) calls.push(decoded);
      if (review) reviews.push(decoded);
      const delivery = mode;
      if (command && delivery === "before")
        await new Promise((done) => held.push(done));
      const result = await fetch(request.url(), {
        method: request.method(),
        headers: {
          Origin: origin,
          "x-tsr-serverFn": "true",
          "Content-Type": "application/json",
        },
        ...(body ? { body } : {}),
      });
      const bytes = Buffer.from(await result.arrayBuffer());
      if (command || review)
        deliveries.push({
          command: decoded,
          reply: fromCrossJSON(JSON.parse(bytes), {
            refs: new Map(),
            plugins: defaultSerovalPlugins,
          }),
        });
      if (command && delivery === "after")
        await new Promise((done) => held.push(done));
      await route
        .fulfill({
          status: result.status,
          headers: Object.fromEntries(
            [...result.headers].filter(
              ([name]) =>
                !["content-encoding", "content-length"].includes(name),
            ),
          ),
          body: bytes,
        })
        .catch(() => {});
    });
    const button = (name) => page.getByRole("button", { name, exact: true });
    const assignment = async (id) =>
      (
        await queryFixture(
          `SELECT status,responseNote FROM service_assignment WHERE orgId='display-smoke' AND id='${id}'`,
        )
      )[0];
    async function widths(kind, controls) {
      for (const [width, height] of [
        [320, 480],
        [768, 1024],
        [1440, 1000],
      ]) {
        await page.setViewportSize({ width, height });
        for (const name of controls) {
          await button(name).scrollIntoViewIfNeeded();
          const box = await button(name).boundingBox();
          assert.ok(
            box &&
              box.height >= 44 &&
              box.x >= 0 &&
              box.x + box.width <= width + 1,
            `${name} reachable at ${width}`,
          );
        }
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        );
        await page.screenshot({
          path: `/tmp/showpilot-crew-portal-${kind}-${width}.png`,
          fullPage: true,
        });
      }
    }
    try {
      await page.goto(`${origin}/crew/schedule/${token}`);
      await button("Accept assignment").waitFor();
      assert.equal(
        (await page.context().cookies()).some((cookie) =>
          cookie.name.includes("session_token"),
        ),
        false,
        "Invitation needs no authenticated cookie",
      );
      assert.equal(await page.getByText("Private other assignment").count(), 0);
      // Retain the decline note while switching duties, including Back.
      await page.getByRole("button", { name: /Audio operator/ }).click();
      await button("I’m not available").click();
      const note = page.getByRole("textbox", { name: "Optional note" });
      await note.fill("Unavailable after rehearsal, please keep this note.");
      await button("Back").click();
      await button("I’m not available").click();
      assert.equal(
        await note.inputValue(),
        "Unavailable after rehearsal, please keep this note.",
      );
      await page.getByRole("button", { name: /Camera operator/ }).click();
      mode = "after";
      failReads = true;
      await button("Accept assignment").click();
      await poll(
        () => held.length === 1,
        "response committed before lost reply",
      );
      assert.equal((await assignment("assignment-accept")).status, "confirmed");
      await button("Retry original response").waitFor({ timeout: 20000 });
      await widths("unknown", [
        "Retry original response",
        "Review original response",
      ]);
      mode = "normal";
      await button("Retry original response").click();
      await button("Refresh assignments only").waitFor();
      assert.deepEqual(calls[1], calls[0]);
      assert.ok(
        await page
          .getByText("Your response was saved.", { exact: true })
          .isVisible(),
      );
      assert.equal(await button("Retry original response").count(), 0);
      await widths("refresh", ["Refresh assignments only"]);
      failReads = false;
      await button("Refresh assignments only").click();
      await button("Finish response").waitFor();
      assert.equal(calls.length, 2, "Refresh never repeats a mutation");
      held.splice(0).forEach((release) => release());
      await button("Finish response").click();
      await page
        .getByRole("button", { name: /^Resume response: Audio operator/ })
        .click();
      assert.equal(
        await note.inputValue(),
        "Unavailable after rehearsal, please keep this note.",
      );
      // Cancel before an undelivered response reaches D1, then edit as a new request.
      mode = "before";
      await button("Send decline").click();
      await poll(() => held.length === 1, "request held before D1");
      await button("Review original response").waitFor({ timeout: 20000 });
      assert.equal(await note.getAttribute("readonly"), "");
      await button("Review original response").click();
      await button("Edit cancelled response").waitFor();
      assert.deepEqual(reviews[0], calls[2]);
      mode = "normal";
      held.splice(0).forEach((release) => release());
      await poll(
        () => deliveries.length === 4,
        "late cancelled request reached D1",
      );
      assert.equal((await assignment("assignment-decline")).status, "assigned");
      assert.equal(deliveries[3].reply.result.outcome, "cancelled");
      await widths("cancelled", [
        "Edit cancelled response",
        "Discard response draft…",
      ]);
      await button("Edit cancelled response").click();
      assert.equal(
        await note.inputValue(),
        "Unavailable after rehearsal, please keep this note.",
      );
      await note.fill("Revised note after cancellation");
      await button("Send decline").click();
      await button("Finish response").waitFor();
      assert.notEqual(calls[3].requestId, calls[2].requestId);
      assert.deepEqual(await assignment("assignment-decline"), {
        status: "declined",
        responseNote: "Revised note after cancellation",
      });
      assert.equal(new URL(page.url()).search, "");
      assert.equal(
        (
          await queryFixture(
            "SELECT COUNT(*) AS count FROM crew_assignment_response",
          )
        ).at(0).count,
        3,
      );
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          result: "pass",
          anonymous: true,
          noteRetention: true,
          lostReplyRetry: true,
          refreshOnly: true,
          cancellationBeforeLateWrite: true,
          freshRequestAfterCancellation: true,
          widths: [320, 768, 1440],
          runtimeErrors: errors,
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          body: await page.locator("body").innerText(),
          errors,
          calls,
          reviews,
          deliveries,
        }),
      );
      throw error;
    } finally {
      held.splice(0).forEach((release) => release());
      await browser.close();
    }
  },
  { personalAssignments: true, captureEmail: true },
);
