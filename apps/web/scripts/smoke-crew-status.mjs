// Populated crew display, actual compiled reads, and a withheld refresh reply.
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";

const assets = resolve(import.meta.dirname, "../dist/server/assets");
let readId;
for (const file of (await readdir(assets)).filter(file => file.endsWith(".js"))) {
  const source = await readFile(resolve(assets, file), "utf8");
  readId ??= source.match(/const getCrewMembers_createServerFn_handler = createServerRpc\(\{\s*id: "([^"]+)"/)?.[1];
}
assert.ok(readId);
await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie }) => {
  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    await page("Page.enable");
    await page("Page.bringToFront");
    await page("Emulation.setFocusEmulationEnabled", { enabled: true });
    await page("Page.addScriptToEvaluateOnNewDocument", { source: `
      window.crewErrors=[];window.crewMode='normal';window.crewHeld=[];window.crewCalls=0;
      addEventListener('error',event=>window.crewErrors.push(event.message));
      addEventListener('unhandledrejection',event=>window.crewErrors.push(String(event.reason)));
      const original=window.fetch;
      window.fetch=(input,init)=>{
        const url=input instanceof Request?input.url:String(input);
        if(!url.includes('/_serverFn/'+${JSON.stringify(readId)}))return original(input,init);
        window.crewCalls++;
        if(window.crewMode==='hold') {
          const reply=original(input,{...init,signal:new AbortController().signal}).then(async response=>new Response(await response.arrayBuffer(),{status:response.status,headers:response.headers}));
          return new Promise(resolve=>window.crewHeld.push(async()=>resolve(await reply)));
        }
        return original(input,init);
      };` });
    await page("Page.navigate", { url: `${origin}/${orgId}/board` });
    await poll(() => evaluate("document.body?.textContent.includes('Previous fixture person') && window.crewCalls>0"), "populated crew display");
    const failures = [];
    for (const [width, height] of [[320,480],[390,844],[768,900],[1440,900]]) {
      await page("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor:1, mobile:false });
      await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      const layout = await evaluate(`(() => {
        const nodes=[...document.querySelectorAll('header h1,header p,footer a,footer button')];
        return {fits:document.documentElement.scrollWidth<=innerWidth,
          nodes:nodes.map(el=>{const r=el.getBoundingClientRect();return {text:el.textContent.trim(),left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height,target:el.matches('a,button')};})};
      })()`);
      if(!layout.fits || layout.nodes.some(r=>r.left<0||r.right>width||(r.target&&r.height<44))) failures.push({width,layout});
      assert.equal(await evaluate("document.querySelectorAll('h3').length"),8);
      const names = await evaluate("[...document.querySelectorAll('h3')].map(el=>el.textContent)");
      for(const name of names) {
        await evaluate(`([...document.querySelectorAll('h3')].find(el=>el.textContent===${JSON.stringify(name)})).scrollIntoView({block:'nearest'});true`);
        const visible=await evaluate(`(() => {const el=[...document.querySelectorAll('h3')].find(el=>el.textContent===${JSON.stringify(name)});const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()`);
        if(!visible)failures.push({width,name,visible});
      }
      const targets=await evaluate("document.querySelectorAll('footer a,footer button').length");
      for(let i=0;i<targets;i++) {
        const target=await evaluate(`(() => {const el=document.querySelectorAll('footer a,footer button')[${i}];el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {text:el.textContent.trim(),visible:el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};})()`);
        if(!target.visible)failures.push({width,target});
      }
      await evaluate(`document.querySelector('[aria-label="Crew members"]').scrollTop=0;true`);
      await evaluate("document.querySelector('header').scrollIntoView({block:'start'});true");
      if(width===320)await writeFile('/tmp/showpilot-crew-status-320.png',Buffer.from((await page('Page.captureScreenshot',{format:'png'})).data,'base64'));
      if(width===320) {
        await evaluate(`document.querySelector('[aria-label="Crew members"]').focus();true`);
        await page('Input.dispatchKeyEvent',{type:'keyDown',key:'PageDown',code:'PageDown',windowsVirtualKeyCode:34});
        await page('Input.dispatchKeyEvent',{type:'keyUp',key:'PageDown',code:'PageDown',windowsVirtualKeyCode:34});
        await poll(()=>evaluate(`document.querySelector('[aria-label="Crew members"]').scrollTop>0`),'keyboard scroll reaches more crew');
      }
    }
    await evaluate("window.crewMode='hold';document.dispatchEvent(new Event('visibilitychange'));true");
    await poll(()=>evaluate("window.crewHeld.length>0"),"refresh request held");
    try {
      await poll(()=>evaluate(`!!document.querySelector('[role="alert"][aria-label="Retry crew status"] time')`),"bounded refresh failure",12000);
    } catch(error) { failures.push({refresh:error.message}); }
    if(!failures.some(f=>f.refresh)) {
      assert.equal(await evaluate("document.body.textContent.includes('Previous fixture person')"),true,"Keep confirmed attendance visible");
      await page("Emulation.setDeviceMetricsOverride", {width:320,height:480,deviceScaleFactor:1,mobile:false});
      await evaluate(`document.querySelector('button[aria-label="Retry crew status"]').scrollIntoView({block:'center'});true`);
      const retry=await evaluate(`(() => {const el=document.querySelector('button[aria-label="Retry crew status"]');const r=el.getBoundingClientRect();return {height:r.height,left:r.left,right:r.right,reachable:el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};})()`);
      assert.ok(retry.height>=44&&retry.left>=0&&retry.right<=320&&retry.reachable,JSON.stringify(retry));
      await writeFile('/tmp/showpilot-crew-status-error-320.png',Buffer.from((await page('Page.captureScreenshot',{format:'png'})).data,'base64'));
      await evaluate(`document.querySelector('button[aria-label="Retry crew status"]').click();true`);
      await poll(()=>evaluate(`document.querySelector('button[aria-label="Retry crew status"]')?.disabled`),"Retry stays pending");
      await evaluate("window.crewMode='normal';window.crewHeld.at(-1)();true");
      await poll(()=>evaluate(`!document.querySelector('[role="alert"][aria-label="Retry crew status"]')`),"fresh attendance confirmed");
      await evaluate("window.crewHeld[0]();true");
      assert.equal(await evaluate("document.body.textContent.includes('Previous fixture person')"),true);
    }
    assert.deepEqual(await evaluate("window.crewErrors"),[]);
    assert.deepEqual(failures,[]);
    console.log(JSON.stringify({passed:true,widths:[320,390,768,1440],boundedRefresh:true,retainsCrew:true,retry:true,lateReplyReleased:true,crewCards:8,keyboardScroll:true}));
  });
}, {publicCheckInMembers:true,crewStatusMembers:true});
