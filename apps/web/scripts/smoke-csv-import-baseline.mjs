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
    await page.addInitScript(() => {
      const Reader = window.FileReader;
      window.FileReader = class extends Reader {
        readAsText(file, ...args) {
          if (file.name === "unreadable.csv")
            queueMicrotask(() =>
              this.dispatchEvent(new ProgressEvent("error")),
            );
          else super.readAsText(file, ...args);
        }
      };
    });
    page.on("pageerror", (error) => errors.push(error.message));
    let release,
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
        await new Promise((done) => {
          release = done;
        });
        return route.abort().catch(() => {});
      }
      return route.continue();
    });
    try {
      const before = (await queryFixture("SELECT id FROM crew_member")).length;
      await page.goto(`${origin}/${orgId}/settings?section=people`);
      await page.waitForFunction(() =>
        Object.keys(document.querySelector("aside a") ?? {}).some((key) =>
          key.startsWith("__reactProps$"),
        ),
      );
      const csv = page.getByLabel("Crew CSV", { exact: true });
      await csv.fill(
        "name,email,role\nEarlier draft,earlier@display-smoke.invalid,Camera",
      );
      await page
        .locator("input[type=file]")
        .setInputFiles({
          name: "unreadable.csv",
          mimeType: "text/csv",
          buffer: Buffer.from(
            "name,email,role\nNew file,new@display-smoke.invalid,Audio",
          ),
        });
      console.log(
        JSON.stringify({
          case: "file-read-failure",
          fileButton:
            (await page
              .getByRole("button", { name: "unreadable.csv", exact: true })
              .count()) > 0,
          textarea: await csv.inputValue(),
          visibleAlerts: await page.getByRole("alert").allTextContents(),
          errors,
        }),
      );
      await csv.fill(
        "name,email,role\nUnsent import,unsent@display-smoke.invalid,Camera",
      );
      await page.getByRole("button", { name: "Import", exact: true }).click();
      await page.waitForTimeout(16000);
      console.log(
        JSON.stringify({
          case: "stalled-import",
          posted,
          stillImporting:
            (await page
              .getByRole("button", { name: "Importing...", exact: true })
              .count()) > 0,
          retryVisible:
            (await page.getByRole("button", { name: /retry/i }).count()) > 0,
          visibleAlerts: await page.getByRole("alert").allTextContents(),
        }),
      );
      assert.equal(
        (await queryFixture("SELECT id FROM crew_member")).length,
        before,
      );
      assert.equal((await capturedEmails()).length, 0);
      console.log(
        JSON.stringify({ baseline: true, noWritesDelivered: true, emails: 0 }),
      );
    } finally {
      release?.();
      await browser.close();
    }
  },
  { captureEmail: true },
);
