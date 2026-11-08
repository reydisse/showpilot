// Actual compiled Worker, authentication, Chrome, D1, and lower-third relay.
// Publications and commands use disposable fixture outputs only.
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
  names = [
    "getTmGraphicsState",
    "writeTmGraphicsClear",
    "publishGraphicComposition",
  ],
  assets = resolve(import.meta.dirname, "../dist/server/assets");
for (const file of (await readdir(assets)).filter((file) =>
  file.endsWith(".js"),
)) {
  const source = await readFile(resolve(assets, file), "utf8");
  assert.equal(
    /(?:runTmControl|getTmControlState)_createServerFn_handler/.test(source),
    false,
    "Retired technical RPCs must not be registered",
  );
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
    pass,
    stopServer,
    queryFixture,
    capturedEmails,
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
        read = name === "getTmGraphicsState";
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
    const read = () => rpc("getTmGraphicsState");
    async function publish(title) {
      await rpc("publishGraphicComposition", {
        requestId: crypto.randomUUID(),
        items: [
          { key: "fixture", name: title, title, subtitle: "", style: "{}" },
        ],
      });
    }
    async function lowerThird(line1) {
      const response = await fetch(
        `${origin}/api/lowerthirds/${orgId}/trigger`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ id: crypto.randomUUID(), line1 }),
        },
      );
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    }
    async function output() {
      const headers = { "x-showpilot-display-pass": pass("overlay") };
      const [program, legacy] = await Promise.all([
        fetch(`${origin}/api/overlay/${orgId}`, { headers }),
        fetch(`${origin}/api/lowerthirds/${orgId}/current`, { headers }),
      ]);
      assert.equal(program.status, 200);
      assert.equal(legacy.status, 200);
      return { program: await program.json(), legacy: await legacy.json() };
    }
    await publish("Reviewed Program");
    await lowerThird("Reviewed lower third");
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
          source: `window.tmCalls=[];window.tmErrors=[];window.tmReplies=[];window.holdTmWrites=true;window.holdTmReads=false;addEventListener('error',e=>window.tmErrors.push(e.message));addEventListener('unhandledrejection',e=>window.tmErrors.push(String(e.reason)));const original=fetch;window.fetch=async(input,options)=>{const url=input instanceof Request?input.url:String(input),write=url.includes('/_serverFn/${ids.writeTmGraphicsClear}'),read=url.includes('/_serverFn/${ids.getTmGraphicsState}');if(write)window.tmCalls.push(options.body);const held=(write&&window.holdTmWrites)||(read&&window.holdTmReads);const response=await original(input,options);if(held){const body=await response.text();return new Promise(resolve=>window.tmReplies.push(()=>resolve(new Response(body,{status:response.status,headers:response.headers}))));}return response;};`,
        });
        const root = `document.querySelector('section[aria-label="Graphics controls"]')`;
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
        await page("Page.navigate", {
          url: `${origin}/${orgId}/dashboard/tech-manager`,
        });
        await check(
          `${root}?.innerText.includes('Reviewed Program')&&${root}?.innerText.includes('Reviewed lower third')`,
          "both output paths visible",
        );
        await evaluate(
          `window.ltMessages=[];window.ltSocket=new WebSocket(location.origin.replace(/^http/,'ws')+'/api/lowerthirds/${orgId}/ws');window.ltSocket.onmessage=e=>window.ltMessages.push(JSON.parse(e.data));`,
        );
        await check(
          "window.ltMessages.some(m=>m.action==='show')",
          "live lower-third socket",
        );
        await click("Clear graphics");
        await check(
          `document.querySelector('[role=dialog]')?.innerText.includes('Reviewed Program, Reviewed lower third')`,
          "named clear confirmation",
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
          if (width === 320)
            await writeFile(
              "/tmp/showpilot-tm-graphics-confirm-320.png",
              Buffer.from(
                (await page("Page.captureScreenshot", { format: "png" })).data,
                "base64",
              ),
            );
        }
        await click("Cancel", { dialog: true });
        await check(`!document.querySelector('[role=dialog]')`, "cancel");
        assert.equal((await evaluate("window.tmCalls")).length, 0);
        await click("Clear graphics");
        await click("Clear graphics now", { dialog: true });
        await poll(async () => {
          const state = await output();
          return !state.program.length && state.legacy.current === null;
        }, "both actual display outputs cleared");
        await check(
          "window.ltMessages.filter(m=>m.action==='clear').length===1",
          "clear broadcast received",
        );
        await publish("Newer Program");
        await lowerThird("Newer lower third");
        await check(
          `${root}?.innerText.includes('Retry graphics clear')`,
          "bounded lost clear reply",
        );
        await click("Open Graphics", { link: true });
        await check(
          `location.pathname.endsWith('/streaming/graphics')&&!${root}`,
          "SPA navigation away",
        );
        await evaluate("history.back()");
        await check(
          `${root}?.innerText.includes('Retry graphics clear')`,
          "pending clear retained across navigation",
        );
        await evaluate("window.holdTmWrites=false");
        await click("Retry graphics clear");
        await check(
          `${root}?.innerText.includes('Clear request confirmed.')`,
          "original receipt recovered",
        );
        const calls = (await evaluate("window.tmCalls")).map((body) =>
          fromJSON(JSON.parse(body)),
        );
        assert.equal(calls.length, 2);
        assert.deepEqual(calls[0], calls[1]);
        let projected = await output();
        assert.equal(projected.program[0].title, "Newer Program");
        assert.equal(projected.legacy.current.line1, "Newer lower third");
        assert.equal(
          await evaluate(
            "window.ltMessages.filter(m=>m.action==='clear').length",
          ),
          1,
        );
        await evaluate(
          "window.tmReplies.splice(0).forEach(release=>release())",
        );
        await evaluate("window.holdTmReads=true");
        await check(
          `${root}?.innerText.includes('Retry graphics feedback')`,
          "feedback timeout",
        );
        await publish("Later Program");
        await lowerThird("Later lower third");
        await evaluate("window.holdTmReads=false");
        await click("Retry graphics feedback");
        await check(
          `${root}?.innerText.includes('Later Program')&& !${root}?.querySelector('[role=alert]')`,
          "read recovered",
        );
        await evaluate(
          "window.tmReplies.splice(0).forEach(release=>release())",
        );
        await click("Clear graphics");
        await publish("After review Program");
        await lowerThird("After review lower third");
        await check(
          `${root}?.innerText.includes('After review Program')`,
          "new publication after review",
        );
        await click("Clear graphics now", { dialog: true });
        await check(
          `${root}?.innerText.includes('Graphics changed after confirmation.')`,
          "stale clear rejected",
        );
        projected = await output();
        assert.equal(projected.program[0].title, "After review Program");
        assert.equal(
          projected.legacy.current.line1,
          "After review lower third",
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
            `[...${root}.querySelectorAll('button,a')].map(n=>({height:n.getBoundingClientRect().height,width:n.getBoundingClientRect().width}))`,
          );
          assert.ok(bounds.every((b) => b.height >= 44 && b.width >= 44));
          if (width === 320)
            await writeFile(
              "/tmp/showpilot-tm-graphics-320.png",
              Buffer.from(
                (await page("Page.captureScreenshot", { format: "png" })).data,
                "base64",
              ),
            );
        }
        await click("Clear graphics");
        await click("Clear graphics now", { dialog: true });
        await poll(async () => {
          const state = await output();
          return !state.program.length && state.legacy.current === null;
        }, "fresh clear confirmed on displays");
        await check(
          "window.ltMessages.filter(m=>m.action==='clear').length===2",
          "second intentional clear broadcast",
        );
        await evaluate("window.ltSocket.close()");
        assert.deepEqual(await evaluate("window.tmErrors"), []);
      },
    );
    await stopServer();
    const receipts = await queryFixture(
      `SELECT programOutcome,relayOutcome FROM graphics_clear_receipt WHERE orgId='${orgId}'`,
    );
    assert.equal(receipts.length, 3);
    assert.equal(
      receipts.filter(
        (r) => r.programOutcome === "conflict" && r.relayOutcome === "skipped",
      ).length,
      1,
    );
    assert.equal(
      (
        await queryFixture(
          `SELECT id FROM graphic_template WHERE orgId='${orgId}'`,
        )
      ).length,
      5,
    );
    assert.equal((await capturedEmails()).length, 0);
    console.log(
      JSON.stringify({
        passed: true,
        commands: receipts.length,
        retiredRpcAbsent: true,
        namedConfirmation: true,
        bothDisplayOutputsClear: true,
        exactRetryAcrossNavigation: true,
        newerPublicationsRetained: true,
        staleConfirmationRejected: true,
        readTimeoutRecovery: true,
        widths: [320, 768, 1440],
        savedTemplatesRetained: 5,
        externalEmails: 0,
      }),
    );
  },
  { captureEmail: true, paidPlan: true },
);
