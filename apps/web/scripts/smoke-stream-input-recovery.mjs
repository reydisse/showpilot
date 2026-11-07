// Actual Chrome + compiled Worker + real auth/D1. All provider writes stay in
// the disposable fixture's in-memory map; no external network is available.
import assert from "node:assert/strict";
import {readFile,readdir,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {withLocalSmokeFixture} from "./local-smoke-fixture.mjs";
import {poll,withRealBrowser} from "./real-browser-fixture.mjs";
const assets=resolve(import.meta.dirname,"../dist/server/assets"),ids={};
const functions=["createLiveInput","deleteLiveInput","resumeLiveInput","getLiveInputs","getLiveInputStatus"];
for(const name of (await readdir(assets)).filter(name=>name.endsWith(".js"))) {
  const source=await readFile(resolve(assets,name),"utf8");
  for(const fn of functions)ids[fn]??=source.match(new RegExp(`const ${fn}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`))?.[1];
}
for(const fn of functions)assert.ok(ids[fn],fn);
await withLocalSmokeFixture(async({origin,orgId,operatorCookie,configureStreamOutputs,streamOutputRequests,streamOutputSnapshot,stopServer,queryFixture})=> {
  await withRealBrowser({origin,cookie:operatorCookie},async({page,evaluate})=> {
    await page("Emulation.setFocusEmulationEnabled",{enabled:true});await page("Page.enable");
    await page("Page.addScriptToEvaluateOnNewDocument",{source:`window.cmdClicks=[];addEventListener('click',e=>window.cmdClicks.push({text:e.target.closest('button,a')?.textContent.trim(),at:Date.now()}),true);window.cmdErrors=[];window.cmdRequests=[];window.cmdHold=null;window.cmdReplies=[];
      addEventListener('error',e=>window.cmdErrors.push(e.message));addEventListener('unhandledrejection',e=>window.cmdErrors.push(String(e.reason)));
      const original=window.fetch;window.fetch=(input,options)=>{const url=input instanceof Request?input.url:String(input);const kind=Object.entries(${JSON.stringify(ids)}).find(([kind,id])=>url.includes(id))?.[0];if(!kind)return original(input,options);window.cmdRequests.push({kind,body:options?.body});const held=window.cmdHold===kind;return original(input,options).then(async response=>{if(!held)return response;const body=await response.text();return new Promise(resolve=>window.cmdReplies.push({kind,status:response.status,release:()=>resolve(new Response(body,{status:response.status,headers:response.headers}))}));});};`});
    const check=(code,label)=>poll(()=>evaluate(code),label).catch(async error=> {
      console.log(JSON.stringify({label,body:await evaluate("document.body?.innerText"),errors:await evaluate("window.cmdErrors"),clicks:await evaluate("window.cmdClicks")}));
      await writeFile("/tmp/showpilot-input-recovery-failure.png",Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));throw error;
    });
    const button=name=>`[...([...document.querySelectorAll('[role=dialog]')].at(-1)??document).querySelectorAll('button,a')].find(n=>(n.textContent.trim()===${JSON.stringify(name)}||n.getAttribute('aria-label')===${JSON.stringify(name)})&&n.getBoundingClientRect().height>0&&!n.disabled)`;
    const click=async name=> {
      const point=await check(`(async()=>{const n=${button(name)};if(!n||!Object.keys(n).some(k=>k.startsWith('__reactProps'))||n.closest('[role=dialog]')?.getAnimations().some(a=>a.playState==='running'))return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return !n.disabled&&n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`,name);
      await page("Input.dispatchMouseEvent",{type:"mousePressed",...point,button:"left",clickCount:1});await page("Input.dispatchMouseEvent",{type:"mouseReleased",...point,button:"left",clickCount:1});
    };

    const ready=()=>check("!document.querySelector('[role=dialog]')&&!document.querySelector('[aria-label=\"Input change\"]')&&!document.body.innerText.includes('Refreshing inputs')&&!document.body.innerText.includes('Waiting for confirmation')","confirmed input and refreshed list");
    const hold=kind=>evaluate(`window.cmdHold=${JSON.stringify(kind)}`);
    const retry=async kind=> {
      await check(`${button("Retry change")}!=null`,"bounded input failure");await hold(null);await click("Retry change");await ready();
      const requests=await evaluate(`window.cmdRequests.filter(r=>r.kind===${JSON.stringify(kind)}).map(r=>r.body)`);
      assert.equal(requests.at(-1),requests.at(-2),`${kind} Retry retains its exact request`);
    };
    const fill=async value=>evaluate(`(()=>{const n=document.querySelector('#live-input-name');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await page("Emulation.setDeviceMetricsOverride",{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await page("Page.navigate",{url:`${origin}/${orgId}/streaming/health`});await click("Create Live Input");
    await page("Input.dispatchKeyEvent",{type:"keyDown",key:"Tab",code:"Tab",windowsVirtualKeyCode:9});await page("Input.dispatchKeyEvent",{type:"keyUp",key:"Tab",code:"Tab",windowsVirtualKeyCode:9});
    await check("!!document.activeElement.closest('[role=dialog]')","keyboard focus stays inside editor");
    await page("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});await page("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
    await check("!document.querySelector('[role=dialog]')","Escape closes pristine editor");await click("Create Live Input");
    await fill("Fixture primary");
    for(const [width,height] of [[320,780],[768,1024],[1440,1000]]) {
      await page("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false});
      await check(`(()=>{const nodes=[...document.querySelectorAll('[role=dialog] button,[role=dialog] input')];return nodes.length>=4&&nodes.every(n=>{const b=n.getBoundingClientRect();return b.height>=44&&b.left>=0&&b.right<=innerWidth&&b.bottom<=innerHeight;})&&document.documentElement.scrollWidth<=innerWidth+1;})()`,`editor bounds ${width}`);
    }
    await hold("createLiveInput");await evaluate("document.querySelector('#live-input-name').focus()");
    await page("Input.dispatchKeyEvent",{type:"keyDown",key:"Enter",code:"Enter",text:"\r",windowsVirtualKeyCode:13});await page("Input.dispatchKeyEvent",{type:"keyUp",key:"Enter",code:"Enter",windowsVirtualKeyCode:13});
    await check("window.cmdReplies.some(r=>r.kind==='createLiveInput'&&r.status===200)","creation committed but reply withheld");
    assert.equal((await streamOutputSnapshot()).length,1);
    await check(`${button("Retry change")}!=null`,"create deadline");await click("Close live input editor");await check("!document.querySelector('[role=dialog]')","closed editor retains draft");
    await click("Songs");await check("document.body.innerText.includes('Leave Stream?')","unconfirmed creation blocks navigation");await click("Stay");await check("!document.querySelector('[role=dialog]')","navigation cancelled");
    await click("Review input draft");assert.equal(await evaluate("document.querySelector('#live-input-name').value"),"Fixture primary");
    await retry("createLiveInput");assert.equal((await streamOutputRequests()).filter(r=>r.method==='POST').length,1);
    await check("document.body.innerText.includes('Provider: connected')","fresh input health");
    await evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>Promise.reject(new Error('fixture denied'))}})");
    await click("Copy Stream Key");await check("document.body.innerText.includes('Could not copy Stream Key')","clipboard failure");
    await evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>Promise.resolve()}})");await click("Retry copying Stream Key");await check("document.body.innerText.includes('Stream Key copied.')","clipboard retry");
    for(const [width,height] of [[320,780],[768,1024],[1440,1000]]) {
      await page("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false});
      await check(`(()=>{const names=['Copy Stream Key','Reveal Stream Key','Delete Fixture primary stream input'];return names.every(name=>{const n=[...document.querySelectorAll('button')].find(n=>n.getAttribute('aria-label')===name);if(!n)return false;const b=n.getBoundingClientRect();return b.height>=44&&b.width>=44&&b.left>=0&&b.right<=innerWidth;})&&document.documentElement.scrollWidth<=innerWidth+1;})()`,`input controls ${width}`);
      if(width===320)await writeFile("/tmp/showpilot-input-recovery-320.png",Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));
    }
    await configureStreamOutputs("malformed");await check(`${button("Retry input health")}!=null`,"malformed health is unknown");assert.ok(await evaluate("document.body.innerText.includes('Unknown')"));
    await configureStreamOutputs("success");await click("Retry input health");await check("document.body.innerText.includes('Provider: connected')&&!document.querySelector('[aria-label=\"Retry input health\"]')","health retry");
    await configureStreamOutputs("slow");await poll(async()=> (await streamOutputRequests()).some(r=>r.mode==='slow'),"slow provider health started");
    await check(`${button("Retry input health")}!=null`,"provider body deadline");await configureStreamOutputs("success");await click("Retry input health");
    await check("document.body.innerText.includes('Provider: connected')&&!document.querySelector('[aria-label=\"Retry input health\"]')","health recovered after deadline");
    await click("Delete Fixture primary stream input");await click("Cancel");await ready();assert.equal((await streamOutputSnapshot()).length,1);
    await hold("deleteLiveInput");await click("Delete Fixture primary stream input");await click("Delete input");await retry("deleteLiveInput");assert.deepEqual(await streamOutputSnapshot(),[]);
    // Provider creation succeeded but returned an ambiguous reply. Reload drops
    // the browser request; Resume must recover the metadata-marked same input.
    await configureStreamOutputs("lose-create");await click("Create Live Input");await fill("Fixture resumed");await click("Create");await check(`${button("Retry change")}!=null`,"provider creation uncertainty");
    assert.equal((await streamOutputSnapshot()).length,1);assert.equal((await streamOutputSnapshot())[0].enabled,false);
    await configureStreamOutputs("success");await page("Page.reload",{ignoreCache:true});
    await poll(async()=>{try{await page("Page.handleJavaScriptDialog",{accept:true});return true;}catch(error){if(!error.message.includes("No dialog is showing"))throw error;return false;}},"reload warning accepted");
    await click("Resume setup");await ready();
    await check("document.body.innerText.includes('Provider: connected')","resumed input enabled and checked");
    assert.equal((await streamOutputRequests()).filter(r=>r.method==='POST').length,2);
    await configureStreamOutputs("lose-delete");await click("Delete Fixture resumed stream input");await click("Delete input");await check(`${button("Retry change")}!=null`,"lost provider deletion reply");assert.deepEqual(await streamOutputSnapshot(),[]);
    await configureStreamOutputs("success");await retry("deleteLiveInput");
    assert.deepEqual(await evaluate("window.cmdErrors"),[]);
  });
  await stopServer();
  const inputs=await queryFixture("SELECT id FROM live_input WHERE orgId='display-smoke'");assert.equal(inputs.length,0);
  const receipts=await queryFixture("SELECT kind,completed FROM stream_input_command WHERE orgId='display-smoke'");assert.equal(receipts.length,4);assert.ok(receipts.every(row=>row.completed===1));
  const lifecycles=await queryFixture("SELECT phase,desired FROM stream_input_lifecycle WHERE orgId='display-smoke'");assert.equal(lifecycles.length,2);assert.ok(lifecycles.every(row=>row.phase==='deleted'&&row.desired==='deleted'));
  console.log(JSON.stringify({inputs:inputs.length,receipts:receipts.length,providerCreations:(await streamOutputRequests()).filter(r=>r.method==='POST').length,checks:'lost replies, reload resume, deletion, health deadlines, clipboard, drafts, navigation, 320/768/1440px'}));
},{streamOutputs:"inputs"});
