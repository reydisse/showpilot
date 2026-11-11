// Anonymous Chrome and compiled Worker: missing orgs are terminal, not outages.
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";

const assets = resolve(import.meta.dirname, "../dist/server/assets");
let accessId;
for (const name of (await readdir(assets)).filter(name => name.endsWith(".js"))) {
  accessId ??= (await readFile(resolve(assets, name), "utf8")).match(/const ensureDisplaySession_createServerFn_handler = createServerRpc\(\{\s*id: "([^"]+)"/)?.[1];
}
assert.ok(accessId, "Build web before checking display links");
await withLocalSmokeFixture(async ({ origin, orgId, pass }) => {
  await withRealBrowser({ origin }, async ({ evaluate, page }) => {
    await page("Page.enable");
    await page("Emulation.setFocusEmulationEnabled", { enabled: true });
    await page("Emulation.setDeviceMetricsOverride", { width: 320, height: 480, deviceScaleFactor: 1, mobile: false });
    await page("Page.addScriptToEvaluateOnNewDocument", { source: `window.displayChecks=0;window.outputReads=[];window.displayErrors=[];
      addEventListener('error',e=>window.displayErrors.push(e.message));addEventListener('unhandledrejection',e=>window.displayErrors.push(String(e.reason)));
      const original=fetch;window.fetch=(input,...rest)=>{const url=input instanceof Request?input.url:String(input);if(url.includes('/_serverFn/${accessId}'))window.displayChecks++;if(url.includes('/api/'))window.outputReads.push(url);return original(input,...rest);};` });
    const text = value => poll(() => evaluate(`document.body?.textContent.includes(${JSON.stringify(value)})`), value);
    for (const surface of ["timer", "overlay"]) {
      await page("Page.navigate", { url: `${origin}/${surface}/missing-fixture-org` });
      await text("Organization not found");
      assert.equal(await evaluate("window.displayChecks"), 1);
      await new Promise(resolve => setTimeout(resolve, 31_000));
      assert.equal(await evaluate("window.displayChecks"), 1, "Missing organization must not poll for authorization");
      assert.deepEqual(await evaluate("window.outputReads"), [], "Unknown organization must not fetch protected data");
      assert.deepEqual(await evaluate("window.displayErrors"), []);
      assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
      const screenshot = await page("Page.captureScreenshot", { format: "png" });
      await writeFile(`/tmp/showpilot-${surface}-not-found-320.png`, Buffer.from(screenshot.data, "base64"));
      await evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent==='Try again').click();true");
      await poll(() => evaluate("window.displayChecks === 2"), "explicit missing-link Retry");
      await text("Organization not found");

      await page("Page.navigate", { url: `${origin}/${surface}/${"x".repeat(129)}` });
      await text("Organization not found");
      assert.equal(await evaluate("window.displayChecks"), 0, "Malformed route never calls authority");
      await page("Page.navigate", { url: `${origin}/${surface}/${orgId}?displayPass=invalid` });
      await text("This display needs a valid link");
      assert.equal(await evaluate("document.body.textContent.includes('Organization not found')"), false);
      assert.deepEqual(await evaluate("window.outputReads"), []);
      await page("Page.navigate", { url: `${origin}/${surface}/${orgId}?displayPass=${pass(surface)}&view=stage` });
      await text(surface === "timer" ? "Fixture private stage message" : "Fixture overlay title");
      assert.equal(await evaluate("new URL(location.href).searchParams.has('displayPass')"), false);
      assert.deepEqual(await evaluate("window.displayErrors"), []);
    }
    console.log(JSON.stringify({ passed: true, surfaces: ["timer", "overlay"], missingOrgStopsPolling: true, malformedSlugSkipsRequests: true, invalidPassStillDenied: true, validPassStillDisplays: true, width: 320 }));
  });
});
