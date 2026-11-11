// Real auth/D1 and compiled Show Flow. Only disposable fixture preferences change.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";
const require = createRequire(new URL("../package.json", import.meta.url));
const router = createRequire(require.resolve("@tanstack/react-router"));
const core = createRequire(router.resolve("@tanstack/router-core"));
const { toJSONAsync, fromCrossJSON } = core("seroval");
const { defaultSerovalPlugins } = router("@tanstack/router-core");
const ids = {},
  names = ["getFirstSessionChecklist", "updateFirstSessionChecklist"];
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
    const rpc = async (name, data = {}) => {
      const payload = JSON.stringify(
        await toJSONAsync({ data: { orgId, ...data } }),
      );
      const read = name.startsWith("get");
      const response = await fetch(
        `${origin}/_serverFn/${ids[name]}${read ? "?" + new URLSearchParams({ payload }) : ""}`,
        {
          method: read ? "GET" : "POST",
          headers: {
            Cookie: operatorCookie,
            Origin: origin,
            "Sec-Fetch-Site": "same-origin",
            "x-tsr-serverFn": "true",
            "Content-Type": "application/json",
          },
          ...(read ? {} : { body: payload }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      assert.equal(response.status, 200);
      const reply = fromCrossJSON(await response.json(), {
        refs: new Map(),
        plugins: defaultSerovalPlugins,
      });
      assert.equal(reply.error, undefined);
      assert.equal(reply instanceof Error, false);
      return reply.result;
    };
    const read = () => rpc("getFirstSessionChecklist");
    const setItem = (expectedSnapshot, completed) =>
      rpc("updateFirstSessionChecklist", {
        requestId: crypto.randomUUID(),
        expectedSnapshot,
        action: { kind: "item", item: "rename-item", completed },
      });
    await withRealBrowser(
      { origin, cookie: operatorCookie },
      async ({ page, evaluate }) => {
        await page("Page.enable");
        await page("Page.bringToFront");
        await page("Emulation.setFocusEmulationEnabled", { enabled: true });
        await page("Page.addScriptToEvaluateOnNewDocument", {
          source: `
      window.checklistErrors=[];window.checklistCalls=[];window.heldReads=[];window.heldWrites=[];window.holdRead=true;window.holdWrite=false;
      addEventListener('error',e=>window.checklistErrors.push(e.message));
      addEventListener('unhandledrejection',e=>window.checklistErrors.push(String(e.reason)));
      const original=fetch;window.fetch=async(input,options)=>{
        const url=input instanceof Request?input.url:String(input);
        const read=url.includes('/_serverFn/${ids.getFirstSessionChecklist}'),write=url.includes('/_serverFn/${ids.updateFirstSessionChecklist}');
        if(write)window.checklistCalls.push(options.body);
        const hold=(read&&window.holdRead)||(write&&window.holdWrite);
        const response=await original(input,hold?{...options,signal:new AbortController().signal}:options);
        if(hold){const body=await response.text();return new Promise(resolve=>(read?window.heldReads:window.heldWrites).push(()=>resolve(new Response(body,{status:response.status,headers:response.headers}))));}
        return response;
      };`,
        });
        const check = (expression, label) =>
          poll(() => evaluate(expression), label).catch(async (error) => {
            console.log(
              JSON.stringify({
                failed: label,
                ui: await evaluate(
                  `({url:location.href,text:document.body?.innerText,errors:window.checklistErrors})`,
                ),
              }),
            );
            throw error;
          });
        const button = (name) =>
          `[...document.querySelectorAll('button')].find(n=>(n.textContent.trim()===${JSON.stringify(name)}||n.getAttribute('aria-label')===${JSON.stringify(name)})&&n.getBoundingClientRect().width>0)`;
        const item = `document.querySelector('[aria-label="First session checklist"] button[aria-label*="Rename"]')`;
        const click = async (expression) => {
          const point = await check(
            `(async()=>{const n=${expression};if(!n||n.disabled)return null;n.scrollIntoView({block:'center',inline:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`,
            "click target reachable",
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
        const width = (width, height = 900) =>
          page("Emulation.setDeviceMetricsOverride", {
            width,
            height,
            deviceScaleFactor: 1,
            mobile: false,
          });
        const leaveAndReturn = async () => {
          await click(`document.querySelector('aside a[href$="/rundown"]')`);
          await check(
            `location.pathname.endsWith('/rundown')&&document.querySelector('h1')?.textContent==='Display test show'`,
            "Rundown navigation",
          );
          await click(`document.querySelector('aside a[href$="/show"]')`);
          await check(
            `location.pathname.endsWith('/show')&&document.querySelector('h1')?.textContent==='Show Flow'`,
            "Show Flow navigation",
          );
        };
        await width(1440);
        await page("Page.navigate", { url: `${origin}/${orgId}/show` });
        await check(
          `!!(${button("Retry checklist")})`,
          "read timeout is visible",
        );
        assert.ok(await evaluate("window.heldReads.length>=1"));
        await evaluate("window.holdRead=false");
        await click(button("Retry checklist"));
        await check(
          `!!(${item})&&!(${item}).disabled`,
          "read Retry loads checklist",
        );
        await evaluate(
          "window.heldReads.splice(0).forEach(release=>release())",
        );
        for (const [viewport, height] of [
          [1440, 900],
          [768, 900],
          [320, 900],
          [320, 480],
        ]) {
          await width(viewport, height);
          const bounds = await evaluate(
            `(()=>{const n=document.querySelector('[aria-label="First session checklist"]'),b=n.getBoundingClientRect();return {fits:b.left>=0&&b.right<=innerWidth&&b.top>=0&&b.bottom<=innerHeight&&n.scrollWidth<=n.clientWidth+1,targets:[...n.querySelectorAll('button,a')].map(n=>{const r=n.getBoundingClientRect();return {w:r.width,h:r.height,left:r.left,right:r.right}})};})()`,
          );
          assert.ok(
            bounds.fits &&
              bounds.targets.every(
                (r) =>
                  r.w >= 44 && r.h >= 44 && r.left >= 0 && r.right <= viewport,
              ),
            JSON.stringify(bounds),
          );
          if (viewport === 320 && height === 480)
            await writeFile(
              "/tmp/showpilot-first-session-320.png",
              Buffer.from(
                (await page("Page.captureScreenshot", { format: "png" })).data,
                "base64",
              ),
            );
        }
        await width(1440);
        await evaluate("window.holdWrite=true");
        await click(item);
        await check(
          "window.heldWrites.length===1",
          "real completion reply withheld",
        );
        assert.equal(
          await evaluate(`(${item}).getAttribute('aria-pressed')`),
          "false",
          "unconfirmed completion is not presented as saved",
        );
        const saved = await read();
        assert.deepEqual(saved.completed, ["rename-item"]);
        await setItem(saved.snapshot, false);
        await check(
          `!!(${button("Retry checklist change")})`,
          "write timeout has exact Retry",
        );
        await leaveAndReturn();
        await check(
          `!!(${button("Retry checklist change")})`,
          "Retry survives navigation",
        );
        await evaluate("window.holdWrite=false");
        await click(button("Retry checklist change"));
        await check(
          `!!(${item})&&!(${item}).disabled`,
          "exact Retry acknowledged",
        );
        let calls = await evaluate("window.checklistCalls");
        assert.equal(calls.length, 2);
        assert.equal(calls[0], calls[1]);
        assert.deepEqual((await read()).completed, []);
        await evaluate(
          "window.heldWrites.splice(0).forEach(release=>release())",
        );
        assert.equal(
          await evaluate(`(${item}).getAttribute('aria-pressed')`),
          "false",
        );
        await click(item);
        await check(
          `(${item}).getAttribute('aria-pressed')==='true'&&!(${item}).disabled`,
          "new reviewed completion saved",
        );
        await setItem((await read()).snapshot, false);
        await click(item);
        await check(
          `!!(${button("Use saved checklist")})`,
          "stale snapshot gets explicit review",
        );
        await click(button("Use saved checklist"));
        await check(
          `(${item}).getAttribute('aria-pressed')==='false'&&!(${item}).disabled`,
          "review adopts newer saved progress",
        );
        await evaluate("window.holdWrite=true");
        await click(button("Dismiss checklist"));
        await check("window.heldWrites.length===1", "dismissal reply withheld");
        await check(
          `!!(${button("Retry checklist change")})`,
          "failed dismissal stays visible",
        );
        assert.equal((await read()).show, false);
        await leaveAndReturn();
        await check(
          `!!(${button("Retry checklist change")})`,
          "dismissal recovery survives navigation",
        );
        await evaluate("window.holdWrite=false");
        await click(button("Retry checklist change"));
        await check(
          `!document.querySelector('[aria-label="First session checklist"]')`,
          "confirmed dismissal hides checklist",
        );
        await evaluate(
          "window.heldWrites.splice(0).forEach(release=>release())",
        );
        calls = await evaluate("window.checklistCalls");
        assert.equal(calls.length, 6);
        assert.equal(calls[4], calls[5]);
        assert.deepEqual(await evaluate("window.checklistErrors"), []);
      },
    );
    await stopServer();
    const rows = await queryFixture(
      `SELECT key,value FROM app_setting WHERE orgId='${orgId}' AND key LIKE 'onboarding-first-session:%'`,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].key, "onboarding-first-session:smoke-operator");
    assert.deepEqual(JSON.parse(rows[0].value).completed, []);
    assert.equal(JSON.parse(rows[0].value).dismissed, true);
    assert.equal(
      (
        await queryFixture(
          `SELECT key FROM app_setting WHERE orgId='${orgId}' AND key LIKE 'setting-write:%'`,
        )
      ).length,
      6,
    );
    assert.equal((await capturedEmails()).length, 0);
    console.log(
      JSON.stringify({
        passed: true,
        boundedReads: true,
        exactRetriesAcrossNavigation: true,
        newerProgressPreserved: true,
        conflictsReviewed: true,
        dismissalConfirmed: true,
        widths: [320, 768, 1440],
        shortWindow: true,
        receipts: 6,
        externalEmails: 0,
      }),
    );
  },
  { setupChoices: true, captureEmail: true },
);
