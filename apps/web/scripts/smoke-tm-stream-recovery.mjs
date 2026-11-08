// Compiled dashboard + real auth/D1/Chrome. Streaming provider calls stay in
// the disposable fixture; no production data or external output is used.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";
const require = createRequire(new URL("../package.json", import.meta.url)),
  router = createRequire(require.resolve("@tanstack/react-router")),
  core = createRequire(router.resolve("@tanstack/router-core"));
const { toJSONAsync, fromJSON, fromCrossJSON } = core("seroval"),
  { defaultSerovalPlugins } = router("@tanstack/router-core");
const ids = {},
  names = ["getTmStreamState", "writeTmStream"],
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
  async ({
    origin,
    orgId,
    operatorCookie,
    configureStreamOutputs,
    streamOutputRequests,
    streamOutputSnapshot,
    stopServer,
    queryFixture,
  }) => {
    const headers = {
      Cookie: operatorCookie,
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      "x-tsr-serverFn": "true",
      "Content-Type": "application/json",
    };
    async function rpc(name, data = {}) {
      const payload = JSON.stringify(
          await toJSONAsync({ data: { orgId, ...data } }),
        ),
        url = `${origin}/_serverFn/${ids[name]}`,
        read = name === "getTmStreamState";
      const response = await fetch(
        read ? `${url}?payload=${encodeURIComponent(payload)}` : url,
        read ? { headers } : { method: "POST", headers, body: payload },
      );
      assert.equal(response.status, 200);
      const reply = fromCrossJSON(await response.json(), {
        refs: new Map(),
        plugins: defaultSerovalPlugins,
      });
      assert.equal(reply instanceof Error, false, reply.message);
      assert.equal(reply.error, undefined);
      return reply.result;
    }
    const read = () => rpc("getTmStreamState");
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
          source: `window.tmCalls=[];window.tmCompleted=[];window.tmErrors=[];window.tmReplies=[];window.holdTmWrites=true;window.holdTmReads=false;addEventListener('error',e=>window.tmErrors.push(e.message));addEventListener('unhandledrejection',e=>window.tmErrors.push(String(e.reason)));const original=fetch;window.fetch=async(input,options)=>{const url=input instanceof Request?input.url:String(input),write=url.includes('/_serverFn/${ids.writeTmStream}'),read=url.includes('/_serverFn/${ids.getTmStreamState}');if(write)window.tmCalls.push(options.body);const held=(write&&window.holdTmWrites)||(read&&window.holdTmReads);const response=await original(input,options);if(write)window.tmCompleted.push(options.body);if(held){const body=await response.text();return new Promise(resolve=>window.tmReplies.push(()=>resolve(new Response(body,{status:response.status,headers:response.headers}))));}return response;};`,
        });
        const root = `document.querySelector('section[aria-label="Streaming controls"]')`;
        const check = (code, label) =>
          poll(() => evaluate(code), label).catch(async (error) => {
            console.log(
              JSON.stringify({
                label,
                body: await evaluate("document.body?.innerText"),
                errors: await evaluate("window.tmErrors"),
              }),
            );
            throw error;
          });
        const click = async (text, { link = false, dialog = false } = {}) => {
          const point = await check(
            `(async()=>{const root=${dialog ? "document.querySelector('[role=dialog]')" : root};if(!root||root.getAnimations({subtree:true}).some(a=>a.playState!=='finished'))return null;const n=[...root.querySelectorAll('${link ? "a" : "button"}')].find(n=>(n.textContent.trim()===${JSON.stringify(text)}||n.getAttribute('aria-label')===${JSON.stringify(text)})&&!n.disabled);if(!n)return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`,
            "click " + text,
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
        const confirm = async (action, label) => {
          await click(action);
          await click(label, { dialog: true });
          await check(
            `!document.querySelector('[role=dialog]')`,
            "confirmation closed",
          );
        };
        await page("Page.navigate", {
          url: `${origin}/${orgId}/dashboard/tech-manager`,
        });
        await check(
          `${root}?.innerText.includes('Fixture alpha')`,
          "initial output read",
        );
        await click("Go live");
        await check(
          `document.querySelector('[role=dialog]')?.innerText.includes('Fixture beta')`,
          "named confirmation",
        );
        assert.equal(
          (await streamOutputRequests()).filter(
            (request) => request.method === "POST",
          ).length,
          0,
        );
        for (const width of [320, 768, 1440]) {
          await page("Emulation.setDeviceMetricsOverride", {
            width,
            height: 1000,
            deviceScaleFactor: 1,
            mobile: false,
          });
          await check(
            `(()=>{const n=document.querySelector('[role=dialog]');if(n.getAnimations({subtree:true}).some(a=>a.playState!=='finished'))return false;const b=n.getBoundingClientRect();return b.x>=0&&b.right<=innerWidth+1&&[...n.querySelectorAll('button')].every(n=>n.getBoundingClientRect().height>=44)})()`,
            "confirmation fits " + width,
          );
        }
        await click("Cancel", { dialog: true });
        await check(`!document.querySelector('[role=dialog]')`, "cancel");
        assert.equal(
          (await streamOutputRequests()).filter(
            (request) => request.method === "POST",
          ).length,
          0,
        );
        await confirm("Go live", "Go live now");
        await poll(
          async () =>
            Object.values(await streamOutputSnapshot()).filter(
              (output) => output.enabled,
            ).length === 2,
          "provider outputs enabled",
        );
        // Another controller stops the outputs after the original Go Live succeeded.
        const snapshot = await read();
        const independentStop = {
          action: "stream-stop",
          requestId: crypto.randomUUID(),
          targets: snapshot.destinations.map(({ id, version }) => ({
            id,
            version,
          })),
        };
        assert.ok(
          (await rpc("writeTmStream", independentStop)).results.every(
            (result) => result.success,
          ),
        );
        await check(
          `${root}?.innerText.includes('Retry streaming command')`,
          "lost command response bounded",
        );
        await click("Manage destinations", { link: true });
        await check(
          `location.pathname.endsWith('/streaming/platforms')&&!${root}`,
          "SPA away",
        );
        await evaluate("history.back()");
        await check(
          `${root}?.innerText.includes('Retry streaming command')`,
          "retained request after navigation",
        );
        await evaluate("window.holdTmWrites=false");
        await click("Retry streaming command");
        await check(
          `${root}?.innerText.includes('Go Live request confirmed.')`,
          "historical acknowledgement",
        );
        const calls = (await evaluate("window.tmCalls")).map((body) =>
          fromJSON(JSON.parse(body)),
        );
        assert.equal(calls.length, 2);
        assert.deepEqual(calls[0], calls[1]);
        assert.equal(
          Object.values(await streamOutputSnapshot()).filter(
            (output) => output.enabled,
          ).length,
          0,
          "retry cannot restart after Stop",
        );
        await evaluate(
          "window.tmReplies.splice(0).forEach(release=>release())",
        );
        await evaluate("window.holdTmReads=true");
        await check(
          `${root}?.innerText.includes('Retry streaming feedback')`,
          "feedback timeout",
        );
        assert.equal(
          await evaluate(
            `[...${root}.querySelectorAll('button')].find(n=>n.textContent==='Go live').disabled`,
          ),
          true,
        );
        assert.equal(
          await evaluate(
            `[...${root}.querySelectorAll('button')].find(n=>n.textContent==='Stop stream').disabled`,
          ),
          false,
        );
        await evaluate("window.holdTmReads=false");
        await click("Retry streaming feedback");
        await check(
          `!${root}?.querySelector('[role=alert]')`,
          "read recovered",
        );
        await evaluate(
          "window.tmReplies.splice(0).forEach(release=>release())",
        );
        // A slow provider creation is superseded through the actual dashboard Stop.
        await configureStreamOutputs("slow-create");
        await confirm("Go live", "Go live now");
        await poll(
          async () =>
            (await streamOutputRequests()).filter(
              (request) => request.method === "POST",
            ).length >= 3,
          "slow provider create started",
        );
        await confirm("Stop stream", "Stop destinations");
        await check(
          `${root}?.innerText.includes('Retry streaming command')`,
          "unfinished Stop shown",
        );
        await check(
          "window.tmCompleted.length>=4",
          "older Go Live handler finished",
        );
        await configureStreamOutputs("success");
        await click("Retry streaming command");
        await check(
          `${root}?.innerText.includes('Stop request confirmed.')`,
          "Stop recovers pending creation",
        );
        assert.equal(
          Object.values(await streamOutputSnapshot()).filter(
            (output) => output.enabled,
          ).length,
          0,
        );
        for (const width of [320, 768, 1440]) {
          await page("Emulation.setDeviceMetricsOverride", {
            width,
            height: 1000,
            deviceScaleFactor: 1,
            mobile: false,
          });
          await check(
            `(async()=>{const n=${root};n.scrollIntoView({block:'start'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect();return b.x>=0&&b.right<=innerWidth+1&&n.scrollWidth<=n.clientWidth+1;})()`,
            "panel fits " + width,
          );
          const bounds = await evaluate(
            `[...${root}.querySelectorAll('button,a,select')].map(n=>({height:n.getBoundingClientRect().height,width:n.getBoundingClientRect().width}))`,
          );
          assert.ok(bounds.every((b) => b.height >= 44 && b.width >= 44));
          if (width === 320)
            await writeFile(
              "/tmp/showpilot-tm-stream-320.png",
              Buffer.from(
                (await page("Page.captureScreenshot", { format: "png" })).data,
                "base64",
              ),
            );
        }
        assert.deepEqual(await evaluate("window.tmErrors"), []);
      },
    );
    await stopServer();
    const receipts = await queryFixture(
      `SELECT requestId,targets,completed FROM stream_output_command WHERE orgId='${orgId}'`,
    );
    assert.equal(receipts.length, 4);
    console.log(
      JSON.stringify({
        passed: true,
        commands: receipts.length,
        exactRetryAcrossNavigation: true,
        newerStopRetained: true,
        stopDuringPendingGoLive: true,
        readTimeoutRecovery: true,
        widths: [320, 768, 1440],
        externalProviderWrites: 0,
      }),
    );
  },
  { streamOutputs: "commands", paidPlan: true },
);
