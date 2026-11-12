// Compiled React, authenticated RPCs and real D1/relay; only request delivery and replies are held.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";
const require = createRequire(new URL("../package.json", import.meta.url));
const router = createRequire(require.resolve("@tanstack/react-router")),
  core = createRequire(router.resolve("@tanstack/router-core"));
const { fromJSON } = core("seroval");
const ids = {},
  names = ["deleteService"],
  assets = resolve(import.meta.dirname, "../dist/server/assets");
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
  async ({ origin, orgId, date, queryFixture, operatorCookie }) => {
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
   window.detailsCalls=[];window.detailsHeld=[];window.detailsMode='before';window.detailsErrors=[];window.detailsDocument='same';
   addEventListener('error',e=>detailsErrors.push(e.message));addEventListener('unhandledrejection',e=>detailsErrors.push(String(e.reason)));
   const original=fetch;window.fetch=async(input,options)=>{
    const url=input instanceof Request?input.url:String(input);
    if(!url.includes('/_serverFn/${ids.deleteService}'))return original(input,options);
    detailsCalls.push(options.body);const mode=detailsMode;
    const send=()=>original(input,{...options,signal:new AbortController().signal});
    if(mode==='before')return new Promise((resolve,reject)=>detailsHeld.push({mode,release:()=>send().then(resolve,reject)}));
    const response=await send();if(mode!=='after')return response;
    const bytes=await response.arrayBuffer();return new Promise(resolve=>detailsHeld.push({mode,release:()=>resolve(new Response(bytes,{status:response.status,headers:response.headers}))}));
   };`,
        });
        const check = (expression, label) =>
          poll(() => evaluate(expression), label).catch(async (error) => {
            console.log(
              JSON.stringify({
                label,
                body: await evaluate("document.body.innerText"),
                errors: await evaluate("detailsErrors"),
              }),
            );
            throw error;
          });
        const button = (name) =>
          `[...(document.querySelector('[role=dialog]')??document).querySelectorAll('button')].find(n=>(n.textContent.trim()===${JSON.stringify(name)}||n.getAttribute('aria-label')===${JSON.stringify(name)})&&!n.disabled)`;
        const click = async (expression) => {
          const point = await check(
            `(async()=>{const n=${expression};if(!n||!Object.keys(n).some(k=>k.startsWith('__reactProps')))return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`,
            "reachable " + expression,
          );
          for (const type of ["mousePressed", "mouseReleased"])
            await page("Input.dispatchMouseEvent", {
              type,
              button: "left",
              clickCount: 1,
              ...point,
            });
        };
        const openDetails = async () => {
          await click(
            `[...document.querySelectorAll('button')].find(n=>n.getAttribute('aria-label')?.startsWith('Edit ')&&!n.disabled)`,
          );
          await check(`!!${button("Save show details")}`, "details form");
        };
        await page("Page.navigate", {
          url: `${origin}/${orgId}/schedule?show=smoke-show`,
        });
        await openDetails();
        const approve = async () => {
          await click(button("Delete show"));
          await check(
            "[...document.querySelectorAll('[role=dialog]')].some(n=>n.textContent.includes('Delete this show?'))",
            "delete confirmation",
          );
          await click(
            `[...document.querySelectorAll('[role=dialog]')].at(-1)?.querySelector('button:last-child')`,
          );
        };
        await click(button("Delete show"));
        await click(
          `[...document.querySelectorAll('[role=dialog]')].at(-1)?.querySelector('button')`,
        );
        assert.equal((await evaluate("detailsCalls")).length, 0);
        await approve();
        await check("detailsHeld.length===1", "undelivered deletion held");
        await check(
          "!document.querySelector('[role=dialog]')",
          "details closed after confirmation",
        );
        const leaveAndReturn = async () => {
          await click(`document.querySelector('a[href="/${orgId}/songs"]')`);
          await check("location.pathname.endsWith('/songs')", "leave Schedule");
          await evaluate("history.back()");
          await check(
            "location.pathname.endsWith('/schedule')",
            "return to Schedule",
          );
        };
        await leaveAndReturn();
        await check(
          `!!${button("Retry deletion")}`,
          "bounded deletion recovery",
        );
        const layout = async (name, prefix) => {
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
            const measured = await check(
              `(async()=>{const n=${button(name)};if(!n)return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(n);const text=range.getBoundingClientRect(),drawer=document.querySelector('aside[aria-hidden=true]');return b.left>=0&&b.right<=innerWidth&&b.top>=0&&b.bottom<=innerHeight&&(!drawer||drawer.getBoundingClientRect().right<=0)&&n.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))?{height:b.height,width:document.documentElement.scrollWidth,viewport:innerWidth,textInside:text.left>=b.left&&text.right<=b.right}:null;})()`,
              "reachable " + name + " " + width,
            );
            assert.ok(
              measured.height >= 44 && measured.width <= measured.viewport && measured.textInside,
              JSON.stringify({name,width,...measured}),
            );
            await writeFile(
              `/tmp/showpilot-delete-${prefix}-${width}.png`,
              Buffer.from(
                (await page("Page.captureScreenshot", { format: "png" })).data,
                "base64",
              ),
            );
          }
        };
        await layout("Retry deletion", "retry");
        const calls = () =>
          evaluate("detailsCalls").then((values) =>
            values.map((body) => fromJSON(JSON.parse(body)).data),
          );
        const original = (await calls())[0];
        assert.equal(original.showId, "smoke-show");
        assert.equal(original.userId, "smoke-operator");
        assert.ok(original.expectedUpdatedAt);
        await evaluate("detailsMode='after'");
        await click(button("Retry deletion"));
        await check(
          "detailsHeld.some(item=>item.mode==='after')",
          "successful deletion reply held",
        );
        assert.equal(
          (
            await queryFixture(
              "SELECT id FROM rundown WHERE orgId='display-smoke' AND id='smoke-show'",
            )
          ).length,
          0,
        );
        await leaveAndReturn();
        await check(
          `!!${button("Retry deletion")}`,
          "recovery survives removal of the show row",
        );
        assert.ok(
          await evaluate(
            `document.querySelector('[aria-label="Show deletion progress"]').textContent.includes('Display test show')`,
          ),
        );
        await evaluate("detailsMode='normal'");
        await click(button("Retry deletion"));
        await check(`!!${button("Dismiss")}`, "confirmed deletion refreshed");
        const submitted = await calls();
        assert.equal(submitted.length, 3);
        assert.deepEqual(submitted, [original, original, original]);
        assert.deepEqual(
          await queryFixture(
            "SELECT stage FROM show_deletion WHERE orgId='display-smoke' AND showId='smoke-show'",
          ),
          [{ stage: "deleted" }],
        );
        await evaluate("detailsHeld.forEach(item=>item.release())");
        await click(button("Dismiss"));
        await openDetails();
        await click(button("Delete show"));
        const response = await fetch(
          `${origin}/api/rundown/${orgId}/command?showId=smoke-second-show&serviceDate=${date}`,
          {
            method: "POST",
            headers: {
              Cookie: operatorCookie,
              Origin: origin,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              action: "update-meta",
              payload: { serviceName: "Renamed evening show" },
            }),
          },
        );
        assert.equal(response.status, 200, await response.clone().text());
        await response.arrayBuffer();
        await click(
          `[...document.querySelectorAll('[role=dialog]')].at(-1)?.querySelector('button:last-child')`,
        );
        await check(
          "document.querySelector('[aria-label=\"Show deletion progress\"]')?.textContent.includes('Deletion was not accepted')",
          "stale confirmation rejected",
        );
        assert.equal(
          (
            await queryFixture(
              "SELECT id FROM rundown WHERE orgId='display-smoke' AND id='smoke-second-show'",
            )
          ).length,
          1,
        );
        await layout("Refresh Schedule", "rejected");
        await click(button("Refresh Schedule"));
        await check(
          "!document.querySelector('[aria-label=\"Show deletion progress\"]')",
          "rejected confirmation reviewed",
        );
        await openDetails();
        await approve();
        await check(
          `!!${button("Dismiss")}`,
          "fresh confirmation deleted second show",
        );
        assert.equal(
          (
            await queryFixture(
              "SELECT id FROM rundown WHERE orgId='display-smoke' AND id='smoke-second-show'",
            )
          ).length,
          0,
        );
        assert.equal(await evaluate("detailsDocument"), "same");
        assert.deepEqual(await evaluate("detailsErrors"), []);
        console.log(
          JSON.stringify({
            cancelSendsNothing: true,
            timeoutRetained: true,
            originalDeletionRetried: true,
            recoverySurvivesRemovedRow: true,
            oneReceipt: true,
            staleConfirmationRejected: true,
            freshConfirmationRequired: true,
            viewports: [320, 768, 1440],
            errors: [],
          }),
        );
      },
    );
  },
  { secondShow: true },
);
