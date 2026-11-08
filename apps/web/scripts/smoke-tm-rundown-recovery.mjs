// Built Worker + real Chrome: lost transport replies, exact retries and display confirmation.
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
  names = ["getTmRundownState", "writeTmRundown"],
  assets = resolve(import.meta.dirname, "../dist/server/assets");
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
  async ({
    origin,
    orgId,
    date,
    operatorCookie,
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
        read = name === "getTmRundownState";
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
    async function relay(action, payload) {
      const response = await fetch(
        `${origin}/api/rundown/${orgId}/command?showId=smoke-show&serviceDate=${date}`,
        { method: "POST", headers, body: JSON.stringify({ action, payload }) },
      );
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.notEqual(result.ok, false);
    }
    const items = [1, 2, 3, 4].map((n) => ({
      id: `tm-${n}`,
      title: `Technical rehearsal item ${n}`,
      type: "segment",
      duration: 60000,
      status: "upcoming",
      sortOrder: n,
      notes: "",
      assignee: "",
      cue: "",
      hardStop: false,
    }));
    await relay("seed", { force: true, items });
    await relay("timer-start", { itemId: "tm-1" });
    await relay("pp-output-enabled", { enabled: true });
    const read = () => rpc("getTmRundownState");
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
          source: `window.tmCalls=[];window.tmErrors=[];window.tmReplies=[];window.holdTmWrites=true;window.holdTmReads=false;addEventListener('error',e=>window.tmErrors.push(e.message));addEventListener('unhandledrejection',e=>window.tmErrors.push(String(e.reason)));const original=fetch;window.fetch=async(input,options)=>{const url=input instanceof Request?input.url:String(input),write=url.includes('/_serverFn/${ids.writeTmRundown}'),read=url.includes('/_serverFn/${ids.getTmRundownState}');if(write)window.tmCalls.push(options.body);const response=await original(input,options);if((write&&window.holdTmWrites)||(read&&window.holdTmReads)){const body=await response.text();return new Promise(resolve=>window.tmReplies.push(()=>resolve(new Response(body,{status:response.status,headers:response.headers}))));}return response;};`,
        });
        const root = `document.querySelector('section[aria-label="Rundown controls"]')`;
        const check = (expression, label) =>
          poll(() => evaluate(expression), label).catch(async (error) => {
            console.log(
              JSON.stringify({
                label,
                body: await evaluate("document.body?.innerText"),
                errors: await evaluate("window.tmErrors"),
                calls: await evaluate("window.tmCalls"),
              }),
            );
            throw error;
          });
        const click = async (text, { link = false, dialog = false } = {}) => {
          const point = await check(
            `(async()=>{const root=${dialog ? "document.querySelector('[role=dialog]')" : root};if(!root||root.getAnimations({subtree:true}).some(a=>a.playState!=='finished'))return null;const n=[...root.querySelectorAll('${link ? "a" : "button"}')].find(n=>n.textContent.trim().startsWith(${JSON.stringify(text)})&&!n.disabled);if(!n)return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`,
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
          `${root}?.innerText.includes('Technical rehearsal item 1')`,
          "confirmed active item",
        );
        await click("Next");
        await poll(
          async () => (await read()).currentItem?.id === "tm-2",
          "first Next applied",
        );
        await relay("timer-next");
        assert.equal((await read()).currentItem.id, "tm-3");
        await check(
          `${root}?.innerText.includes('Retry rundown command')`,
          "lost reply recovery",
        );
        await click("Open rundown", { link: true });
        await check(
          `location.pathname.endsWith('/rundown')&&!${root}`,
          "SPA navigation away",
        );
        await evaluate("history.back()");
        await check(
          `${root}?.innerText.includes('Retry rundown command')`,
          "pending command retained",
        );
        await evaluate("window.holdTmWrites=false");
        const revision = (await read()).revision;
        await click("Retry rundown command");
        await check(
          `${root}?.innerText.includes('Command confirmed.')`,
          "receipt acknowledgement",
        );
        const calls = (await evaluate("window.tmCalls")).map((body) =>
          fromJSON(JSON.parse(body)),
        );
        assert.equal(calls.length, 2);
        assert.deepEqual(calls[0], calls[1]);
        assert.equal((await read()).currentItem.id, "tm-3");
        assert.equal((await read()).revision, revision);
        await evaluate(
          "window.tmReplies.splice(0).forEach(release=>release())",
        );
        await check(
          `${root}?.innerText.includes('Technical rehearsal item 3')`,
          "newer state retained",
        );
        await evaluate("window.holdTmReads=true");
        await check(
          `${root}?.innerText.includes('Retry rundown feedback')`,
          "bounded read failure",
        );
        assert.equal(
          await evaluate(
            `[...${root}.querySelectorAll('button')].find(n=>n.textContent.trim().startsWith('Next')).disabled`,
          ),
          true,
        );
        await evaluate("window.holdTmReads=false");
        await click("Retry rundown feedback");
        await check(
          `!${root}?.querySelector('[role=alert]')`,
          "read recovered",
        );
        await evaluate(
          "window.tmReplies.splice(0).forEach(release=>release())",
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
            "control panel fits " + width,
          );
          const bounds = await evaluate(
            `[...${root}.querySelectorAll('button,a')].map(n=>({text:n.textContent,height:n.getBoundingClientRect().height,width:n.getBoundingClientRect().width}))`,
          );
          assert.ok(bounds.every((b) => b.height >= 44 && b.width >= 44));
          await click("Lyrics off");
          await check(
            `!!document.querySelector('[role=dialog]')`,
            "lyrics confirmation",
          );
          assert.equal((await read()).lyricsEnabled, true);
          assert.equal(
            await evaluate(
              `(()=>{const b=document.querySelector('[role=dialog]').getBoundingClientRect();return b.x>=0&&b.right<=innerWidth+1})()`,
            ),
            true,
          );
          await click("Cancel", { dialog: true });
          await check(
            `!document.querySelector('[role=dialog]')`,
            "cancelled lyrics clear",
          );
          if (width === 320) {
            await evaluate(`${root}.scrollIntoView({block:'start'})`);
            await writeFile(
              "/tmp/showpilot-tm-rundown-320.png",
              Buffer.from(
                (await page("Page.captureScreenshot", { format: "png" })).data,
                "base64",
              ),
            );
          }
        }
        await click("Lyrics off");
        await click("Hide lyrics", { dialog: true });
        await poll(
          async () => !(await read()).lyricsEnabled,
          "lyrics disabled",
        );
        await click("End show");
        assert.equal((await read()).timer.playback, "play");
        await click("End show", { dialog: true });
        await poll(
          async () => (await read()).timer.playback === "stop",
          "confirmed show end",
        );
        assert.deepEqual(await evaluate("window.tmErrors"), []);
      },
    );
    await stopServer();
    const receipts = await queryFixture(
      `SELECT requestId,outcome FROM tm_rundown_command_receipt WHERE orgId='${orgId}'`,
    );
    assert.equal(receipts.length, 3);
    assert.ok(receipts.every((r) => r.outcome === "applied"));
    assert.equal((await capturedEmails()).length, 0);
    console.log(
      JSON.stringify({
        passed: true,
        lostReply: true,
        exactRetryAcrossNavigation: true,
        newerItemRetained: true,
        readTimeoutRecovery: true,
        confirmedLyricsAndEndShow: true,
        widths: [320, 768, 1440],
        receipts: receipts.length,
        externalEmails: 0,
      }),
    );
  },
  { captureEmail: true, paidPlan: true },
);
