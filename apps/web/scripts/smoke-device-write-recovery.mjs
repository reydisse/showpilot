// Real D1 commits with lost replies, same-request Retry and post-save refresh recovery.
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";
const assets = resolve(import.meta.dirname, "../dist/server/assets");
const ids = {};
for (const name of (await readdir(assets)).filter(name => name.endsWith(".js"))) {
  const source = await readFile(resolve(assets, name), "utf8");
  for (const fn of ["getDevices", "addDevice", "updateDevice", "deleteDevice"]) ids[fn] ??= source.match(new RegExp(`const ${fn}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`))?.[1];
}
for (const fn of ["getDevices", "addDevice", "updateDevice", "deleteDevice"]) assert.ok(ids[fn], fn);
await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, stopServer, queryFixture }) => {
  let creationRequests;
  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    await page("Emulation.setFocusEmulationEnabled", { enabled: true });
    await page("Page.enable");
    await page("Page.addScriptToEvaluateOnNewDocument", { source: `window.deviceErrors=[];window.deviceRequests=[];window.deviceHold=null;window.deviceReplies=[];
      addEventListener('error',e=>window.deviceErrors.push(e.message));addEventListener('unhandledrejection',e=>window.deviceErrors.push(String(e.reason)));
      const original=window.fetch;window.fetch=(input,options)=>{const url=input instanceof Request?input.url:String(input);const kind=Object.entries(${JSON.stringify(ids)}).find(([kind,id])=>url.includes(id))?.[0];if(!kind)return original(input,options);window.deviceRequests.push({kind,body:options?.body});const held=window.deviceHold===kind;const reply=original(input,options);return held?reply.then(async r=>{const body=await r.text();return new Promise(resolve=>window.deviceReplies.push({kind,status:r.status,release:()=>resolve(new Response(body,{status:r.status,headers:r.headers}))}));}):reply;};` });
    const check = (code, label) => poll(() => evaluate(code),label).catch(async error=>{
      console.log(JSON.stringify({label,body:await evaluate("document.body?.innerText"),errors:await evaluate("window.deviceErrors")}));
      await writeFile("/tmp/showpilot-device-recovery-failure.png",Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));throw error;
    });
    const button = name => `[...([...document.querySelectorAll('[role=dialog]')].at(-1)??document.querySelector('form')??document).querySelectorAll('button,a,summary')].find(n=>(n.textContent.trim()===${JSON.stringify(name)}||n.getAttribute('aria-label')===${JSON.stringify(name)})&&n.getBoundingClientRect().height>0&&!n.disabled)`;
    const field = label => `[...document.querySelectorAll('label')].find(n=>[...n.childNodes].filter(c=>c.nodeType===Node.TEXT_NODE).map(c=>c.textContent).join('').trim()===${JSON.stringify(label)})?.querySelector('input,textarea')`;
    const click = async name => {
      const p=await check(`(async()=>{const n=${button(name)};if(!n||!Object.keys(n).some(k=>k.startsWith('__reactProps')))return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`,name);
      await page("Input.dispatchMouseEvent",{type:"mousePressed",...p,button:"left",clickCount:1});
      await page("Input.dispatchMouseEvent",{type:"mouseReleased",...p,button:"left",clickCount:1});
    };
    const fill = async (expression,value) => {
      await check(`!!(${expression})&&Object.keys(${expression}).some(k=>k.startsWith('__reactProps'))`,"hydrated field");
      await evaluate(`(()=>{const n=${expression};Object.getOwnPropertyDescriptor(n instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    };
    const waitReady = () => check("!document.querySelector('[role=dialog]')&&!document.body.innerText.includes('Refreshing devices')&&!document.body.innerText.includes('Waiting for confirmation')", "device read settled");
    const hold = kind => evaluate(`window.deviceHold=${JSON.stringify(kind)}`);
    const release = () => evaluate("window.deviceHold=null;window.deviceReplies.splice(0).forEach(r=>r.release())");
    const retry = async kind => {
      await check(`window.deviceReplies.some(r=>r.kind===${JSON.stringify(kind)}&&r.status===200)`, `${kind} committed before lost reply`);
      await check(`${button("Retry change")}!=null`, `${kind} bounded failure`);
      await hold(null); await click("Retry change"); await waitReady();
      const attempts=await evaluate(`window.deviceRequests.filter(r=>r.kind===${JSON.stringify(kind)})`);
      assert.equal(attempts.at(-1).body,attempts.at(-2).body,"retry retains the exact request and target");
      await evaluate(`window.deviceReplies=window.deviceReplies.filter(r=>{if(r.kind===${JSON.stringify(kind)}){r.release();return false;}return true;})`);
    };
    const select = async (selector,value) => {
      await check(`!!document.querySelector(${JSON.stringify(selector)})`, "select exists");
      await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    };
    const prepareDevice = async name => {
      await click("Add Device");
      await check("document.querySelector('[role=dialog]')?.getAttribute('aria-modal')==='true'", "shared device editor");
      await select("#device-adapter","obs");
      await fill("document.querySelector('#device-name')",name);
      await fill("document.querySelector('#device-field-host')","127.0.0.1");
      await fill("document.querySelector('#device-field-password')","fixture-only-password");
    };
    await page("Emulation.setDeviceMetricsOverride",{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await page("Page.navigate",{url:`${origin}/${orgId}/dashboard/devices`});
    await check("document.body?.innerText.includes('No devices registered')","empty devices");
    await click("Add Device");
    await check("document.querySelector('[role=dialog]')?.getAttribute('aria-modal')==='true'", "shared device dialog");
    for(let i=0;i<15;i++) {
      await page("Input.dispatchKeyEvent",{type:"keyDown",key:"Tab",code:"Tab",windowsVirtualKeyCode:9});
      await page("Input.dispatchKeyEvent",{type:"keyUp",key:"Tab",code:"Tab",windowsVirtualKeyCode:9});
      assert.equal(await evaluate("!!document.activeElement.closest('[role=dialog]')"),true);
    }
    await page("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
    await page("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
    await check("!document.querySelector('[role=dialog]')","Escape closes clean editor");
    await prepareDevice("Recovery fixture");
    await hold("addDevice"); await click("Add Device");
    await check("window.deviceReplies.some(r=>r.kind==='addDevice'&&r.status===200)","creation committed");
    await check(`${button("Retry change")}!=null`,"creation timeout");
    await click("Close device editor");
    await check("!document.querySelector('[role=dialog]')","failed draft closes");
    await click("Review device draft");
    await check("document.querySelector('#device-name')?.value==='Recovery fixture'", "failed draft restored");
    assert.equal(await evaluate("document.querySelector('#device-field-password').value"),"fixture-only-password");
    assert.equal(await evaluate("document.querySelector('#device-field-password').type"),"password");
    for(const [width,height] of [[320,780],[768,1024],[1440,1000]]) {
      await page("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false});
      await check(`(async()=>{const n=${button("Retry change")};n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect();return b.height>=44&&b.left>=0&&b.right<=innerWidth&&n.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))&&[...document.querySelectorAll('[role=dialog] input,[role=dialog] select,[role=dialog] button')].every(n=>{const b=n.getBoundingClientRect();return b.left>=0&&b.right<=innerWidth+1;});})()`, `recovery form ${width}`);
      if(width===320) await writeFile("/tmp/showpilot-device-recovery-320.png",Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));
    }
    await retry("addDevice");
    await check("document.querySelector('[aria-label=\"Selected device\"] h2')?.textContent==='Recovery fixture'","device created");
    console.log(JSON.stringify({stage:"creation recovery and retained credential draft passed"}));

    await prepareDevice("Second fixture");
    await hold("getDevices"); await click("Add Device");
    await check(`${button("Retry refresh")}!=null`,"saved creation / failed refresh");
    const creates=await evaluate("window.deviceRequests.filter(r=>r.kind==='addDevice').length");
    await hold(null); await click("Retry refresh"); await waitReady();
    assert.equal(await evaluate("window.deviceRequests.filter(r=>r.kind==='addDevice').length"),creates);
    // Retain the obsolete read until after deletion to prove it cannot restore a device.
    const secondId=await evaluate("[...document.querySelectorAll('#cockpit-device option')].find(n=>n.textContent==='Second fixture').value");
    const firstId=await evaluate("[...document.querySelectorAll('#cockpit-device option')].find(n=>n.textContent==='Recovery fixture').value");
    console.log(JSON.stringify({stage:"post-save refresh without repeated creation passed"}));
    for(const [width,height] of [[320,780],[768,1024],[1440,1000]]) {
      await page("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false});
      await fill("document.querySelector('[aria-label=\"Search devices\"]')","Second fixture");
      await check("document.querySelectorAll('#cockpit-device option:not([disabled])').length===1", "mobile selector filtered");
      assert.deepEqual(await evaluate("[...document.querySelectorAll('#cockpit-device option:not([disabled])')].map(n=>n.textContent)"),["Second fixture"]);
      assert.equal(await evaluate("document.querySelector('[aria-label=\"Select Recovery fixture\"]')"),null);
      if(width<1024) {
        await check("(()=>{const n=document.querySelector('#cockpit-device');n.scrollIntoView({block:'center'});const b=n.getBoundingClientRect();return b.height>=44&&b.left>=0&&b.right<=innerWidth;})()",`selector bounds ${width}`);
        await select("#cockpit-device",secondId);
      } else {
        await evaluate(`(${button("Select Second fixture")}).focus()`);
        assert.equal(await evaluate("document.activeElement.getAttribute('aria-label')"),"Select Second fixture");
        await page("Input.dispatchKeyEvent",{type:"keyDown",key:"Enter",code:"Enter",text:"\r",windowsVirtualKeyCode:13});
        await page("Input.dispatchKeyEvent",{type:"keyUp",key:"Enter",code:"Enter",windowsVirtualKeyCode:13});
      }
      await check("document.querySelector('[aria-label=\"Selected device\"] h2')?.textContent==='Second fixture'","filtered selection");
      await check("(()=>{const n=document.querySelector('[aria-label=\"Search devices\"]');n.scrollIntoView({block:'center'});const b=n.getBoundingClientRect();return b.height>=44&&b.left>=0&&b.right<=innerWidth&&document.documentElement.scrollWidth<=innerWidth+1;})()",`search bounds ${width}`);
      if(width===320) await writeFile("/tmp/showpilot-devices-search-320.png",Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));
    }
    await fill("document.querySelector('[aria-label=\"Search devices\"]')","no match");
    await check("document.body.innerText.includes('No devices match your search.')&&document.querySelector('#cockpit-device').disabled","empty search recovery");
    await click("Clear search");
    await click("Configuration & device details");
    await click("Edit configuration");
    await check("document.querySelector('#device-field-password')?.placeholder==='Leave blank to keep saved credential'","credential stays masked on edit");
    assert.equal(await evaluate("document.querySelector('#device-field-password').value"),"");
    await fill("document.querySelector('#device-name')","x".repeat(201));
    await click("Update");
    await check(`${button("Retry change")}!=null`,"server validation failure visible");
    await click("Review stored devices"); await click("Review devices");
    await check("!document.querySelector('fieldset').disabled&&document.querySelectorAll('[role=dialog]').length===1","review unlocks retained draft");
    assert.equal(await evaluate("document.querySelector('#device-name').value"),"x".repeat(201));
    await fill("document.querySelector('#device-name')","Edited fixture");
    await hold("updateDevice"); await click("Update"); await retry("updateDevice");
    await check("document.querySelector('[aria-label=\"Selected device\"] h2')?.textContent==='Edited fixture'","configuration updated");
    await click("Edit configuration");
    await check("document.querySelector('#device-field-password')?.placeholder==='Leave blank to keep saved credential'","blank edit retained credential");
    await click("Cancel"); await check("!document.querySelector('[role=dialog]')","clean edit closed");

    await hold("updateDevice"); await click("Disable device");
    await check("window.deviceReplies.some(r=>r.kind==='updateDevice'&&r.status===200)","toggle committed");
    await check(`${button("Retry change")}!=null`,"toggle bounded failure");
    // Changing selection must not retarget the saved command.
    await click("Select Recovery fixture");
    await check(`new URL(location.href).searchParams.get('device')===${JSON.stringify(firstId)}`,"selected device URL");
    await retry("updateDevice");
    await click("Select Edited fixture");
    await check(`${button("Enable device")}!=null`,"retry toggled original device only");
    console.log(JSON.stringify({stage:"search, keyboard, validation, edit and scoped toggle recovery passed"}));

    await click("Edit configuration"); await click("Clear credential");
    await check("document.querySelectorAll('[role=dialog]').length===2","credential confirmation");
    await click("Cancel"); await check("document.querySelectorAll('[role=dialog]').length===1","credential cancellation");
    assert.equal(await evaluate("document.body.innerText.includes('Will be cleared when you save.')"),false);
    await click("Clear credential"); await check("document.querySelectorAll('[role=dialog]').length===2","clear confirmation reopened");
    await click("Clear credential");
    await check("document.querySelectorAll('[role=dialog]').length===1&&document.body.innerText.includes('Will be cleared when you save.')","explicit credential clearing staged");
    await hold("updateDevice"); await click("Update"); await retry("updateDevice");
    await click("Edit configuration");
    await check("!!document.querySelector('#device-field-password')&&!document.body.innerText.includes('Credential saved. Leave blank to keep it.')","credential clear confirmed");
    await click("Cancel"); await check("!document.querySelector('[role=dialog]')","cleared edit closed");
    const deletions=await evaluate("window.deviceRequests.filter(r=>r.kind==='deleteDevice').length");
    await click("Remove device"); await check("document.querySelector('[role=dialog]')?.innerText.includes('Remove device?')","remove confirmation");
    await click("Cancel"); await check("!document.querySelector('[role=dialog]')","cancelled deletion closed");
    assert.equal(await evaluate("window.deviceRequests.filter(r=>r.kind==='deleteDevice').length"),deletions);
    await click("Remove device"); await check("document.querySelector('[role=dialog]')?.innerText.includes('Remove device?')","remove confirmation reopened");
    await hold("deleteDevice"); await click("Remove"); await retry("deleteDevice");
    await check("document.querySelector('[aria-label=\"Selected device\"] h2')?.textContent==='Recovery fixture'","confirmed removal");
    await release(); await waitReady();
    assert.equal(await evaluate("document.querySelector('[aria-label=\"Select Edited fixture\"]')"),null);
    assert.equal(await evaluate("document.querySelector('[aria-label=\"Select Second fixture\"]')"),null);
    assert.deepEqual(await evaluate("window.deviceErrors"),[]);
    creationRequests=await evaluate("window.deviceRequests.filter(r=>r.kind==='addDevice').length");
    console.log(JSON.stringify({stage:"credential clear, delete confirmation and stale read rejection passed"}));
  });
  await stopServer();
  const rows=await queryFixture("SELECT name,settings,enabled FROM device WHERE orgId='display-smoke'");
  assert.equal(rows.length,1);assert.equal(rows[0].name,"Recovery fixture");assert.equal(rows[0].enabled,1);
  assert.ok(!rows[0].settings.includes("fixture-only-password"),"credential encrypted");
  const receipts=await queryFixture("SELECT fingerprint FROM device_write_receipt WHERE orgId='display-smoke'");
  assert.equal(receipts.length,6);assert.ok(receipts.every(r=>/^hmac-sha256:[a-f0-9]{64}$/.test(r.fingerprint)));
  console.log(JSON.stringify({passed:true,creationRequests,receipts:receipts.length,remainingDevice:rows[0].name}));
});
