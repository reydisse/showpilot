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
  for (const fn of ["getMicAssignments", "addMicAssignment", "updateMicAssignment", "deleteMicAssignment"]) ids[fn] ??= source.match(new RegExp(`const ${fn}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`))?.[1];
}
for (const fn of ["getMicAssignments", "addMicAssignment", "updateMicAssignment", "deleteMicAssignment"]) assert.ok(ids[fn], fn);
await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, stopServer, queryFixture }) => {
  let creationRequests;
  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    await page("Emulation.setFocusEmulationEnabled", { enabled: true });
    await page("Page.enable");
    await page("Page.addScriptToEvaluateOnNewDocument", { source: `window.audioErrors=[];window.audioRequests=[];window.audioHold=null;window.audioReplies=[];
      addEventListener('error',e=>window.audioErrors.push(e.message));addEventListener('unhandledrejection',e=>window.audioErrors.push(String(e.reason)));
      const original=window.fetch;window.fetch=(input,options)=>{const url=input instanceof Request?input.url:String(input);const kind=Object.entries(${JSON.stringify(ids)}).find(([kind,id])=>url.includes(id))?.[0];if(!kind)return original(input,options);window.audioRequests.push({kind,body:options?.body});const held=window.audioHold===kind;const reply=original(input,options);return held?reply.then(async r=>{const body=await r.text();return new Promise(resolve=>window.audioReplies.push({kind,status:r.status,release:()=>resolve(new Response(body,{status:r.status,headers:r.headers}))}));}):reply;};` });
    const check = (code, label) => poll(() => evaluate(code),label).catch(async error=>{
      console.log(JSON.stringify({label,body:await evaluate("document.body?.innerText"),errors:await evaluate("window.audioErrors")}));
      await writeFile("/tmp/showpilot-audio-recovery-failure.png",Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));throw error;
    });
    const button = name => `[...([...document.querySelectorAll('[role=dialog]')].at(-1)??document).querySelectorAll('button,a')].find(n=>(n.textContent.trim()===${JSON.stringify(name)}||n.getAttribute('aria-label')===${JSON.stringify(name)})&&n.getBoundingClientRect().height>0&&!n.disabled)`;
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
    const chooseShow = async name => {
      const position=await check(`(async()=>{const n=[...document.querySelectorAll('[role=menuitem]')].find(n=>n.textContent.includes(${JSON.stringify(name)}));if(!n)return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`, `choose ${name}`);
      await page("Input.dispatchMouseEvent",{type:"mousePressed",...position,button:"left",clickCount:1});
      await page("Input.dispatchMouseEvent",{type:"mouseReleased",...position,button:"left",clickCount:1});
    };
    const waitReady = () => check("!document.querySelector('[role=dialog]')&&!document.body.innerText.includes('Refreshing channels')&&!document.body.innerText.includes('Waiting for confirmation')", "channel read settled");
    const hold = kind => evaluate(`window.audioHold=${JSON.stringify(kind)}`);
    const release = () => evaluate("window.audioHold=null;window.audioReplies.splice(0).forEach(r=>r.release())");
    const retry = async kind => {
      await check(`${button("Retry change")}!=null`, `${kind} bounded failure`);
      await hold(null);
      await click("Retry change");
      await waitReady();
      const attempts=await evaluate(`window.audioRequests.filter(r=>r.kind===${JSON.stringify(kind)})`);
      assert.equal(attempts.at(-1).body, attempts.at(-2).body, "retry retains its exact request");
      await release();
    };
    await page("Emulation.setDeviceMetricsOverride", { width:1440,height:1000,deviceScaleFactor:1,mobile:false });
    await page("Page.navigate", { url:`${origin}/${orgId}/dashboard/audio` });
    await check("document.body?.innerText?.includes('No channels assigned')", "empty audio");
    await click("Add First Channel");
    await check("document.querySelector('[role=dialog]')?.getAttribute('aria-modal')==='true'","shared channel dialog");
    for(let i=0;i<15;i++) {
      await page("Input.dispatchKeyEvent",{type:"keyDown",key:"Tab",code:"Tab",windowsVirtualKeyCode:9});
      await page("Input.dispatchKeyEvent",{type:"keyUp",key:"Tab",code:"Tab",windowsVirtualKeyCode:9});
      assert.equal(await evaluate("!!document.activeElement.closest('[role=dialog]')"),true);
    }
    await page("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
    await page("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
    await check("!document.querySelector('[role=dialog]')","Escape closes clean editor");
    await click("Add First Channel");
    await fill("document.querySelector('#audio-label')", "Held channel");
    await fill("document.querySelector('#audio-notes')", "First note\nSecond note");
    await hold("addMicAssignment"); await click("Add Channel");
    await check("window.audioReplies.some(r=>r.kind==='addMicAssignment'&&r.status===200)","create committed");
    await check(`${button("Retry change")}!=null`, "creation timeout");
    assert.equal(await evaluate("document.querySelector('#audio-label').value"),"Held channel");
    await click("Close channel editor");
    await check("!document.querySelector('[role=dialog]')", "failed draft closes");
    await click("Review channel draft");
    assert.equal(await evaluate("document.querySelector('#audio-notes').value"),"First note\nSecond note");
    for(const [width,height] of [[320,780],[768,1024],[1440,1000]]) {
      await page("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false});
      await check(`(async()=>{const n=${button("Retry change")};n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect();return b.height>=44&&b.left>=0&&b.right<=innerWidth&&n.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))&&[...document.querySelectorAll('[role=dialog] input,[role=dialog] select,[role=dialog] textarea,[role=dialog] button')].every(n=>{const b=n.getBoundingClientRect();return b.left>=0&&b.right<=innerWidth+1;});})()`, `recovery form ${width}`);
      if(width===320) await writeFile("/tmp/showpilot-audio-recovery-320.png",Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));
    }
    await retry("addMicAssignment");
    await check("document.querySelector('[aria-label=\"Selected channel\"] h2')?.textContent==='Held channel'","created channel visible");

    console.log(JSON.stringify({stage:"creation recovery passed"}));
    // Acknowledged creation + failed list refresh must retry only the read.
    await click("Add Channel"); await fill("document.querySelector('#audio-label')","Second channel");
    await hold("getMicAssignments"); await click("Add Channel");
    await check(`${button("Retry refresh")}!=null`,"acknowledged creation / failed refresh");
    const creates=await evaluate("window.audioRequests.filter(r=>r.kind==='addMicAssignment').length");
    await hold(null); await click("Retry refresh"); await waitReady();
    assert.equal(await evaluate("window.audioRequests.filter(r=>r.kind==='addMicAssignment').length"),creates);
    await release();

    console.log(JSON.stringify({stage:"post-save refresh recovery passed"}));
    // Selecting a channel is a native keyboard button, in cards and the table.
    for(const [width,height] of [[320,780],[768,1024],[1440,1000]]) {
      await page("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false});
      await check(`(async()=>{const n=${button("Inspect channel 2: Second channel")};n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect();return b.height>=44&&b.left>=0&&b.right<=innerWidth&&n.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))&&document.documentElement.scrollWidth<=innerWidth+1;})()`, `channel selection ${width}`);
      await evaluate(`(${button("Inspect channel 2: Second channel")}).focus()`);
      assert.equal(await evaluate("document.activeElement.getAttribute('aria-label')"),"Inspect channel 2: Second channel");
      await page("Input.dispatchKeyEvent",{type:"keyDown",key:"Enter",code:"Enter",text:"\r",windowsVirtualKeyCode:13});
      await page("Input.dispatchKeyEvent",{type:"keyUp",key:"Enter",code:"Enter",windowsVirtualKeyCode:13});
      await check("document.querySelector('[aria-label=\"Selected channel\"] h2')?.textContent==='Second channel'","keyboard selects channel");
      if(width===320) await writeFile("/tmp/showpilot-audio-channels-320.png",Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));
    }
    console.log(JSON.stringify({stage:"keyboard and responsive selection passed"}));
    await fill("document.querySelector('[aria-label=\"Search channels\"]')","not a fixture");
    await check("document.body.innerText.includes('No channels match your search.')","empty search explained");
    await click("Clear search");
    await click("Edit assignment");
    await fill("document.querySelector('#audio-label')","x".repeat(201));
    await click("Update");
    await check(`${button("Retry change")}!=null`,"server validation error shown");
    await click("Review stored channels"); await click("Review channels");
    await check("!document.querySelector('fieldset').disabled","review unlocks retained draft");
    assert.equal(await evaluate("document.querySelector('#audio-label').value"),"x".repeat(201));
    await fill("document.querySelector('#audio-label')","Edited channel");
    await hold("updateMicAssignment"); await click("Update");
    await retry("updateMicAssignment");
    await check("document.querySelector('[aria-label=\"Selected channel\"] h2')?.textContent==='Edited channel'","updated channel");
    await hold("updateMicAssignment"); await click("Mark muted"); await retry("updateMicAssignment");
    await check(`${button("Mark unmuted")}!=null`,"mute acknowledged");

    console.log(JSON.stringify({stage:"validation, edit and mute recovery passed"}));
    const deletions=await evaluate("window.audioRequests.filter(r=>r.kind==='deleteMicAssignment').length");
    await click("Delete channel"); await check("document.querySelector('[role=dialog]')?.innerText.includes('Delete channel?')","delete confirmation"); await click("Cancel");
    await check("!document.querySelector('[role=dialog]')","cancelled deletion closed");
    assert.equal(await evaluate("window.audioRequests.filter(r=>r.kind==='deleteMicAssignment').length"),deletions);
    await click("Delete channel"); await check("document.querySelector('[role=dialog]')?.innerText.includes('Delete channel?')","second delete confirmation"); await hold("deleteMicAssignment"); await click("Delete channel");
    await check("window.audioReplies.some(r=>r.kind==='deleteMicAssignment'&&r.status===200)","deletion committed before lost reply");
    await retry("deleteMicAssignment");
    await check("document.querySelector('[aria-label=\"Selected channel\"] h2')?.textContent==='Held channel'","confirmed removal");

    console.log(JSON.stringify({stage:"delete confirmation and recovery passed"}));
    // A timed-out second-show read must not display the first show's assignments,
    // an empty state, or an endless spinner. Its late reply must not replace a
    // newer show after returning.
    await hold("getMicAssignments"); await click("Choose show");
    await check("!![...document.querySelectorAll('[role=menuitem]')].find(n=>n.textContent.includes('Evening test show'))","second show option");
    await chooseShow("Evening test show");
    await check(`${button("Retry channels")}!=null`,"bounded second-show read");
    assert.equal(await evaluate("document.body.innerText.includes('No channels assigned')||document.body.innerText.includes('Loading channels…')||!!document.querySelector('[aria-label=\"Selected channel\"]')"),false);
    await hold(null); await click("Retry channels");
    await check("document.body.innerText.includes('No channels assigned')","second show retry");
    await click("Choose show");
    await check("!![...document.querySelectorAll('[role=menuitem]')].find(n=>n.textContent.includes('Display test show'))","first show option");
    await chooseShow("Display test show");
    await check("document.querySelector('[aria-label=\"Selected channel\"] h2')?.textContent==='Held channel'","first show restored");
    await release(); await waitReady();
    assert.equal(await evaluate("document.querySelector('[aria-label=\"Selected channel\"] h2')?.textContent"),"Held channel");
    assert.deepEqual(await evaluate("window.audioErrors"),[]);
    creationRequests=await evaluate("window.audioRequests.filter(r=>r.kind==='addMicAssignment').length");
  });
  await stopServer();
  const rows=await queryFixture("SELECT label,notes,muted,showId FROM mic_assignment WHERE orgId='display-smoke'");
  assert.equal(rows.length,1);assert.deepEqual(rows[0],{label:"Held channel",notes:"First note\nSecond note",muted:0,showId:"smoke-show"});
  const receipts=await queryFixture("SELECT requestId FROM audio_write_receipt WHERE orgId='display-smoke'");
  assert.equal(receipts.length,5);
  console.log(JSON.stringify({passed:true,creationRequests,receipts:receipts.length,rows}));
}, {secondShow:true});
