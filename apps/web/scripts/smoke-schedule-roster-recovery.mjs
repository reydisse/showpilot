// Real compiled schedule and auth. Interrupt only the roster-read transport.
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { withLocalSmokeFixture } from './local-smoke-fixture.mjs';
import { poll, withRealBrowser } from './real-browser-fixture.mjs';
const assets = resolve(import.meta.dirname, '../dist/server/assets');
let id;
for (const file of (await readdir(assets)).filter(file => file.endsWith('.js'))) {
  const source = await readFile(resolve(assets,file),'utf8');
  id ??= source.match(/const getServiceAssignments_createServerFn_handler = createServerRpc\(\{\s*id: "([^"]+)"/)?.[1];
}
assert.ok(id);
await withLocalSmokeFixture(async ({ origin,orgId,operatorCookie,capturedEmails }) => {
  await withRealBrowser({ origin,cookie:operatorCookie },async ({ page,evaluate }) => {
    await page('Page.enable'); await page('Emulation.setFocusEmulationEnabled',{enabled:true});
    await page('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await page('Page.addScriptToEvaluateOnNewDocument',{source:`
      window.rosterMode='fail';window.rosterCalls=0;window.rosterHeld=[];window.rosterErrors=[];
      addEventListener('error',e=>rosterErrors.push(e.message));addEventListener('unhandledrejection',e=>rosterErrors.push(String(e.reason)));
      const original=fetch;window.fetch=async(input,options)=>{
        const url=input instanceof Request?input.url:String(input);if(!url.includes('/_serverFn/${id}'))return original(input,options);
        rosterCalls++;if(rosterMode==='fail')throw new TypeError('Fixture roster offline');
        const hold=rosterMode==='hold';const response=await original(input,hold?{...options,signal:new AbortController().signal}:options);
        if(!hold)return response;const bytes=await response.arrayBuffer();return new Promise(resolve=>rosterHeld.push(()=>resolve(new Response(bytes,{status:response.status,headers:response.headers}))));
      };`});
    const check=(expression,description)=>poll(()=>evaluate(expression),description).catch(async error=>{
      console.log(JSON.stringify({description,body:await evaluate('document.body.innerText'),errors:await evaluate('rosterErrors'),calls:await evaluate('rosterCalls')}));throw error;
    });
    const button=`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Retry roster'&&!b.disabled&&b.getBoundingClientRect().width>0)`;
    const retry=async()=>{
      const point=await check(`(async()=>{const n=${button};if(!n||!Object.keys(n).some(k=>k.startsWith('__reactProps')))return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`,'reachable roster retry');
      for(const type of ['mousePressed','mouseReleased'])await page('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point});
    };
    await page('Page.navigate',{url:`${origin}/${orgId}/schedule?date=2099-01-01&show=assignment-show&month=2099-01`});
    await check('rosterCalls>0','real roster read attempted');
    await check(`!!${button}`,'roster failure has an explicit retry');
    assert.ok(await evaluate("document.body.innerText.includes('Camera')&&document.body.innerText.includes('Audio')"),'Last confirmed assignments stay visible');
    await evaluate("rosterMode='hold'");await retry();
    await check('rosterHeld.length===1','one held read');
    await check(`!!${button}`,'read deadline restores retry');
    await evaluate("rosterHeld.splice(0).forEach(release=>release());true");
    assert.ok(await evaluate(`!!${button}`),'Late completion must not clear failure');
    for(const [width,height]of [[320,480],[768,1024],[1440,1000]]){
      await page('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      const layout=await check(`(async()=>{await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const n=${button};if(!n)return null;n.scrollIntoView({block:'center'});const b=n.getBoundingClientRect();const sidebar=document.querySelector('aside[aria-hidden=true]');if(b.left<0||b.right>innerWidth||b.top<0||b.bottom>innerHeight||(sidebar&&sidebar.getBoundingClientRect().right>0)||!n.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)))return null;return {height:b.height}})()`,'reachable retry at '+width);
      assert.ok(layout.height>=44);
      await writeFile(`/tmp/showpilot-roster-${width}.png`,Buffer.from((await page('Page.captureScreenshot',{format:'png'})).data,'base64'));
    }
    await evaluate("rosterMode='pass'");await retry();
    await check(`!${button}&&!document.body.innerText.includes('Roster refresh failed')`,'successful retry clears failure');
    assert.ok(await evaluate("document.body.innerText.includes('Camera')&&document.body.innerText.includes('Audio')"));
    assert.deepEqual(await evaluate('rosterErrors'),[]);assert.equal((await capturedEmails()).length,0);
    console.log(JSON.stringify({lastConfirmedRosterRetained:true,readDeadline:true,lateReplyIgnored:true,retryRecovered:true,viewports:[320,768,1440],emails:0,errors:[]}));
  });
},{personalAssignments:true,captureEmail:true});
