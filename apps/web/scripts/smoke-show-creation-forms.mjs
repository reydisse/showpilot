// Compiled React, authenticated RPCs, real D1/relay. Only transport replies are held.
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {readFile,readdir,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {withLocalSmokeFixture} from "./local-smoke-fixture.mjs";
import {poll,withRealBrowser} from "./real-browser-fixture.mjs";
const require=createRequire(new URL("../package.json",import.meta.url));
const router=createRequire(require.resolve("@tanstack/react-router")),core=createRequire(router.resolve("@tanstack/router-core"));
const {fromJSON}=core("seroval");
const ids={},names=["createNextService","reviewShowCreation"],assets=resolve(import.meta.dirname,"../dist/server/assets");
for(const file of(await readdir(assets)).filter(file=>file.endsWith(".js"))){const source=await readFile(resolve(assets,file),"utf8");for(const name of names)ids[name]??=source.match(new RegExp(`const ${name}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`))?.[1];}
assert.ok(names.every(name=>ids[name]));
await withLocalSmokeFixture(async({origin,orgId,queryFixture,operatorCookie})=>{
 await withRealBrowser({origin,cookie:operatorCookie},async({page,evaluate})=>{
  await page("Page.enable");await page("Emulation.setFocusEmulationEnabled",{enabled:true});await page("Emulation.setDeviceMetricsOverride",{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await page("Page.addScriptToEvaluateOnNewDocument",{source:`
   window.creationCalls=[];window.creationReviews=[];window.creationHeld=[];window.creationMode='after';window.creationErrors=[];window.creationDocument='same';
   addEventListener('error',e=>creationErrors.push(e.message));addEventListener('unhandledrejection',e=>creationErrors.push(String(e.reason)));
   const original=fetch;window.fetch=async(input,options)=>{
    const url=input instanceof Request?input.url:String(input);
    if(url.includes('/_serverFn/${ids.reviewShowCreation}'))creationReviews.push(options.body);
    if(!url.includes('/_serverFn/${ids.createNextService}'))return original(input,options);
    creationCalls.push(options.body);const mode=creationMode;
    const send=()=>original(input,{...options,signal:new AbortController().signal});
    if(mode==='before')return new Promise((resolve,reject)=>creationHeld.push({mode,release:()=>send().then(resolve,reject)}));
    const response=await send();if(mode!=='after')return response;
    const bytes=await response.arrayBuffer();return new Promise(resolve=>creationHeld.push({mode,release:()=>resolve(new Response(bytes,{status:response.status,headers:response.headers}))}));
   };`});
  const check=(expression,label)=>poll(()=>evaluate(expression),label).catch(async error=>{console.log(JSON.stringify({label,body:await evaluate('document.body.innerText'),errors:await evaluate('creationErrors')}));throw error;});
  const button=name=>`[...(document.querySelector('[role=dialog]')??document).querySelectorAll('button')].find(n=>(n.textContent.trim()===${JSON.stringify(name)}||n.getAttribute('aria-label')===${JSON.stringify(name)})&&!n.disabled)`;
  const field=label=>`[...document.querySelectorAll('label')].find(n=>n.childNodes[0]?.textContent.trim()===${JSON.stringify(label)})?.querySelector('input,select')`;
  const click=async expression=>{const point=await check(`(async()=>{const n=${expression};if(!n||!Object.keys(n).some(k=>k.startsWith('__reactProps')))return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`,'reachable '+expression);for(const type of ['mousePressed','mouseReleased'])await page('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point});};
  const fill=async(label,value)=>{await check(`!!(${field(label)})`,'field '+label);await evaluate(`(()=>{const n=${field(label)};Object.getOwnPropertyDescriptor(n instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event(n instanceof HTMLSelectElement?'change':'input',{bubbles:true}));})()`);await check(`(${field(label)})?.value===${JSON.stringify(value)}`,'retained '+label);};
  const newRundown=async()=>{await click(button('Show options'));await click(button('Create another show'));await check(`!!${button('Create show')}`,'new show form');};
  await page('Page.navigate',{url:`${origin}/${orgId}/rundown`});await newRundown();
  await fill('Show name','Retained browser show');await fill('Venue or location','Studio B');
  await click(button('Close'));await click(`document.querySelector('a[href="/${orgId}/songs"]')`);await check("location.pathname.endsWith('/songs')",'navigate away');await evaluate('history.back()');await check("location.pathname.endsWith('/rundown')",'return to rundown');await newRundown();
  assert.equal(await evaluate(`(${field('Show name')}).value`),'Retained browser show');
  await click(button('Create show'));await check("creationHeld.some(item=>item.mode==='after')",'committed creation reply held');
  await click(button('Close'));await click(`document.querySelector('a[href="/${orgId}/songs"]')`);await check("location.pathname.endsWith('/songs')",'leave pending creation');await evaluate('history.back()');await check("location.pathname.endsWith('/rundown')",'return pending creation');
  await click(button('Show options'));await click(button('Create another show'));await check(`!!${button('Retry creation')}`,'bounded creation failure retained');
  for(const [width,height]of [[320,480],[768,1024],[1440,1000]]){
   await page('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
   const layout=await check(`(async()=>{const n=${button('Retry creation')};if(!n)return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),d=n.closest('[role=dialog]').getBoundingClientRect();return b.left>=0&&b.right<=innerWidth&&b.top>=0&&b.bottom<=innerHeight&&n.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))?{height:b.height,dialogWidth:d.width,viewport:innerWidth}:null;})()`,'recovery fits '+width);
   assert.ok(layout.height>=44&&layout.dialogWidth<=layout.viewport);await writeFile(`/tmp/showpilot-create-form-${width}.png`,Buffer.from((await page('Page.captureScreenshot',{format:'png'})).data,'base64'));
  }
  await evaluate("creationMode='normal'");await click(button('Retry creation'));
  const first=fromJSON(JSON.parse((await evaluate('creationCalls'))[0])).data;
  await check(`!document.querySelector('[role=dialog]')&&new URL(location.href).searchParams.get('show')===${JSON.stringify(first.requestId)}`,'created show opened');
  let calls=(await evaluate('creationCalls')).map(body=>fromJSON(JSON.parse(body)).data);assert.deepEqual(calls[1],calls[0]);
  assert.equal((await queryFixture("SELECT id FROM rundown WHERE orgId='display-smoke' AND name='Retained browser show'")).length,1);
  await evaluate("creationHeld.filter(item=>item.mode==='after').forEach(item=>item.release())");
  await click(`document.querySelector('a[href="/${orgId}/schedule"]')`);await check("location.pathname.endsWith('/schedule')",'schedule form entry');
  await click(`[...document.querySelectorAll('button')].find(n=>/^New (show|service|event)$/i.test(n.textContent.trim())&&!n.disabled)`);
  await fill('Show name','Pending before delivery');await fill('Rundown source','');await evaluate("creationMode='before'");await click(button('Create show'));
  await check("creationHeld.some(item=>item.mode==='before')",'unsubmitted creation held');await check(`!!${button('Edit request')}`,'deadline allows request review');await click(button('Edit request'));await check(`!!${button('Create show')}`,'review unlocks draft');
  calls=(await evaluate('creationCalls')).map(body=>fromJSON(JSON.parse(body)).data);const cancelled=calls.at(-1);
  assert.equal((await queryFixture(`SELECT cancelledAt FROM show_creation_request WHERE orgId='display-smoke' AND requestId='${cancelled.requestId}'`))[0].cancelledAt>0,true);
  await evaluate("creationHeld.filter(item=>item.mode==='before').forEach(item=>item.release());creationMode='normal'");
  await fill('Show name','Reviewed browser show');await click(button('Create show'));await check("!document.querySelector('[role=dialog]')",'reviewed show opened');
  calls=(await evaluate('creationCalls')).map(body=>fromJSON(JSON.parse(body)).data);assert.notEqual(calls.at(-1).requestId,cancelled.requestId);
  assert.deepEqual(await queryFixture(`SELECT id FROM rundown WHERE orgId='display-smoke' AND id='${cancelled.requestId}'`),[]);
  assert.equal((await queryFixture("SELECT id FROM rundown WHERE orgId='display-smoke' AND name='Reviewed browser show'")).length,1);
  assert.equal(await evaluate('creationDocument'),'same');assert.deepEqual(await evaluate('creationErrors'),[]);
  await page('Page.navigate',{url:`${origin}/${orgId}/dashboard/prod-manager`});
  await click(`[...document.querySelectorAll('button')].find(n=>/^Plan a (show|service|event)$/i.test(n.textContent.trim())&&!n.disabled)`);
  await fill('Show name','Dashboard retained draft');
  for(const [width,height]of [[320,480],[768,1024],[1440,1000]]){
    await page('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    const layout=await check(`(async()=>{const n=${button('Create show')};if(!n)return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),f=n.closest('form').getBoundingClientRect(),drawer=document.querySelector('aside[aria-hidden=true]');return b.left>=0&&b.right<=innerWidth&&b.top>=0&&b.bottom<=innerHeight&&(!drawer||drawer.getBoundingClientRect().right<=0)&&n.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))?{height:b.height,width:f.width,viewport:innerWidth}:null;})()`,'dashboard form fits '+width);
    assert.ok(layout.height>=44&&layout.width<=layout.viewport);
    await writeFile(`/tmp/showpilot-create-dashboard-${width}.png`,Buffer.from((await page('Page.captureScreenshot',{format:'png'})).data,'base64'));
  }
  await click(button('Close'));
  await click(`[...document.querySelectorAll('button')].find(n=>/^Plan a (show|service|event)$/i.test(n.textContent.trim())&&!n.disabled)`);
  assert.equal(await evaluate(`(${field('Show name')}).value`),'Dashboard retained draft');
  assert.deepEqual(await evaluate('creationErrors'),[]);
  console.log(JSON.stringify({draftRetained:true,originalRequestRetried:true,createdOnce:true,delayedWriteFencedBeforeEdit:true,reviewedRequestCreatedOnce:true,entries:['rundown','schedule'],dashboardDraftAndLayout:true,viewports:[320,768,1440],errors:[]}));
 });
});
