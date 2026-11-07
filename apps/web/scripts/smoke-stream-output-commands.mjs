// Actual Chrome + compiled Worker + real auth/D1. All provider writes stay in
// the disposable fixture's in-memory map; no external network is available.
import assert from "node:assert/strict";
import {readFile,readdir,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {withLocalSmokeFixture} from "./local-smoke-fixture.mjs";
import {poll,withRealBrowser} from "./real-browser-fixture.mjs";
const assets=resolve(import.meta.dirname,"../dist/server/assets"),ids={};
const functions=["connectDestinationsToInput","disconnectAllDestinations","toggleStreamDestination","deleteStreamDestination","getStreamDestinations"];
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
      await writeFile("/tmp/showpilot-output-commands-failure.png",Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));throw error;
    });
    const button=name=>`[...([...document.querySelectorAll('[role=dialog]')].at(-1)??document).querySelectorAll('button,a')].find(n=>(n.textContent.trim()===${JSON.stringify(name)}||n.getAttribute('aria-label')===${JSON.stringify(name)})&&n.getBoundingClientRect().height>0&&!n.disabled)`;
    const click=async name=> {
      const point=await check(`(async()=>{const n=${button(name)};if(!n||!Object.keys(n).some(k=>k.startsWith('__reactProps'))||n.closest('[role=dialog]')?.getAnimations().some(a=>a.playState==='running'))return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return !n.disabled&&n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`,name);
      await page("Input.dispatchMouseEvent",{type:"mousePressed",...point,button:"left",clickCount:1});await page("Input.dispatchMouseEvent",{type:"mouseReleased",...point,button:"left",clickCount:1});
    };
    const ready=()=>check("!document.querySelector('[role=dialog]')&&!document.querySelector('[aria-label=\"Output change\"]')&&!document.body.innerText.includes('Refreshing destinations')&&!document.body.innerText.includes('Waiting for confirmation')","confirmed command and refreshed configuration");
    const confirmAction=async name=>{await click(name);await check("!!document.querySelector('[role=dialog]')","confirmation");await click(name);};
    const hold=kind=>evaluate(`window.cmdHold=${JSON.stringify(kind)}`);
    const retry=async(kind)=> {
      await check(`${button("Retry change")}!=null`,"bounded output failure");await hold(null);await click("Retry change");await ready();
      const requests=await evaluate(`window.cmdRequests.filter(r=>r.kind===${JSON.stringify(kind)}).map(r=>r.body)`);
      assert.equal(requests.at(-1),requests.at(-2),`${kind} Retry retains the request and frozen targets`);
    };
    await page("Emulation.setDeviceMetricsOverride",{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await page("Page.navigate",{url:`${origin}/${orgId}/streaming/platforms`});await click("Go Live");
    await check("document.querySelector('[role=dialog]')?.innerText.includes('Fixture alpha')&&document.querySelector('[role=dialog]')?.innerText.includes('Fixture beta')","named confirmation targets");
    assert.equal((await streamOutputRequests()).filter(request=>request.method==="POST").length,0);
    for(const [width,height] of [[320,780],[768,1024],[1440,1000]]) {
      await page("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false});
      await check(`(()=>{const buttons=[...document.querySelectorAll('[role=dialog] button')];return buttons.length===2&&buttons.every(n=>{const b=n.getBoundingClientRect();return b.height>=44&&b.left>=0&&b.right<=innerWidth&&b.bottom<=innerHeight;})&&document.documentElement.scrollWidth<=innerWidth+1;})()`,`confirmation bounds ${width}`);
      if(width===320)await writeFile("/tmp/showpilot-output-commands-320.png",Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));
    }
    await click("Cancel");await ready();
    assert.deepEqual(await streamOutputSnapshot(),[]);
    await hold("connectDestinationsToInput");await confirmAction("Go Live");
    await check("window.cmdReplies.some(r=>r.kind==='connectDestinationsToInput'&&r.status===200)","Go Live committed but reply lost");
    assert.equal((await streamOutputSnapshot()).filter(output=>output.enabled).length,2);
    await check(`${button("Retry change")}!=null`,"Go Live deadline");
    await click("Songs");await check("document.body.innerText.includes('Leave Multi-Platform?')","pending command navigation guard");await click("Stay");await check("!document.querySelector('[role=dialog]')","stay on output controls");
    await retry("connectDestinationsToInput");assert.equal((await streamOutputRequests()).filter(request=>request.method==="POST").length,2);
    await hold("disconnectAllDestinations");await confirmAction("Stop All");await check("window.cmdReplies.some(r=>r.kind==='disconnectAllDestinations')","Stop committed but reply lost");await retry("disconnectAllDestinations");assert.deepEqual(await streamOutputSnapshot(),[]);
    await configureStreamOutputs("lose-create");await confirmAction("Go Live");await check(`${button("Retry change")}!=null`,"provider creation result unconfirmed");
    assert.equal((await streamOutputSnapshot()).length,2);assert.ok((await streamOutputSnapshot()).every(output=>!output.enabled));
    await configureStreamOutputs("success");await retry("connectDestinationsToInput");
    assert.equal((await streamOutputRequests()).filter(request=>request.method==="POST").length,4,"unknown provider creation cannot create duplicates");
    await configureStreamOutputs("fail-delete");await confirmAction("Stop All");await check("document.querySelector('[aria-label=\"Output change\"]')?.innerText.includes('Fixture beta')","partial Stop result names failed destination");
    assert.equal((await streamOutputSnapshot()).length,1);await configureStreamOutputs("success");await retry("disconnectAllDestinations");assert.deepEqual(await streamOutputSnapshot(),[]);
    await hold("toggleStreamDestination");await click("Disable Fixture alpha");await retry("toggleStreamDestination");
    await click("Enable Fixture alpha");await ready();assert.deepEqual(await streamOutputSnapshot(),[],"selection never creates outputs");
    await hold("deleteStreamDestination");await click("Delete Fixture alpha");await check("!!document.querySelector('[role=dialog]')","deletion confirmation");await click("Delete destination");await retry("deleteStreamDestination");
    assert.equal(await evaluate("document.body.innerText.includes('Fixture alpha')"),false);
    await configureStreamOutputs("slow-create");await confirmAction("Go Live");
    await poll(async()=> (await streamOutputRequests()).some(request=>request.mode==="slow-create"&&request.method==="POST"),"held disabled provider creation");
    const started=Date.now();await confirmAction("Stop All");await check(`${button("Retry change")}!=null`,"Stop waiting on prior provider call");
    await poll(()=>Date.now()-started>5_500,"bounded prior provider call");await configureStreamOutputs("success");await retry("disconnectAllDestinations");
    await poll(()=>Date.now()-started>12_500,"late provider reply cannot restart broadcast");
    assert.deepEqual(await streamOutputSnapshot(),[]);
    await evaluate("window.cmdReplies.splice(0).forEach(reply=>reply.release())");await ready();
    assert.deepEqual(await evaluate("window.cmdErrors"),[]);
    console.log(JSON.stringify({ui:true,confirmation:true,requestRetry:true,partialStop:true,lateCreationStopped:true,widths:[320,768,1440]}));
  });
  const requests=await streamOutputRequests();await stopServer();
  const destinations=await queryFixture("SELECT id,enabled,cfOutputId,liveInputId FROM stream_destination WHERE orgId='display-smoke'");
  assert.deepEqual(destinations,[{id:"smoke-beta",enabled:1,cfOutputId:"",liveInputId:""}]);
  const receipts=await queryFixture("SELECT targets,completed FROM stream_output_command WHERE orgId='display-smoke'");assert.equal(receipts.length,9,"only nine confirmed commands, with no receipt for Cancel or duplicate Retry");
  console.log(JSON.stringify({passed:true,providerCreates:requests.filter(request=>request.method==="POST").length,commands:receipts.length,remainingDestinations:destinations.length}));
},{streamOutputs:"commands"});
