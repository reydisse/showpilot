// Real forms in disposable auth/D1. This rehearsal edits local drafts only.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
const modules = execFileSync("npm", ["root", "-g"], {
  encoding: "utf8",
}).trim();
const { chromium } = createRequire(join(modules, "agent-browser/package.json"))(
  "playwright-core",
);

await withLocalSmokeFixture(
  async ({ origin, orgId, operatorCookie, queryFixture, capturedEmails }) => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    await context.addCookies(
      operatorCookie
        .split("; ")
        .map((part) => ({
          name: part.slice(0, part.indexOf("=")),
          value: part.slice(part.indexOf("=") + 1),
          url: origin,
        })),
    );
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let hold = false,
      release,
      posted = 0;
    await page.route("**/*", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      if (
        request.method() === "POST" &&
        url.pathname.startsWith("/_serverFn/")
      ) {
        posted++;
        if (hold)
          await new Promise((done) => {
            release = done;
          });
        return route.abort().catch(() => {});
      }
      return route.continue();
    });
    const button = (name) => page.getByRole("button", { name, exact: true });
    try {
      await page.goto(`${origin}/${orgId}/production/assets`);
      await page.waitForFunction(() =>
        Object.keys(document.querySelector("aside a") ?? {}).some((key) =>
          key.startsWith("__reactProps$"),
        ),
      );
      await button("Add Item").click();
      await page
        .getByRole("textbox", { name: "Name", exact: true })
        .fill("Unsent asset");
      await button("Add Asset").click();
      await button("Add Asset").waitFor();
      await page.waitForTimeout(200);
      console.log(
        JSON.stringify({
          case: "rejected-create",
          posted,
          visibleErrors: await page.getByRole("alert").allTextContents(),
          unhandled: errors,
          draft: await page
            .getByRole("textbox", { name: "Name", exact: true })
            .inputValue(),
        }),
      );
      hold = true;
      await button("Add Asset").click();
      await page.waitForTimeout(16000);
      console.log(
        JSON.stringify({
          case: "stalled-create",
          posted,
          stillAdding: (await button("Adding...").count()) > 0,
          retryVisible:
            (await page.getByRole("button", { name: /retry/i }).count()) > 0,
          visibleErrors: await page.getByRole("alert").allTextContents(),
        }),
      );
      assert.equal((await queryFixture("SELECT id FROM equipment")).length, 1);
      assert.equal((await capturedEmails()).length, 0);
      await page.screenshot({
        path: "/tmp/showpilot-asset-recovery-before.png",
      });
      console.log(
        JSON.stringify({ baseline: true, noWritesDelivered: true, emails: 0 }),
      );
    } finally {
      release?.();
      await browser.close();
    }
  },
  { operatorInputs: true, captureEmail: true },
);
