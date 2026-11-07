// Local compiled app: commit saves in D1, lose their replies, then recover through the UI.
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";
const audit = process.argv.includes("--audit");
const assets = resolve(import.meta.dirname, "../dist/server/assets"), ids = {};
for (const name of (await readdir(assets)).filter(name => name.endsWith(".js"))) {
  const source = await readFile(resolve(assets, name), "utf8");
  for (const fn of ["getStreamDestinations", "addStreamDestination", "updateStreamDestination"]) ids[fn] ??= source.match(new RegExp(`const ${fn}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`))?.[1];
}
for (const fn of ["getStreamDestinations", "addStreamDestination", "updateStreamDestination"]) assert.ok(ids[fn], fn);
await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, stopServer, queryFixture }) => {
  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    await page("Emulation.setFocusEmulationEnabled", { enabled: true });
    await page("Page.enable");
    await page("Page.addScriptToEvaluateOnNewDocument", { source: `window.saveErrors=[];window.saveRequests=[];window.saveHold=null;window.saveReplies=[];
      addEventListener('error',e=>window.saveErrors.push(e.message));addEventListener('unhandledrejection',e=>window.saveErrors.push(String(e.reason)));
      const original=window.fetch;window.fetch=(input,options)=>{const url=input instanceof Request?input.url:String(input);const kind=Object.entries(${JSON.stringify(ids)}).find(([kind,id])=>url.includes(id))?.[0];if(!kind)return original(input,options);window.saveRequests.push({kind,body:options?.body});const held=window.saveHold===kind;const reply=original(input,options);return held?reply.then(async r=>{const body=await r.text();return new Promise(resolve=>window.saveReplies.push({kind,status:r.status,hasKey:body.includes('fixture-only-key'),release:()=>resolve(new Response(body,{status:r.status,headers:r.headers}))}));}):reply;};` });
    const check = (code, label) => poll(() => evaluate(code), label).catch(async error => {
      console.log(JSON.stringify({ label, body: await evaluate("document.body?.innerText"), errors: await evaluate("window.saveErrors") })); throw error;
    });
    const button = name => `[...([...document.querySelectorAll('[role=dialog]')].at(-1)??document.querySelector('form')??document).querySelectorAll('button,a')].find(n=>(n.textContent.trim()===${JSON.stringify(name)}||n.getAttribute('aria-label')===${JSON.stringify(name)})&&n.getBoundingClientRect().height>0&&!n.disabled)`;
    const click = async name => {
      const p = await check(`(async()=>{const n=${button(name)};if(!n||!Object.keys(n).some(k=>k.startsWith('__reactProps')))return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return !n.disabled&&n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`, name);
      await page("Input.dispatchMouseEvent", { type: "mousePressed", ...p, button: "left", clickCount: 1 });
      await page("Input.dispatchMouseEvent", { type: "mouseReleased", ...p, button: "left", clickCount: 1 });
    };
    const fill = async (selector, value) => {
      await check(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});return n&&Object.keys(n).some(k=>k.startsWith('__reactProps'));})()`, "hydrated field");
      await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    };
    const hold = kind => evaluate(`window.saveHold=${JSON.stringify(kind)}`);
    const waitReady = () => check("!document.querySelector('[role=dialog]')&&!document.body.innerText.includes('Refreshing destinations')", "destination list ready");
    const retry = async kind => {
      await check(`${button("Retry change")}!=null`, `${kind} timeout`);
      await hold(null); await click("Retry change"); await waitReady();
      const requests = await evaluate(`window.saveRequests.filter(r=>r.kind===${JSON.stringify(kind)}).map(r=>r.body)`);
      assert.equal(requests.at(-1), requests.at(-2), "Retry must retain the same fields and request ID");
    };
    const key = async (name, code, number, text) => {
      await page("Input.dispatchKeyEvent", { type: "keyDown", key: name, code, windowsVirtualKeyCode: number, ...(text ? { text } : {}) });
      await page("Input.dispatchKeyEvent", { type: "keyUp", key: name, code, windowsVirtualKeyCode: number });
    };
    await page("Page.navigate", { url: `${origin}/display-smoke/streaming/platforms` });
    await click("Add Destination");
    if (audit) {
      await fill('form input[type="text"]', "Recovery fixture"); await fill('input[type="password"]', "fixture-only-key");
      await hold("addStreamDestination"); await click("Add");
      await check("window.saveReplies.some(r=>r.kind==='addStreamDestination'&&r.status===200)", "baseline create committed");
      await evaluate("window.auditStarted=Date.now()");
      await check("Date.now()-window.auditStarted>=11_000", "baseline deadline elapsed");
      assert.equal(await evaluate("[...document.querySelectorAll('button')].some(n=>n.textContent.includes('Saving...')&&n.disabled)"), true);
      assert.equal(await evaluate("document.body.innerText.includes('Retry change')"), false);
      assert.equal(await evaluate("window.saveReplies.some(r=>r.hasKey)"), true);
      console.log(JSON.stringify({ audit: "Lost create response leaves Saving indefinitely and the response contains the stream key" })); return;
    }
    await check("document.querySelector('[role=dialog]')?.getAttribute('aria-modal')==='true'", "shared dialog");
    for (let i=0;i<12;i++) { await key("Tab", "Tab", 9); assert.equal(await evaluate("!!document.activeElement.closest('[role=dialog]')"), true); }
    await key("Escape", "Escape", 27); await waitReady();
    await click("Add Destination"); await fill("#destination-name", "Recovery fixture"); await fill("#destination-key", "fixture-only-key");
    await hold("addStreamDestination"); await click("Add destination");
    await check("window.saveReplies.some(r=>r.kind==='addStreamDestination'&&r.status===200)", "create committed");
    assert.equal(await evaluate("window.saveReplies.some(r=>r.hasKey)"), false);
    await check(`${button("Retry change")}!=null`, "lost create response bounded");
    await click("Close destination editor"); await waitReady();
    await click("Songs"); await check("document.body.innerText.includes('Leave Multi-Platform?')", "navigation protects pending save");
    await click("Stay"); await waitReady(); await click("Review destination draft");
    assert.equal(await evaluate("document.querySelector('#destination-name').value"), "Recovery fixture");
    assert.equal(await evaluate("document.querySelector('#destination-key').value"), "fixture-only-key");
    for (const [width,height] of [[320,740],[768,1024],[1440,1000]]) {
      await page("Emulation.setDeviceMetricsOverride", { width,height,deviceScaleFactor:1,mobile:false });
      await check(`(async()=>{const n=${button("Retry change")};n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect();return b.height>=44&&b.left>=0&&b.right<=innerWidth&&n.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))&&[...document.querySelectorAll('[role=dialog] input,[role=dialog] button')].every(n=>{const b=n.getBoundingClientRect();return b.height>=44&&b.left>=0&&b.right<=innerWidth+1;});})()`, `controls at ${width}`);
      if (width===320) await writeFile("/tmp/showpilot-stream-destination-320.png", Buffer.from((await page("Page.captureScreenshot", { format: "png" })).data, "base64"));
    }
    await retry("addStreamDestination");
    await check("document.body.innerText.includes('Recovery fixture')", "saved destination visible");
    await click("Add Destination"); await fill("#destination-name", "Refresh fixture"); await fill("#destination-key", "fixture-only-key");
    await hold("getStreamDestinations"); await click("Add destination");
    await check(`${button("Retry refresh")}!=null`, "acknowledged creation / failed refresh");
    const creates = await evaluate("window.saveRequests.filter(r=>r.kind==='addStreamDestination').length");
    await hold(null); await click("Retry refresh"); await waitReady();
    assert.equal(await evaluate("window.saveRequests.filter(r=>r.kind==='addStreamDestination').length"), creates);
    await click("Edit Recovery fixture");
    assert.equal(await evaluate("document.querySelector('#destination-key').value"), "");
    await fill("#destination-name", "Edited fixture"); await hold("updateStreamDestination");
    await evaluate("document.querySelector('#destination-name').focus()"); await key("Enter", "Enter", 13, "\r");
    await retry("updateStreamDestination");
    await click("Edit Edited fixture"); await fill("#destination-key", "replacement-only-key");
    await hold("updateStreamDestination"); await click("Update destination"); await retry("updateStreamDestination");
    await click("Edit Edited fixture"); await fill("#destination-name", "Discarded draft");
    await key("Escape", "Escape", 27); await check("document.querySelectorAll('[role=dialog]').length===2", "dirty draft confirmation");
    await click("Cancel"); await check("document.querySelectorAll('[role=dialog]').length===1", "cancel keeps editor");
    assert.equal(await evaluate("document.querySelector('#destination-name').value"), "Discarded draft");
    await click("Cancel"); await click("Discard draft"); await waitReady();
    await evaluate("window.saveReplies.forEach(reply=>reply.release());window.saveReplies=[]");
    await check("document.body.innerText.includes('Edited fixture')&&!document.body.innerText.includes('Discarded draft')", "late responses ignored");
    assert.equal(await evaluate("window.saveErrors.length"), 0);
    console.log(JSON.stringify({ browser: "lost create/edit replies, exact retries, retained drafts, refresh-only recovery, credential masking, keyboard, discard and 320/768/1440px passed" }));
  });
  await stopServer();
  const rows = await queryFixture(`SELECT id,name,streamKey,enabled FROM stream_destination WHERE orgId='${orgId}' ORDER BY name`);
  if (audit) { assert.equal(rows.length,1); return; }
  assert.deepEqual(rows.map(row=>row.name), ["Edited fixture", "Refresh fixture"]);
  for (const row of rows) { assert.match(row.streamKey,/^spenc:v1:/); assert.equal(row.enabled,0); }
  assert.equal(rows.some(row=>row.streamKey.includes("only-key")),false);
  const receipts = await queryFixture(`SELECT count(*) n FROM stream_destination_write_receipt WHERE orgId='${orgId}'`);
  assert.equal(receipts[0].n,4);
  console.log(JSON.stringify({ persisted: "2 destinations, 4 distinct saves, encrypted keys, all outputs disabled" }));
});
