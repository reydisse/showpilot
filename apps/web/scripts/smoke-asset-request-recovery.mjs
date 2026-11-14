// Real asset commands: lost replies, conflict, review, deletion and read recovery.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
const modules = execFileSync("npm", ["root", "-g"], {
  encoding: "utf8",
}).trim();
const { chromium } = createRequire(join(modules, "agent-browser/package.json"))(
  "playwright-core",
);
const require = createRequire(new URL("../package.json", import.meta.url)),
  router = createRequire(require.resolve("@tanstack/react-router")),
  core = createRequire(router.resolve("@tanstack/router-core"));
const { toJSONAsync, fromJSON, fromCrossJSON } = core("seroval"),
  { defaultSerovalPlugins } = router("@tanstack/router-core");
const ids = {},
  names = ["getEquipmentState", "commandEquipment", "reviewEquipment"];
const assets = resolve(import.meta.dirname, "../dist/server/assets");
for (const file of (await readdir(assets)).filter((file) =>
  file.endsWith(".js"),
)) {
  const source = await readFile(join(assets, file), "utf8");
  for (const name of names)
    ids[name] ??= source.match(
      new RegExp(
        `const ${name}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`,
      ),
    )?.[1];
}
assert.ok(
  names.every((name) => ids[name]),
  JSON.stringify(ids),
);
await withLocalSmokeFixture(
  async ({ origin, orgId, operatorCookie, queryFixture, capturedEmails }) => {
    const browser = await chromium.launch({ headless: true }),
      context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      }),
      page = await context.newPage();
    await context.addCookies(
      operatorCookie.split("; ").map((part) => ({
        name: part.slice(0, part.indexOf("=")),
        value: part.slice(part.indexOf("=") + 1),
        url: origin,
      })),
    );
    await page.addInitScript(() => {
      const now = Date.now.bind(Date);
      Date.now = () => now() + 3600000;
    });
    const errors = [],
      writes = [],
      held = [],
      completed = [];
    let pause = null,
      pauseRead = false;
    page.on("pageerror", (error) => errors.push(error.message));
    const release = () => held.splice(0).forEach((done) => done());
    await page.route("**/*", async (route) => {
      const req = route.request(),
        url = new URL(req.url());
      if (url.origin !== origin) return route.abort();
      if (
        req.method() === "POST" &&
        url.pathname.endsWith(ids.commandEquipment)
      ) {
        const value = { body: req.postData() };
        writes.push(value);
        const hold = pause;
        if (hold === "before") await new Promise((done) => held.push(done));
        const response = await route.fetch();
        completed.push(value);
        if (hold === "after") await new Promise((done) => held.push(done));
        return route.fulfill({ response }).catch(() => {});
      }
      if (url.pathname.endsWith(ids.getEquipmentState) && pauseRead) {
        const response = await route.fetch();
        await new Promise((done) => held.push(done));
        return route.fulfill({ response }).catch(() => {});
      }
      return route.continue();
    });
    const headers = {
      Cookie: operatorCookie,
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      "x-tsr-serverFn": "true",
      "Content-Type": "application/json",
    };
    async function rpc(name, data = { orgId }) {
      const payload = JSON.stringify(await toJSONAsync({ data })),
        url = `${origin}/_serverFn/${ids[name]}`,
        read = name === "getEquipmentState";
      const response = await fetch(
        read ? `${url}?payload=${encodeURIComponent(payload)}` : url,
        { headers, ...(read ? {} : { method: "POST", body: payload }) },
      );
      assert.equal(response.status, 200, await response.clone().text());
      const reply = fromCrossJSON(await response.json(), {
        refs: new Map(),
        plugins: defaultSerovalPlugins,
      });
      assert.equal(reply instanceof Error, false, reply.message);
      assert.equal(reply.error, undefined);
      return reply.result;
    }
    async function change(operation) {
      const state = await rpc("getEquipmentState");
      return rpc("commandEquipment", {
        orgId,
        userId: state.userId,
        requestId: crypto.randomUUID(),
        expiresAt: state.serverTime + 25000,
        operation,
      });
    }
    const button = (name) => page.getByRole("button", { name, exact: true });
    const asset = async () =>
      (
        await queryFixture(
          "SELECT id,notes,revision FROM equipment WHERE id='fixture-asset'",
        )
      )[0];
    const count = async () =>
      (await queryFixture("SELECT id FROM equipment")).length;
    async function wait(check, label) {
      const until = Date.now() + 20000;
      while (!(await check())) {
        assert.ok(Date.now() < until, label);
        await page.waitForTimeout(50);
      }
    }
    async function fits(label, controls) {
      for (const [width, height] of [
        [320, 480],
        [768, 1024],
        [1440, 1000],
      ]) {
        await page.setViewportSize({ width, height });
        await page.evaluate(async () => {
          await new Promise((done) =>
            requestAnimationFrame(() => requestAnimationFrame(done)),
          );
          await Promise.all(
            document
              .getAnimations()
              .filter((a) => a.effect?.getTiming().iterations !== Infinity)
              .map((a) => a.finished.catch(() => {})),
          );
        });
        for (const control of controls) {
          await control.scrollIntoViewIfNeeded();
          const box = await control.boundingBox();
          assert.ok(
            box &&
              box.width >= 44 &&
              box.height >= 44 &&
              box.x >= 0 &&
              box.x + box.width <= width + 1,
            `${label} control fits ${width}: ${JSON.stringify(box)}`,
          );
          await control.click({ trial: true });
        }
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        );
        await page.screenshot({
          path: `/tmp/showpilot-asset-recovery-${label}-${width}.png`,
        });
      }
    }
    async function openCreate(name) {
      await wait(() => button("Add Item").isEnabled(), "Add enabled");
      await button("Add Item").click();
      await page.getByRole("textbox", { name: "Name", exact: true }).fill(name);
    }
    try {
      await page.goto(`${origin}/${orgId}/production/assets`);
      await page.waitForFunction(() =>
        Object.keys(document.querySelector("aside a") ?? {}).some((key) =>
          key.startsWith("__reactProps$"),
        ),
      );
      if (process.argv.includes("--conflict")) {
        await wait(() => button("Add Item").isEnabled(), "inventory ready");
        await button("Edit unit 1").click();
        await page
          .getByLabel("Notes", { exact: true })
          .fill("Unsaved local draft");
        await change({
          kind: "update",
          id: "fixture-asset",
          expectedRevision: 0,
          updates: { notes: "Other operator update" },
        });
        await button("Update").click();
        await button("Continue with current inventory").waitFor();
        await wait(
          () => button("Continue with current inventory").isEnabled(),
          "conflict refreshed",
        );
        assert.equal(
          await page.getByLabel("Notes", { exact: true }).inputValue(),
          "Unsaved local draft",
        );
        assert.equal(
          await page.getByLabel("Notes", { exact: true }).isDisabled(),
          true,
        );
        await button("Continue with current inventory").click();
        assert.equal(
          await page.getByLabel("Notes", { exact: true }).inputValue(),
          "Unsaved local draft",
        );
        await fits("conflict", [button("Load current version")]);
        await button("Load current version").click();
        assert.equal(
          await page.getByLabel("Notes", { exact: true }).inputValue(),
          "Other operator update",
        );
        assert.equal((await asset()).revision, 1);
        await button("Cancel editing Fixture microphone").click();
        assert.deepEqual(errors, []);
        assert.equal((await capturedEmails()).length, 0);
        console.log(
          JSON.stringify({
            passed: true,
            conflictDraftPreserved: true,
            currentVersionRequiresExplicitChoice: true,
            errors,
            emails: 0,
          }),
        );
        return;
      }
      await openCreate("Fixture speaker");
      await page.getByLabel("Number of units", { exact: true }).fill("2");
      pause = "after";
      await button("Add Asset").evaluate((node) => {
        node.click();
        node.click();
      });
      await button("Retry asset change").waitFor({ timeout: 16000 });
      assert.equal(writes.length, 1);
      assert.equal(await count(), 3);
      await fits("create-retry", [
        button("Retry asset change"),
        button("Review asset result"),
      ]);
      await button("Close add asset dialog").click();
      await page.getByRole("link", { name: "Schedule", exact: true }).click();
      await page.waitForURL("**/schedule");
      await page.goBack();
      await button("Retry asset change").waitFor();
      pause = null;
      await button("Retry asset change").click();
      await button("Retry asset change").waitFor({ state: "hidden" });
      await wait(() => button("Add Item").isEnabled(), "create recovered");
      assert.equal(await count(), 3);
      assert.deepEqual(
        fromJSON(JSON.parse(writes[0].body)),
        fromJSON(JSON.parse(writes[1].body)),
      );
      release();
      console.log(
        JSON.stringify({
          case: "create",
          identicalRetry: true,
          retainedAcrossNavigation: true,
          bulkCount: 3,
          noDuplicate: true,
        }),
      );
      await page
        .getByRole("button", { name: "Edit unit 1", exact: true })
        .first()
        .click();
      assert.equal(
        await page.getByLabel("Equipment name", { exact: true }).inputValue(),
        "Fixture microphone",
      );
      await page.getByLabel("Notes", { exact: true }).fill("Original update");
      pause = "after";
      await button("Update").click();
      await button("Retry asset change").waitFor({ timeout: 16000 });
      assert.equal((await asset()).revision, 1);
      await change({
        kind: "update",
        id: "fixture-asset",
        expectedRevision: 1,
        updates: { notes: "Newer operator update" },
      });
      const originalUpdate = writes.at(-1);
      pause = null;
      await button("Retry asset change").click();
      await button("Retry asset change").waitFor({ state: "hidden" });
      await wait(() => button("Add Item").isEnabled(), "update recovered");
      assert.equal((await asset()).notes, "Newer operator update");
      assert.equal((await asset()).revision, 2);
      assert.deepEqual(
        fromJSON(JSON.parse(originalUpdate.body)),
        fromJSON(JSON.parse(writes.at(-1).body)),
      );
      release();
      console.log(
        JSON.stringify({ case: "update", newerRevisionPreserved: true }),
      );
      await openCreate("Must not arrive");
      pause = "before";
      await button("Add Asset").click();
      await button("Retry asset change").waitFor({ timeout: 16000 });
      await button("Review asset result").click();
      await button("Continue with current inventory").waitFor();
      pause = null;
      release();
      await wait(
        () => completed.length === writes.length,
        "cancelled command delivered",
      );
      assert.equal(await count(), 3);
      await wait(
        () => button("Continue with current inventory").isEnabled(),
        "review refresh",
      );
      await button("Continue with current inventory").click();
      assert.equal(
        await page
          .getByRole("textbox", { name: "Name", exact: true })
          .inputValue(),
        "Must not arrive",
      );
      await button("Close add asset dialog").click();
      console.log(
        JSON.stringify({
          case: "review",
          lateArrivalCancelled: true,
          draftRetained: true,
        }),
      );
      await page
        .getByRole("button", { name: "Delete unit 1", exact: true })
        .first()
        .click();
      await page.getByRole("dialog").waitFor();
      await change({
        kind: "update",
        id: "fixture-asset",
        expectedRevision: 2,
        updates: { notes: "Changed during confirmation" },
      });
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Delete", exact: true })
        .click();
      await button("Continue with current inventory").waitFor();
      assert.ok(await asset());
      await wait(
        () => button("Continue with current inventory").isEnabled(),
        "conflict refresh",
      );
      await button("Continue with current inventory").click();
      await page
        .getByRole("button", { name: "Delete unit 1", exact: true })
        .first()
        .click();
      pause = "after";
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Delete", exact: true })
        .click();
      await button("Retry asset change").waitFor({ timeout: 16000 });
      assert.equal(await asset(), undefined);
      pause = null;
      await button("Retry asset change").click();
      await button("Retry asset change").waitFor({ state: "hidden" });
      await wait(() => button("Add Item").isEnabled(), "delete recovered");
      assert.equal(await count(), 2);
      release();
      console.log(
        JSON.stringify({
          case: "delete",
          staleConfirmationRejected: true,
          missingRowRetryRecovered: true,
        }),
      );
      await openCreate("Refresh fixture");
      pauseRead = true;
      await button("Add Asset").click();
      await button("Retry inventory").waitFor({ timeout: 14000 });
      assert.equal(await count(), 3);
      const writesBeforeReadRetry = writes.length;
      await fits("read-retry", [button("Retry inventory")]);
      pauseRead = false;
      await button("Retry inventory").click();
      await button("Retry inventory").waitFor({ state: "hidden" });
      assert.equal(writes.length, writesBeforeReadRetry);
      release();
      assert.deepEqual(errors, []);
      assert.equal((await capturedEmails()).length, 0);
      console.log(
        JSON.stringify({
          passed: true,
          serverClockSkewHandled: true,
          readRetryDoesNotReplayWrite: true,
          errors,
          emails: 0,
        }),
      );
    } finally {
      release();
      await browser.close();
    }
  },
  { operatorInputs: true, captureEmail: true },
);
