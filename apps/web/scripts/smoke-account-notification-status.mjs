import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";
const moduleOnly = process.argv.includes("--module-only");
const ids = {},
  assets = resolve(import.meta.dirname, "../dist/server/assets");
for (const file of (await readdir(assets)).filter((f) => f.endsWith(".js"))) {
  const text = await readFile(resolve(assets, file), "utf8");
  for (const name of [
    "getPersonalNotificationCount",
    "getPersonalNotifications",
  ])
    ids[name] ??= text.match(
      new RegExp(
        `const ${name}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`,
      ),
    )?.[1];
}
assert.ok(ids.getPersonalNotifications);
await withLocalSmokeFixture(
  async ({ origin, orgId, operatorCookie, capturedEmails }) => {
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
    window.countFault='hold';window.countHeld=[];window.countCalls=0;window.countErrors=[];window.countDocument='same';
    addEventListener('error',e=>window.countErrors.push(e.message));addEventListener('unhandledrejection',e=>window.countErrors.push(String(e.reason)));
    const original=fetch,id=${JSON.stringify(ids.getPersonalNotificationCount ?? ids.getPersonalNotifications)};
    window.fetch=async(input,options)=>{
      const url=input instanceof Request?input.url:String(input);
      if(!url.includes('/_serverFn/'+id))return original(input,options);
      window.countCalls++;if(window.countFault==='fail')throw new TypeError('Fixture count unavailable');
      const hold=window.countFault==='hold';const reply=await original(input,hold?{...options,signal:new AbortController().signal}:options);
      if(!hold)return reply;
      const bytes=await reply.arrayBuffer();return new Promise(resolve=>window.countHeld.push(()=>resolve(new Response(bytes,{status:reply.status,headers:reply.headers}))));
    };`,
        });
        const check = (expression, label, timeout = 15_000) =>
          poll(() => evaluate(expression), label, timeout).catch(
            async (error) => {
              console.error(
                JSON.stringify({
                  label,
                  state: await evaluate(
                    `({text:document.body.innerText,errors:window.countErrors,calls:window.countCalls})`,
                  ),
                }),
              );
              throw error;
            },
          );
        const button = (text) =>
          `[...document.querySelectorAll('button')].find(el=>el.textContent.trim()===${JSON.stringify(text)}&&el.getBoundingClientRect().width>0)`;
        const click = async (expression) => {
          const point = await check(
            `(async()=>{const el=${expression};if(!el||el.disabled||!Object.keys(el).some(k=>k.startsWith('__reactProps')))return null;el.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=el.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return el.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`,
            "reachable account control",
          );
          await page("Input.dispatchMouseEvent", {
            type: "mousePressed",
            button: "left",
            clickCount: 1,
            ...point,
          });
          await page("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            button: "left",
            clickCount: 1,
            ...point,
          });
        };
        if(moduleOnly) await page("Fetch.enable",{patterns:[{urlPattern:"*/assets/account-notification-count-*.js",requestStage:"Request"}]});
        await page("Page.navigate", { url: `${origin}/${orgId}/show` });
        await click(`document.querySelector('button[title="Account menu"]')`);
        await check(
          `document.querySelector('[role=dialog]')?.textContent.includes('Unread count unavailable')`,
          "visible unread count deadline",
        );
        assert.equal(
          await evaluate(
            `document.querySelector('[role=dialog]').textContent.includes('all caught up')`,
          ),
          false,
        );
        assert.equal(
          await evaluate(
            `!!document.querySelector('[aria-label="Notification count recovery"] time')`,
          ),
          true,
        );
        if(moduleOnly) {
          assert.equal(await evaluate("window.countCalls"),0,"The stalled module has not started a read");
          await page("Fetch.disable");
        }
        await evaluate(`window.countHeld.forEach(release=>release());true`);
        assert.equal(
          await evaluate(`!!${button("Retry notification count")}`),
          true,
        );
        for (const [width, height] of [
          [320, 480],
          [768, 900],
          [1440, 900],
        ]) {
          await page("Emulation.setDeviceMetricsOverride", {
            width,
            height,
            deviceScaleFactor: 1,
            mobile: false,
          });
          await check(
            `(()=>{const el=${button("Retry notification count")};el.scrollIntoView({block:'center'});const b=el.getBoundingClientRect();return b.width>=44&&b.height>=44&&b.left>=0&&b.right<=innerWidth&&el.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2));})()`,
            `count Retry fits ${width}`,
          );
          if (width === 320)
            await writeFile(
              moduleOnly ? "/tmp/showpilot-notification-count-module-320.png" : "/tmp/showpilot-notification-count-320.png",
              Buffer.from(
                (await page("Page.captureScreenshot", { format: "png" })).data,
                "base64",
              ),
            );
        }
        await evaluate(`window.countFault='normal';true`);
        await click(button("Retry notification count"));
        await check(
          `document.querySelector('[role=dialog]')?.textContent.includes('35 unread notifications')`,
          "real count recovered",
        );
        await evaluate(
          `window.countFault='fail';window.dispatchEvent(new Event('focus'));true`,
        );
        await check(
          `!!${button("Retry notification count")}`,
          "refresh failure visible",
        );
        assert.equal(
          await evaluate(
            `document.querySelector('[role=dialog]').textContent.includes('35 unread')`,
          ),
          true,
          "last confirmed count retained",
        );
        // Reading the actual inbox supersedes any failed sidebar snapshot.
        await click(`[...document.querySelectorAll('[role=dialog] button')].find(el=>el.textContent.trim().startsWith('Notifications'))`);
        await check(
          `document.querySelector('[data-testid="notification-list"]')?.textContent.includes('Fixture alert 34')`,
          "inbox accessible during count failure",
        );
        await click(
          `document.querySelector('button[aria-label="Back to account"]')`,
        );
        await check(
          `document.querySelector('[role=dialog]')?.textContent.includes('35 unread notifications')&&!${button("Retry notification count")}`,
          "inbox refresh repairs count",
        );
        assert.equal(await evaluate("window.countDocument"), "same");
        assert.deepEqual(await evaluate("window.countErrors"), []);
      },
    );
    assert.equal((await capturedEmails()).length, 0);
    console.log(
      JSON.stringify({
        passed: true,
        boundedCount: !moduleOnly,
        boundedModule: moduleOnly,
        lateReadIgnored: true,
        retainedCount: true,
        inboxRepairsCount: true,
        widths: [320, 768, 1440],
        capturedEmails: 0,
      }),
    );
  },
  { notificationInbox: true, captureEmail: true },
);
