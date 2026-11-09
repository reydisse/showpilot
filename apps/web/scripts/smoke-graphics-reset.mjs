// Compiled Settings reset with real auth/D1, live-output protection and a lost reply.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { withLocalSmokeFixture } from './local-smoke-fixture.mjs';
import { poll, withRealBrowser } from './real-browser-fixture.mjs';
const require=createRequire(new URL('../package.json',import.meta.url));
const router=createRequire(require.resolve('@tanstack/react-router'));
const core=createRequire(router.resolve('@tanstack/router-core'));
const {toJSONAsync,fromJSON,fromCrossJSON}=core('seroval');
const {defaultSerovalPlugins}=router('@tanstack/router-core');
const ids={},names=['resetLowerThirdLibrary','clearActiveGraphics','getActiveGraphics','getGraphicTemplates','mutateGraphicLibrary'];
const assets=resolve(import.meta.dirname,'../dist/server/assets');
for(const file of(await readdir(assets)).filter(file=>file.endsWith('.js'))){
  const source=await readFile(resolve(assets,file),'utf8');
  for(const name of names)ids[name]??=source.match(new RegExp(`const ${name}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`))?.[1];
}
assert.ok(names.every(name=>ids[name]));
await withLocalSmokeFixture(async({origin,orgId,operatorCookie,stopServer,queryFixture,capturedEmails})=>{
  async function rpc(name,data={}){
    const payload=JSON.stringify(await toJSONAsync({data:{orgId,...data}}));
    const headers={Cookie:operatorCookie,Origin:origin,'Sec-Fetch-Site':'same-origin','x-tsr-serverFn':'true','Content-Type':'application/json'};
    const read=name.startsWith('get');
    const response=await fetch(`${origin}/_serverFn/${ids[name]}${read?'?'+new URLSearchParams({payload}):''}`,{method:read?'GET':'POST',headers,...(read?{}:{body:payload})});
    assert.equal(response.status,200);
    const reply=fromCrossJSON(await response.json(),{refs:new Map(),plugins:defaultSerovalPlugins});
    assert.equal(reply.error,undefined);assert.equal(reply instanceof Error,false);return reply.result;
  }
  const liveBefore=await rpc('getActiveGraphics');assert.equal(liveBefore.length,1);
  const create=title=>rpc('mutateGraphicLibrary',{requestId:crypto.randomUUID(),operation:{kind:'create',content:{name:title,title,subtitle:'',style:'{}'}}});
  await create('Before reset');
  await withRealBrowser({origin,cookie:operatorCookie},async({page,evaluate})=>{
    await page('Page.enable');await page('Emulation.setFocusEmulationEnabled',{enabled:true});
    await page('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await page('Page.addScriptToEvaluateOnNewDocument',{source:`
      window.resetCalls=[];window.resetErrors=[];window.holdReset=false;window.resetReplies=[];
      addEventListener('error',e=>window.resetErrors.push(e.message));addEventListener('unhandledrejection',e=>window.resetErrors.push(String(e.reason)));
      const original=fetch;window.fetch=async(input,options)=>{
        const url=input instanceof Request?input.url:String(input),match=url.includes('/_serverFn/${ids.resetLowerThirdLibrary}');
        if(match)window.resetCalls.push(options.body);
        const response=await original(input,options);
        if(match&&window.holdReset){const body=await response.text();return new Promise(resolve=>window.resetReplies.push(()=>resolve(new Response(body,{status:response.status,headers:response.headers}))));}
        return response;
      };`});
    const check=(expression,label)=>poll(()=>evaluate(expression),label).catch(async error=>{
      console.log(JSON.stringify({label,body:await evaluate('document.body?.innerText'),errors:await evaluate('window.resetErrors')}));throw error;
    });
    const click=async name=>{
      const box=await check(`(async()=>{const n=[...document.querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(name)}&&!n.disabled);if(!n)return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`,'clickable '+name);
      await page('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...box});await page('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...box});
    };
    const fill=value=>evaluate(`(()=>{const n=document.querySelector('input[aria-label="Organization name to reset graphics"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await page('Page.navigate',{url:`${origin}/${orgId}/settings?section=danger`});
    await check(`!!document.body&&[...document.querySelectorAll('h1')].some(n=>n.textContent==='Danger Zone')`,'Danger Zone');
    await check(`Object.keys(document.querySelector('button')??{}).some(k=>k.startsWith('__reactProps'))`,'hydrated Settings');
    await click('Reset saved graphics');await check(`!!document.querySelector('[role="dialog"] input')`,'confirmation');
    await fill('wrong');assert.equal(await evaluate(`[...document.querySelectorAll('button')].find(n=>n.textContent==='Permanently delete saved graphics').disabled`),true);
    for(const width of [320,768,1440]){
      await page('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
      await check(`document.querySelector('[role="dialog"]').getAnimations({subtree:true}).every(a=>a.playState==='finished')`,'settled dialog');
      const sizes=await evaluate(`[...document.querySelectorAll('[role="dialog"] button,[role="dialog"] input')].map(n=>({w:n.getBoundingClientRect().width,h:n.getBoundingClientRect().height}))`);
      assert.equal(sizes.length,3);assert.ok(sizes.every(n=>n.w>=44&&n.h>=44));
      assert.equal(await evaluate(`(()=>{const d=document.querySelector('[role="dialog"]'),r=d.getBoundingClientRect();return d.scrollWidth<=d.clientWidth+1&&[...d.querySelectorAll('button,input')].every(n=>{const b=n.getBoundingClientRect();return b.x>=r.x&&b.right<=r.right;});})()`),true,'dialog controls must fit within its bounds');
      assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),true);
      if(width===320)await writeFile('/tmp/showpilot-graphics-reset-320.png',Buffer.from((await page('Page.captureScreenshot',{format:'png'})).data,'base64'));
    }
    await click('Cancel');assert.equal(await evaluate('window.resetCalls.length'),0);
    await click('Reset saved graphics');await fill('Display fixture');await click('Permanently delete saved graphics');
    await check(`document.querySelector('[role="alert"]')?.textContent.includes('Clear program graphics')`,'live output blocks reset');
    assert.deepEqual(await rpc('getActiveGraphics'),liveBefore);assert.equal((await rpc('getGraphicTemplates')).length,2);
    await rpc('clearActiveGraphics');
    await evaluate('window.holdReset=true');await click('Retry graphics reset');
    await check('window.resetReplies.length===1','real reset reply withheld');
    assert.deepEqual(await rpc('getGraphicTemplates'),[]);
    const newer=await create('Saved after reset');
    await check(`[...document.querySelectorAll('button')].some(n=>n.textContent==='Retry graphics reset')`,'bounded unconfirmed reset');
    await click('Notifications');await check(`[...document.querySelectorAll('h1')].some(n=>n.textContent==='Notifications')`,'navigate away');
    await click('Danger Zone');await check(`[...document.querySelectorAll('button')].some(n=>n.textContent==='Retry graphics reset')`,'retained exact retry');
    await evaluate('window.holdReset=false');await click('Retry graphics reset');
    await check(`document.body.textContent.includes('2 saved graphics were deleted.')`,'confirmed reset count');
    const calls=(await evaluate('window.resetCalls')).map(body=>fromJSON(JSON.parse(body)));
    assert.equal(calls.length,3);assert.deepEqual(calls[0],calls[1]);assert.deepEqual(calls[1],calls[2]);
    await evaluate('window.resetReplies.splice(0).forEach(release=>release())');
    assert.deepEqual((await rpc('getGraphicTemplates')).map(row=>row.id),[newer.id]);
    assert.deepEqual(await evaluate('window.resetErrors'),[]);
  });
  await stopServer();
  const receipts=await queryFixture(`SELECT deletedCount FROM graphic_library_reset_receipt WHERE orgId='${orgId}'`);
  assert.deepEqual(receipts,[{deletedCount:2}]);
  assert.equal((await queryFixture(`SELECT id FROM app_setting WHERE orgId='${orgId}' AND key LIKE 'graphic-scene:%'`)).length,5);
  assert.equal((await capturedEmails()).length,0);
  console.log(JSON.stringify({passed:true,liveOutputProtected:true,typedName:true,cancelSendsNothing:true,exactRetryAcrossNavigation:true,newerGraphicsKept:true,widths:[320,768,1440],receipts:1,externalEmail:0}));
},{captureEmail:true,damagedGraphicScenes:true});
