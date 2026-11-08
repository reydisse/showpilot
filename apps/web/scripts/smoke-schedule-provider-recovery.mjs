// Real compiled app/auth/D1/Chrome. Only transport replies are interrupted.
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
  names = ["getScheduleProvider", "saveScheduleProvider"];
const assets = resolve(import.meta.dirname, "../dist/server/assets");
for (const file of (await readdir(assets)).filter((f) => f.endsWith(".js"))) {
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
  async ({ origin, orgId, operatorCookie, capturedEmails }) => {
    async function rpc(name, data = {}) {
      const payload = JSON.stringify(
        await toJSONAsync({ data: { orgId, ...data } }),
      );
      const url = `${origin}/_serverFn/${ids[name]}`;
      const headers = {
        Cookie: operatorCookie,
        Origin: origin,
        "Sec-Fetch-Site": "same-origin",
        "x-tsr-serverFn": "true",
        "Content-Type": "application/json",
      };
      const response = await fetch(
        name === "getScheduleProvider"
          ? `${url}?payload=${encodeURIComponent(payload)}`
          : url,
        name === "getScheduleProvider"
          ? { headers }
          : { method: "POST", headers, body: payload },
      );
      assert.equal(response.status, 200);
      const reply = fromCrossJSON(await response.json(), {
        refs: new Map(),
        plugins: defaultSerovalPlugins,
      });
      assert.equal(reply.error, undefined);
      assert.equal(reply instanceof Error, false);
      return reply.result;
    }
    const initial = await rpc("getScheduleProvider");
    await withRealBrowser(
      { origin, cookie: operatorCookie },
      async ({ page, evaluate }) => {
        await page("Page.enable");
        await page("Emulation.setFocusEmulationEnabled", { enabled: true });
        await page("Emulation.setDeviceMetricsOverride", {
          width: 1440,
          height: 1000,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await page("Page.addScriptToEvaluateOnNewDocument", {
          source: `
      window.providerMode={read:'hold',write:'hold'};window.providerCalls=[];window.providerHeld=[];window.providerErrors=[];window.providerDocument='same';
      addEventListener('error',e=>providerErrors.push(e.message));addEventListener('unhandledrejection',e=>providerErrors.push(String(e.reason)));
      const original=fetch;window.fetch=async(input,options)=>{
        const url=input instanceof Request?input.url:String(input),kind=url.includes('/_serverFn/${ids.getScheduleProvider}')?'read':url.includes('/_serverFn/${ids.saveScheduleProvider}')?'write':null;
        if(!kind)return original(input,options);if(kind==='write')providerCalls.push(options.body);
        if(providerMode[kind]==='fail')throw new TypeError('Fixture transport offline');
        const hold=providerMode[kind]==='hold';const response=await original(input,hold?{...options,signal:new AbortController().signal}:options);
        if(!hold)return response;const bytes=await response.arrayBuffer();return new Promise(resolve=>providerHeld.push({kind,release:()=>resolve(new Response(bytes,{status:response.status,headers:response.headers}))}));
      };`,
        });
        const check = (expression, description) =>
          poll(() => evaluate(expression), description).catch(async (error) => {
            console.log(
              JSON.stringify({
                description,
                body: await evaluate("document.body.innerText"),
                errors: await evaluate("providerErrors"),
                calls: await evaluate("providerCalls"),
              }),
            );
            throw error;
          });
        const button = (name) =>
          `[...document.querySelectorAll('button')].find(b=>(b.textContent.trim()===${JSON.stringify(name)}||b.getAttribute('aria-label')===${JSON.stringify(name)})&&!b.disabled)`;
        const click = async (expression) => {
          const point = await check(
            `(async()=>{const n=${expression};if(!n||!Object.keys(n).some(k=>k.startsWith('__reactProps')))return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`,
            "reachable control " + expression,
          );
          for (const type of ["mousePressed", "mouseReleased"])
            await page("Input.dispatchMouseEvent", {
              type,
              button: "left",
              clickCount: 1,
              ...point,
            });
        };
        const fill = async (selector, value) => {
          await check(
            `!!document.querySelector(${JSON.stringify(selector)})`,
            "field ready",
          );
          await evaluate(
            `(()=>{const n=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(n instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event(n instanceof HTMLSelectElement?'change':'input',{bubbles:true}));})()`,
          );
          await check(
            `document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(value)}`,
            "field retained",
          );
        };
        const close = async () => {
          await click(button("Close Scheduling source"));
          await check(
            `!document.querySelector('[role=dialog]')`,
            "dialog closed",
          );
        };
        const release = async (kind) =>
          evaluate(
            `(()=>{providerMode[${JSON.stringify(kind)}]='pass';const pending=providerHeld.filter(h=>h.kind===${JSON.stringify(kind)});providerHeld=providerHeld.filter(h=>h.kind!==${JSON.stringify(kind)});pending.forEach(h=>h.release());return true;})()`,
          );
        await page("Page.navigate", { url: `${origin}/${orgId}/schedule` });
        await click(button("Manage source"));
        await check(`!!${button("Retry")}`, "initial read deadline");
        assert.equal(
          await evaluate(`!!document.querySelector('[role=dialog] select')`),
          false,
        );
        await release("read");
        await click(button("Retry"));
        await fill("[role=dialog] select", "other");
        await fill("[role=dialog] input:not([type=url])", "Recovery fixture");
        await fill(
          "[role=dialog] input[type=url]",
          "http://fixture.invalid/shows",
        );
        await click(button("Save source"));
        await check(
          `document.querySelector('[role=dialog]').textContent.includes('Use an HTTPS')`,
          "HTTPS validation",
        );
        assert.equal((await evaluate("providerCalls")).length, 0);
        await fill(
          "[role=dialog] input[type=url]",
          "https://fixture.invalid/shows",
        );
        await click(button("Save source"));
        await check(
          `providerHeld.some(h=>h.kind==='write')`,
          "real source write committed",
        );
        const committed = await rpc("getScheduleProvider");
        assert.equal(committed.config.url, "https://fixture.invalid/shows");
        const newer = await rpc("saveScheduleProvider", {
          userId: initial.userId,
          requestId: crypto.randomUUID(),
          expectedRevision: committed.revision,
          config: {
            provider: "faithteams",
            url: "https://newer.invalid/shows",
            label: "",
          },
        });
        await click(
          `document.querySelector('[role=dialog] a[href="/${orgId}/settings?section=workspace"]')`,
        );
        await check(
          `location.pathname.endsWith('/settings')&&location.search.includes('workspace')&&!document.querySelector('[role=dialog]')`,
          "workspace link leaves source form",
        );
        await click(`document.querySelector('a[href="/${orgId}/schedule"]')`);
        await click(button("Manage source"));
        await check(`!!${button("Retry")}`, "save deadline after navigation");
        assert.equal(
          await evaluate(
            `document.querySelector('[role=dialog] input[type=url]').value`,
          ),
          "https://fixture.invalid/shows",
        );
        await release("write");
        await click(button("Retry"));
        await check(
          `!!${button("Save reviewed source")}`,
          "newer source conflict",
        );
        const attempts = (await evaluate("providerCalls")).map(
          (body) => fromJSON(JSON.parse(body)).data,
        );
        assert.deepEqual(attempts[1], attempts[0]);
        assert.deepEqual(await rpc("getScheduleProvider"), newer.snapshot);
        for (const [width, height] of [
          [320, 480],
          [768, 1024],
          [1440, 1000],
        ]) {
          await page("Emulation.setDeviceMetricsOverride", {
            width,
            height,
            deviceScaleFactor: 1,
            mobile: false,
          });
          const layout = await check(
            `(async()=>{await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const d=document.querySelector('[role=dialog]');if(!d||d.clientWidth<1)return null;const r=d.getBoundingClientRect();if(r.left<0||r.right>innerWidth||r.top<0||r.bottom>innerHeight)return null;return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,overflow:d.scrollWidth-d.clientWidth,small:[...d.querySelectorAll('button,input,select')].filter(n=>n.getBoundingClientRect().height<44).map(n=>n.textContent)}})()`,
            "dialog layout",
          );
          assert.ok(
            layout.left >= 0 &&
              layout.right <= width &&
              layout.top >= 0 &&
              layout.bottom <= height,
            JSON.stringify(layout),
          );
          assert.ok(layout.overflow <= 1);
          assert.deepEqual(layout.small, []);
          await writeFile(
            `/tmp/showpilot-provider-${width}.png`,
            Buffer.from(
              (await page("Page.captureScreenshot", { format: "png" })).data,
              "base64",
            ),
          );
        }
        await click(button("Save reviewed source"));
        await check(
          `document.querySelector('[role=dialog]')?.textContent.includes('Source saved.')`,
          "explicit fresh save",
        );
        const final = await rpc("getScheduleProvider");
        assert.equal(final.config.url, "https://fixture.invalid/shows");
        const all = (await evaluate("providerCalls")).map(
          (body) => fromJSON(JSON.parse(body)).data,
        );
        assert.notEqual(all[2].requestId, all[0].requestId);
        assert.equal(all[2].expectedRevision, newer.snapshot.revision);
        await close();
        assert.equal(
          await evaluate(`document.activeElement?.textContent.trim()`),
          "Manage source",
        );
        assert.equal(await evaluate("providerDocument"), "same");
        assert.deepEqual(await evaluate("providerErrors"), []);
        assert.equal(capturedEmails.length, 0);
        console.log(
          JSON.stringify({
            readDeadline: true,
            invalidHttpsRejected: true,
            retainedAcrossNavigation: true,
            exactRetryPreservedNewerSource: true,
            reviewedSave: true,
            viewports: [320, 768, 1440],
            errors: [],
            emails: 0,
          }),
        );
      },
    );
  },
);
