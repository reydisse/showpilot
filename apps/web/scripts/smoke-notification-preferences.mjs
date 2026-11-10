// Real login/D1/compiled UI. Delayed responses never authorize a second preference write.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";
const web = createRequire(new URL("../package.json", import.meta.url));
const router = createRequire(web.resolve("@tanstack/react-router"));
const core = createRequire(router.resolve("@tanstack/router-core"));
const { fromJSON } = core("seroval");
const names = ["getPersonalNotificationPreferences", "updatePersonalNotificationPreference"];
const ids = {}, assets = resolve(import.meta.dirname, "../dist/server/assets");
for (const file of (await readdir(assets)).filter(file => file.endsWith(".js"))) {
  const source = await readFile(resolve(assets, file), "utf8");
  for (const name of names) ids[name] ??= source.match(new RegExp(`const ${name}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`))?.[1];
}
assert.ok(names.every(name => ids[name]));
await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, stopServer, queryFixture }) => {
  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    await page("Page.enable");
    await page("Emulation.setFocusEmulationEnabled", { enabled: true });
    await page("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page("Page.addScriptToEvaluateOnNewDocument", { source: `
      window.preferenceErrors=[];window.preferenceWrites=[];window.preferenceHeld=[];window.preferenceModes={getPersonalNotificationPreferences:'hold'};
      addEventListener('error',e=>window.preferenceErrors.push(e.message));addEventListener('unhandledrejection',e=>window.preferenceErrors.push(String(e.reason)));
      const ids=${JSON.stringify(ids)}, original=window.fetch;
      window.fetch=(input,init)=>{
        const url=input instanceof Request?input.url:String(input), name=Object.keys(ids).find(key=>url.includes('/_serverFn/'+ids[key]));
        if(!name)return original(input,init);
        if(name==='updatePersonalNotificationPreference')window.preferenceWrites.push(init.body);
        const reply=original(input,{...init,signal:new AbortController().signal}).then(async response=>new Response(await response.arrayBuffer(),{status:response.status,headers:response.headers}));
        if(window.preferenceModes[name]==='hold')return new Promise(resolve=>{
          const held={name,signal:init.signal,committed:false,release:async()=>resolve(await reply)};
          window.preferenceHeld.push(held);reply.then(()=>held.committed=true);
        });
        return reply;
      };` });
    const check = async (expression, label, timeout) => {
      try { return await poll(() => evaluate(expression), label, timeout); }
      catch(error) { console.error(JSON.stringify({ label, state: await evaluate(`({url:location.href,errors:window.preferenceErrors,text:document.body?.innerText.slice(-6000)})`) })); throw error; }
    };
    const click = async (name, scope = "document", aria = false) => {
      let point;
      await poll(async () => {
        point = await evaluate(`(async()=>{const root=${scope};const node=[...root.querySelectorAll('button')].find(n=>${aria ? "n.getAttribute('aria-label')" : "n.textContent.trim()"}===${JSON.stringify(name)}&&!n.disabled&&n.getBoundingClientRect().width>0);if(!node)return null;node.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=node.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return node.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`);
        return !!point;
      }, `reachable ${name}`);
      await page("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
      await page("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
    };
    const mode = (name, value) => evaluate(`window.preferenceModes[${JSON.stringify(name)}]=${JSON.stringify(value)};true`);
    const controls = `document.querySelector('section[aria-label="Your notification categories"]')`;
    const ready = () => check(`${controls}?.querySelectorAll('button[role="switch"]').length===5&&![...${controls}.querySelectorAll('button[role="switch"]')].some(n=>n.disabled)`, "editable categories");
    await page("Page.navigate", { url: `${origin}/${orgId}/settings?section=notifications` });
    await check(`!!document.body`, "loaded document");
    await check(`document.body.textContent.includes('Notification choices could not be refreshed')`, "read deadline", 14_000);
    assert.equal(await evaluate(`document.body.textContent.includes('Loading your alert choices…')`), false);
    await mode("getPersonalNotificationPreferences", "normal");
    await click("Retry preferences refresh"); await ready();
    await mode("updatePersonalNotificationPreference", "hold");
    await click("Schedule device alerts", controls, true);
    await check(`window.preferenceHeld.some(h=>h.name==='updatePersonalNotificationPreference'&&h.committed)`, "write committed before withheld reply");
    const native = await fetch(`${origin}/api/mobile/v1/notification-preferences`, { method: "POST", headers: { Cookie: operatorCookie, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ orgId, category: "schedule", deviceAlerts: true, expectedDeviceAlerts: false, requestId: crypto.randomUUID() }) });
    assert.equal(native.status, 200); assert.equal((await native.json()).outcome, "applied");
    await check(`!![...document.querySelectorAll('button')].find(n=>n.textContent==='Retry preference save')`, "save deadline", 14_000);
    await click("Organization"); await check(`!!document.querySelector('select[aria-label="Timezone"]')`, "organization navigation");
    await click("Notifications"); await check(`!![...document.querySelectorAll('button')].find(n=>n.textContent==='Retry preference save')`, "retained request after navigation");
    await mode("updatePersonalNotificationPreference", "normal");
    await click("Retry preference save"); await ready();
    await check(`document.body.textContent.includes('A newer alert choice is in effect')`, "superseded receipt");
    assert.equal(await evaluate(`document.querySelector('button[aria-label="Schedule device alerts"]').getAttribute('aria-checked')`), "true");
    const attempts = (await evaluate("window.preferenceWrites")).map(body => fromJSON(JSON.parse(body)).data);
    console.log(JSON.stringify({ requestKeys: attempts.map(value => Object.keys(value)), sameRequestId: attempts[0].requestId === attempts[1].requestId }));
    assert.deepEqual(attempts[1], attempts[0], "Exact command survives navigation and retry");
    await mode("getPersonalNotificationPreferences", "hold");
    await click("Chat device alerts", controls, true);
    await check(`document.body.textContent.includes('Notification choices could not be refreshed')`, "post-save read deadline", 14_000);
    assert.equal(await evaluate(`!![...document.querySelectorAll('button')].find(n=>n.textContent==='Retry preference save')`), false);
    const writeCount = await evaluate("window.preferenceWrites.length");
    for (const width of [320,768,1440]) {
      await page("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await check(`document.documentElement.scrollWidth<=innerWidth+1`, "notification settings fit");
      const geometry = await evaluate(`[...${controls}.querySelectorAll('button')].map(n=>({width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height}))`);
      assert.ok(geometry.length>=6&&geometry.every(r=>r.width>=44&&r.height>=44));
      if (width===320) await writeFile("/tmp/showpilot-notification-preferences-320.png",Buffer.from((await page("Page.captureScreenshot", { format: "png" })).data,"base64"));
    }
    await mode("getPersonalNotificationPreferences", "normal");
    await click("Retry preferences refresh"); await ready();
    assert.equal(await evaluate("window.preferenceWrites.length"), writeCount, "Refresh cannot repeat a saved change");
    await evaluate("Promise.all(window.preferenceHeld.map(h=>h.release())).then(()=>true)");
    assert.equal(await evaluate(`document.querySelector('button[aria-label="Chat device alerts"]').getAttribute('aria-checked')`), "false");
    // Open the real inbox and verify it edits the same personal choices.
    await click("Notifications", "document", true);
    await check(`!!document.querySelector('[role="dialog"]')`, "notification inbox");
    await click("Preferences", `document.querySelector('[role="dialog"]')`);
    const inbox = `document.querySelector('[role="dialog"]')`;
    await check(`${inbox}.querySelector('button[aria-label="Chat device alerts"]')?.getAttribute('aria-checked')==='false'`, "shared inbox choice");
    await click("Reports device alerts", inbox, true);
    await check(`${inbox}.querySelector('button[aria-label="Reports device alerts"]')?.getAttribute('aria-checked')==='false'&&!${inbox}.querySelector('button[aria-label="Reports device alerts"]').disabled`, "inbox save");
    await page("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await page("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await check(`!document.querySelector('[role="dialog"]')`, "inbox closed");
    await check(`${controls}.querySelector('button[aria-label="Reports device alerts"]')?.getAttribute('aria-checked')==='false'`, "settings shares inbox save");
    assert.deepEqual(await evaluate("window.preferenceErrors"), []);
  });
  await stopServer();
  assert.deepEqual(await queryFixture(`SELECT category,deviceAlerts FROM notification_preference WHERE orgId='${orgId}' ORDER BY category`), [{ category: "chat", deviceAlerts: 0 },{ category: "reports", deviceAlerts: 0 },{ category: "schedule", deviceAlerts: 1 }]);
  assert.equal((await queryFixture(`SELECT requestId FROM notification_preference_receipt WHERE orgId='${orgId}'`)).length, 4);
  assert.deepEqual(await queryFixture("SELECT id FROM notification_preference WHERE orgId='display-other'"), []);
  console.log(JSON.stringify({ passed: true, boundedReadsAndWrites: true, exactRetryAfterNativeChange: true, sharedSettingsAndInbox: true, refreshOnlyRetry: true, receipts: 4, widths: [320,768,1440] }));
}, { paidPlan: true });
