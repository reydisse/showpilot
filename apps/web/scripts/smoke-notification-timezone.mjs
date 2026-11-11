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
const ids = {}, names = ["getPersonalNotificationTimeZone", "savePersonalNotificationTimeZone"];
const assets = resolve(import.meta.dirname, "../dist/server/assets");
for (const file of (await readdir(assets)).filter(f => f.endsWith(".js"))) {
  const source = await readFile(resolve(assets, file), "utf8");
  for (const name of names) ids[name] ??= source.match(new RegExp(`const ${name}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`))?.[1];
}
assert.ok(names.every(name => ids[name]));
await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, capturedEmails }) => {
  async function rpc(name, data = {}) {
    const payload = JSON.stringify(await toJSONAsync({ data: { orgId, ...data } })),
      url = `${origin}/_serverFn/${ids[name]}`,
      headers = { Cookie: operatorCookie, Origin: origin, "Sec-Fetch-Site": "same-origin", "x-tsr-serverFn": "true", "Content-Type": "application/json" },
      read = name === names[0];
    const response = await fetch(read ? `${url}?payload=${encodeURIComponent(payload)}` : url,
      read ? { headers } : { method: "POST", headers, body: payload });
    assert.equal(response.status, 200);
    const reply = fromCrossJSON(await response.json(), { refs: new Map(), plugins: defaultSerovalPlugins });
    assert.equal(reply.error, undefined);
    assert.equal(reply instanceof Error, false);
    return reply.result;
  }
  assert.deepEqual(await rpc(names[0]), { timeZone: "America/Vancouver", revision: 1 }, "Migration preserves the old preference and backfills revision");
  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    await page("Page.enable");
    await page("Emulation.setFocusEmulationEnabled", { enabled: true });
    await page("Emulation.setTimezoneOverride", { timezoneId: "America/Toronto" });
    await page("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page("Page.addScriptToEvaluateOnNewDocument", { source: `
      window.zoneReads='hold';window.zoneWrites='hold';window.zoneCalls=[];window.zoneHeld=[];window.zoneErrors=[];window.zoneDocument='same';
      addEventListener('error',e=>zoneErrors.push(e.message));addEventListener('unhandledrejection',e=>zoneErrors.push(String(e.reason)));
      const original=fetch;window.fetch=async(input,options)=>{
        const url=input instanceof Request?input.url:String(input),write=url.includes('/_serverFn/${ids[names[1]]}'),read=url.includes('/_serverFn/${ids[names[0]]}');
        if(!write&&!read)return original(input,options);
        if(write)zoneCalls.push(options.body);
        const hold=(write?zoneWrites:zoneReads)==='hold';
        const response=await original(input,hold?{...options,signal:new AbortController().signal}:options);
        if(!hold)return response;
        const bytes=await response.arrayBuffer();return new Promise(resolve=>zoneHeld.push(()=>resolve(new Response(bytes,{status:response.status,headers:response.headers}))));
      };` });
    const check = (expression, label, timeout = 15_000) => poll(() => evaluate(expression), label, timeout).catch(async error => {
      console.error(JSON.stringify({ label, state: await evaluate("({text:document.body.innerText,errors:zoneErrors,calls:zoneCalls})") }));
      throw error;
    });
    const button = text => `[...document.querySelectorAll('button')].find(el=>el.textContent.trim()===${JSON.stringify(text)}&&el.getBoundingClientRect().width>0)`;
    const click = async expression => {
      const point = await check(`(async()=>{const el=${expression};if(!el||el.disabled||!Object.keys(el).some(k=>k.startsWith('__reactProps')))return null;el.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=el.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return el.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`, "reachable timezone control");
      for (const type of ["mousePressed", "mouseReleased"]) await page("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, ...point });
    };
    await page("Page.navigate", { url: `${origin}/${orgId}/show` });
    await click(`document.querySelector('button[title="Account menu"]')`);
    await check(`!!${button("Retry timezone check")}`, "initial read deadline");
    assert.equal(await evaluate("document.querySelector('[aria-label=\"Alert timezone\"]').textContent.includes('workspace default')"), false);
    assert.equal(await evaluate("zoneCalls.length"), 0);
    await evaluate("zoneReads='normal';zoneHeld.splice(0).forEach(release=>release());true");
    assert.equal(await evaluate(`!!${button("Retry timezone check")}`), true, "Late read cannot clear failure");
    await click(button("Retry timezone check"));
    await check("zoneCalls.length===1&&zoneHeld.length===1", "automatic device save committed with held reply");
    const original = fromJSON(JSON.parse((await evaluate("zoneCalls"))[0])).data;
    assert.equal(original.timeZone, "America/Toronto", "Never saves SSR UTC");
    assert.equal(original.expectedRevision, 1);
    assert.deepEqual(await rpc(names[0]), { timeZone: "America/Toronto", revision: 2 });
    await rpc(names[1], { requestId: crypto.randomUUID(), expectedRevision: 2, timeZone: "Europe/London" });
    await page("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await page("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await check("!document.querySelector('[role=dialog]')", "account menu closes");
    await check("!!document.querySelector('button[aria-label=\"Alert timezone needs attention\"]')", "background reports uncertain save");
    await click(`document.querySelector('button[aria-label="Alert timezone needs attention"]')`);
    await check(`!!${button("Retry timezone save")}`, "uncertain command retained on reopen");
    for (const [width, height] of [[320,480],[768,900],[1440,900]]) {
      await page("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await check(`(()=>{const el=${button("Retry timezone save")};el.scrollIntoView({block:'center'});const b=el.getBoundingClientRect();return b.width>=44&&b.height>=44&&b.left>=0&&b.right<=innerWidth&&el.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2));})()`, `Timezone retry fits ${width}`);
      if (width===320) await writeFile("/tmp/showpilot-timezone-320.png", Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));
    }
    await evaluate("zoneWrites='normal';zoneHeld.splice(0).forEach(release=>release());true");
    assert.equal(await evaluate(`!!${button("Retry timezone save")}`), true);
    await click(button("Retry timezone save"));
    await check("document.body.innerText.includes('A newer timezone is in effect')", "old retry preserves newer setting");
    assert.deepEqual(fromJSON(JSON.parse((await evaluate("zoneCalls"))[1])).data, original);
    assert.deepEqual(await rpc(names[0]), { timeZone: "Europe/London", revision: 3 });
    assert.equal(await evaluate("zoneCalls.length"), 2);
    await evaluate("zoneReads='hold';true");
    await click(button("Use this device’s timezone (America/Toronto)"));
    await check(`!!${button("Retry timezone check")}`, "confirmed save with failed refresh");
    assert.equal(await evaluate(`!!${button("Retry timezone save")}`), false);
    const explicit = fromJSON(JSON.parse((await evaluate("zoneCalls"))[2])).data;
    assert.notEqual(explicit.requestId, original.requestId);
    assert.equal(explicit.expectedRevision, 3);
    await evaluate("zoneReads='normal';zoneHeld.splice(0).forEach(release=>release());true");
    await click(button("Retry timezone check"));
    await check("document.querySelector('[aria-label=\"Alert timezone\"]').innerText.includes('Last confirmed timezone: America/Toronto')&&!document.querySelector('[aria-label=\"Alert timezone\"] [role=alert]')", "read retry recovers");
    assert.equal(await evaluate("zoneCalls.length"), 3, "Read retry does not repeat an acknowledged write");
    assert.deepEqual(await rpc(names[0]), { timeZone: "America/Toronto", revision: 4 });
    assert.equal(await evaluate("zoneDocument"), "same");
    assert.deepEqual(await evaluate("zoneErrors"), []);
  });
  assert.equal((await capturedEmails()).length, 0);
  console.log(JSON.stringify({ passed: true, migrationBackfill: true, realDeviceZone: true, readDeadline: true, lostReply: true, exactRetry: true, newerDevicePreserved: true, refreshRetryOnly: true, widths: [320,768,1440], capturedEmails: 0 }));
}, { notificationTimezoneRecovery: true, captureEmail: true });
