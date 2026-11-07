// Actual Settings, Companion writes and kiosk display polling in a disposable org.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";
const require = createRequire(new URL("../package.json", import.meta.url));
const router = createRequire(require.resolve("@tanstack/react-router"));
const core = createRequire(router.resolve("@tanstack/router-core"));
const { toJSONAsync, fromJSON, fromCrossJSON } = core("seroval");
const { defaultSerovalPlugins } = router("@tanstack/router-core");
const ids = {},
  names = [
    "getKioskBlankState",
    "setKioskBlankState",
    "createKioskToken",
    "createCompanionToken",
  ];
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
assert.ok(names.every((name) => ids[name]));
await withLocalSmokeFixture(
  async ({
    origin,
    orgId,
    operatorCookie,
    stopServer,
    queryFixture,
    capturedEmails,
  }) => {
    async function rpc(name, data) {
      const payload = JSON.stringify(
        await toJSONAsync({ data: { orgId, ...data } }),
      );
      const response = await fetch(`${origin}/_serverFn/${ids[name]}`, {
        method: "POST",
        headers: {
          Cookie: operatorCookie,
          Origin: origin,
          "Sec-Fetch-Site": "same-origin",
          "x-tsr-serverFn": "true",
          "Content-Type": "application/json",
        },
        body: payload,
      });
      assert.equal(response.status, 200);
      const reply = fromCrossJSON(await response.json(), {
        refs: new Map(),
        plugins: defaultSerovalPlugins,
      });
      assert.equal(reply.error, undefined);
      assert.equal(reply instanceof Error, false);
      return reply.result;
    }
    const kiosk = await rpc("createKioskToken", {
      label: "Fixture display",
      view: "board",
      expiresInDays: 1,
    });
    const companion = await rpc("createCompanionToken", {
      label: "Fixture controller",
      expiresInDays: 1,
    });
    const kioskHeaders = { Authorization: `Bearer ${kiosk.token}` };
    const displayed = async () => {
      const response = await fetch(`${origin}/api/v1/kiosk/display`, {
        headers: kioskHeaders,
      });
      assert.equal(response.status, 200);
      return (await response.json()).blanked;
    };
    const restore = async () => {
      const response = await fetch(`${origin}/api/v1/companion/kiosk/blank`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${companion.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ blanked: false }),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).ok, true);
    };
    await withRealBrowser(
      { origin, cookie: operatorCookie },
      async ({ page, evaluate }) => {
        await page("Page.enable");
        await page("Emulation.setFocusEmulationEnabled", { enabled: true });
        await page("Emulation.setDeviceMetricsOverride", {
          width: 1440,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await page("Page.addScriptToEvaluateOnNewDocument", {
          source: `
      window.kioskCalls=[];window.kioskErrors=[];window.holdKioskReads=true;window.holdKioskWrites=true;window.kioskReplies=[];
      addEventListener('error',e=>window.kioskErrors.push(e.message));addEventListener('unhandledrejection',e=>window.kioskErrors.push(String(e.reason)));
      const original=fetch;window.fetch=async(input,options)=>{
        const url=input instanceof Request?input.url:String(input),read=url.includes('/_serverFn/${ids.getKioskBlankState}'),write=url.includes('/_serverFn/${ids.setKioskBlankState}');
        if(write)window.kioskCalls.push(options.body);
        const response=await original(input,options);
        if((read&&window.holdKioskReads)||(write&&window.holdKioskWrites)){const body=await response.text();return new Promise(resolve=>window.kioskReplies.push(()=>resolve(new Response(body,{status:response.status,headers:response.headers}))));}
        return response;
      };`,
        });
        const check = (expression, label) =>
          poll(() => evaluate(expression), label).catch(async (error) => {
            console.log(
              JSON.stringify({
                label,
                body: await evaluate("document.body?.innerText"),
                errors: await evaluate("window.kioskErrors"),
              }),
            );
            throw error;
          });
        const click = async (name) => {
          const box = await check(
            `(async()=>{const n=[...document.querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(name)}&&!n.disabled);if(!n)return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`,
            "clickable " + name,
          );
          await page("Input.dispatchMouseEvent", {
            type: "mousePressed",
            button: "left",
            clickCount: 1,
            ...box,
          });
          await page("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            button: "left",
            clickCount: 1,
            ...box,
          });
        };
        const browserDisplay = () =>
          evaluate(
            `fetch('/api/v1/kiosk/display',{headers:${JSON.stringify(kioskHeaders)}}).then(r=>r.json()).then(r=>r.blanked)`,
          );
        await page("Page.navigate", {
          url: `${origin}/${orgId}/settings?section=kiosk`,
        });
        await check(
          `!!document.body&&[...document.querySelectorAll('h1')].some(n=>n.textContent==='Kiosk Displays')`,
          "kiosk section",
        );
        await check(
          `Object.keys(document.querySelector('button')??{}).some(k=>k.startsWith('__reactProps'))`,
          "hydration",
        );
        assert.equal(
          await evaluate(
            `[...document.querySelectorAll('button')].find(n=>n.textContent==='Blank all displays').disabled`,
          ),
          true,
        );
        await check(
          `[...document.querySelectorAll('button')].some(n=>n.textContent==='Retry display state')`,
          "bounded unknown display read",
        );
        assert.equal(await evaluate("window.kioskCalls.length"), 0);
        await evaluate("window.holdKioskReads=false");
        await click("Retry display state");
        await check(
          `[...document.querySelectorAll('button')].some(n=>n.textContent==='Blank all displays'&&!n.disabled)`,
          "confirmed initial state",
        );
        assert.equal(await browserDisplay(), false);
        await click("Blank all displays");
        await check(
          `!!document.querySelector('[role="dialog"]')`,
          "blanking confirmation",
        );
        for (const width of [320, 768, 1440]) {
          await page("Emulation.setDeviceMetricsOverride", {
            width,
            height: 900,
            deviceScaleFactor: 1,
            mobile: false,
          });
          await check(
            `document.querySelector('[role="dialog"]').getAnimations({subtree:true}).every(a=>a.playState==='finished')`,
            "settled confirmation",
          );
          assert.equal(
            await evaluate(
              `(()=>{const d=document.querySelector('[role="dialog"]'),r=d.getBoundingClientRect();return d.scrollWidth<=d.clientWidth+1&&[...d.querySelectorAll('button')].every(n=>{const b=n.getBoundingClientRect();return b.width>=44&&b.height>=44&&b.x>=r.x&&b.right<=r.right;});})()`,
            ),
            true,
          );
          if (width === 320)
            await writeFile(
              "/tmp/showpilot-kiosk-blank-320.png",
              Buffer.from(
                (await page("Page.captureScreenshot", { format: "png" })).data,
                "base64",
              ),
            );
        }
        await click("Cancel");
        assert.equal(await evaluate("window.kioskCalls.length"), 0);
        assert.equal(await displayed(), false);
        await click("Blank all displays");
        await click("Blank displays");
        await poll(() => displayed(), "actual kiosk flag blanked");
        assert.equal(
          await browserDisplay(),
          true,
          "Kiosk polling must not serve a cached pre-command display state",
        );
        await restore();
        assert.equal(await displayed(), false);
        assert.equal(await browserDisplay(), false);
        await check(
          `[...document.querySelectorAll('button')].some(n=>n.textContent==='Retry display command')`,
          "bounded lost command reply",
        );
        await click("Notifications");
        await check(
          `[...document.querySelectorAll('h1')].some(n=>n.textContent==='Notifications')`,
          "navigate away",
        );
        await click("Kiosk Displays");
        await check(
          `[...document.querySelectorAll('button')].some(n=>n.textContent==='Retry display command')`,
          "retained command across navigation",
        );
        await evaluate("window.holdKioskWrites=false");
        await click("Retry display command");
        await check(
          `document.body.textContent.includes('another controller changed the display setting')`,
          "superseded command is explicit",
        );
        const calls = (await evaluate("window.kioskCalls")).map((body) =>
          fromJSON(JSON.parse(body)),
        );
        assert.equal(calls.length, 2);
        assert.deepEqual(calls[0], calls[1]);
        assert.equal(await displayed(), false);
        await evaluate(
          "window.kioskReplies.splice(0).forEach(release=>release())",
        );
        await click("Blank all displays");
        await click("Blank displays");
        await check(
          `[...document.querySelectorAll('button')].some(n=>n.textContent==='Restore displays'&&!n.disabled)`,
          "new confirmed command",
        );
        assert.equal(await browserDisplay(), true);
        await click("Restore displays");
        await check(
          `[...document.querySelectorAll('button')].some(n=>n.textContent==='Blank all displays'&&!n.disabled)`,
          "restore acknowledged",
        );
        assert.equal(
          await evaluate(`!!document.querySelector('[role="dialog"]')`),
          false,
        );
        assert.equal(await browserDisplay(), false);
        assert.deepEqual(await evaluate("window.kioskErrors"), []);
        assert.equal(await evaluate("window.kioskCalls.length"), 4);
      },
    );
    await stopServer();
    assert.deepEqual(
      await queryFixture(
        `SELECT value FROM app_setting WHERE orgId='${orgId}' AND key='kiosk_blanked'`,
      ),
      [{ value: "false" }],
    );
    assert.equal(
      (
        await queryFixture(
          `SELECT id FROM app_setting WHERE orgId='${orgId}' AND key LIKE 'kiosk-display-command:%'`,
        )
      ).length,
      3,
    );
    assert.deepEqual(
      await queryFixture(
        "SELECT id FROM app_setting WHERE orgId='display-other' AND key LIKE 'kiosk%'",
      ),
      [],
    );
    assert.equal((await capturedEmails()).length, 0);
    console.log(
      JSON.stringify({
        passed: true,
        confirmation: true,
        cancelSendsNothing: true,
        boundedRead: true,
        exactRetryAcrossNavigation: true,
        companionRestoreKept: true,
        kioskPollingFresh: true,
        widths: [320, 768, 1440],
        receipts: 3,
        externalEmail: 0,
      }),
    );
  },
  { captureEmail: true, paidPlan: true },
);
