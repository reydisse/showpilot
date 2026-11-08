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
const ids={},names=["saveServiceDetails","reviewServiceDetails"],assets=resolve(import.meta.dirname,"../dist/server/assets");
for(const file of(await readdir(assets)).filter(file=>file.endsWith(".js"))){const source=await readFile(resolve(assets,file),"utf8");for(const name of names)ids[name]??=source.match(new RegExp(`const ${name}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`))?.[1];}
assert.ok(names.every(name=>ids[name]));
await withLocalSmokeFixture(async({origin,orgId,date,queryFixture,operatorCookie})=>{
 await withRealBrowser({origin,cookie:operatorCookie},async({page,evaluate})=>{
  await page("Page.enable");await page("Emulation.setFocusEmulationEnabled",{enabled:true});await page("Emulation.setDeviceMetricsOverride",{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await page("Page.addScriptToEvaluateOnNewDocument",{source:`
   window.detailsCalls=[];window.detailsReviews=[];window.detailsHeld=[];window.detailsMode='after';window.detailsErrors=[];window.detailsDocument='same';
   addEventListener('error',e=>detailsErrors.push(e.message));addEventListener('unhandledrejection',e=>detailsErrors.push(String(e.reason)));
   const original=fetch;window.fetch=async(input,options)=>{
    const url=input instanceof Request?input.url:String(input);
    if(url.includes('/_serverFn/${ids.reviewServiceDetails}'))detailsReviews.push(options.body);
    if(!url.includes('/_serverFn/${ids.saveServiceDetails}'))return original(input,options);
    detailsCalls.push(options.body);const mode=detailsMode;
    const send=()=>original(input,{...options,signal:new AbortController().signal});
    if(mode==='before')return new Promise((resolve,reject)=>detailsHeld.push({mode,release:()=>send().then(resolve,reject)}));
    const response=await send();if(mode!=='after')return response;
    const bytes=await response.arrayBuffer();return new Promise(resolve=>detailsHeld.push({mode,release:()=>resolve(new Response(bytes,{status:response.status,headers:response.headers}))}));
   };`});
  const check=(expression,label)=>poll(()=>evaluate(expression),label).catch(async error=>{console.log(JSON.stringify({label,body:await evaluate('document.body.innerText'),errors:await evaluate('detailsErrors')}));throw error;});
  const button=name=>`[...(document.querySelector('[role=dialog]')??document).querySelectorAll('button')].find(n=>(n.textContent.trim()===${JSON.stringify(name)}||n.getAttribute('aria-label')===${JSON.stringify(name)})&&!n.disabled)`;
  const field=label=>`[...document.querySelectorAll('label')].find(n=>n.childNodes[0]?.textContent.trim()===${JSON.stringify(label)})?.querySelector('input,select')`;
  const click=async expression=>{const point=await check(`(async()=>{const n=${expression};if(!n||!Object.keys(n).some(k=>k.startsWith('__reactProps')))return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`,'reachable '+expression);for(const type of ['mousePressed','mouseReleased'])await page('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point});};
  const fill=async(label,value)=>{await check(`!!(${field(label)})`,'field '+label);await evaluate(`(()=>{const n=${field(label)};Object.getOwnPropertyDescriptor(n instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event(n instanceof HTMLSelectElement?'change':'input',{bubbles:true}));})()`);await check(`(${field(label)})?.value===${JSON.stringify(value)}`,'retained '+label);};
  const openDetails=async()=>{await click(`[...document.querySelectorAll('button')].find(n=>n.getAttribute('aria-label')?.startsWith('Edit ')&&!n.disabled)`);await check(`!!${button('Save show details')}`,'details form');};
  await page('Page.navigate',{url:`${origin}/${orgId}/schedule?show=smoke-show`});await openDetails();
  const titleLabel=await evaluate(`document.querySelector('[role=dialog] input[maxlength="120"]').getAttribute('aria-label')`);
  await fill(titleLabel,'Retained browser details');await fill('Venue or location','Studio B');
  await click(button('Close Show details'));await click(`document.querySelector('a[href="/${orgId}/songs"]')`);await check("location.pathname.endsWith('/songs')",'navigate away');await evaluate('history.back()');await check("location.pathname.endsWith('/schedule')",'return to schedule');await openDetails();
  assert.equal(await evaluate(`(${field(titleLabel)}).value`),'Retained browser details');
  await click(button('Save show details'));await check("detailsHeld.some(item=>item.mode==='after')",'saved reply held');
  await click(button('Close Show details'));await click(`document.querySelector('a[href="/${orgId}/songs"]')`);await check("location.pathname.endsWith('/songs')",'leave pending save');await evaluate('history.back()');await check("location.pathname.endsWith('/schedule')",'return pending save');
  await click(`[...document.querySelectorAll('button')].find(n=>n.getAttribute('aria-label')?.startsWith('Edit ')&&!n.disabled)`);
  await check(`!!${button('Retry original save')}`,'bounded save failure retained');
  const layout=async(name,prefix)=>{for(const[width,height]of[[320,480],[768,1024],[1440,1000]]){
    await page('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    const measured=await check(`(async()=>{const n=${button(name)};if(!n)return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),d=n.closest('[role=dialog]').getBoundingClientRect(),drawer=document.querySelector('aside[aria-hidden=true]');return b.left>=0&&b.right<=innerWidth&&b.top>=0&&b.bottom<=innerHeight&&(!drawer||drawer.getBoundingClientRect().right<=0)&&n.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))?{height:b.height,dialogWidth:d.width,viewport:innerWidth}:null;})()`,'reachable '+name+' '+width);
    assert.ok(measured.height>=44&&measured.dialogWidth<=measured.viewport);
    await writeFile(`/tmp/showpilot-details-${prefix}-${width}.png`,Buffer.from((await page('Page.captureScreenshot',{format:'png'})).data,'base64'));
  }};
  await layout('Retry original save','retry');
  const calls=()=>evaluate('detailsCalls').then(values=>values.map(body=>fromJSON(JSON.parse(body)).data));
  const first=(await calls())[0];
  await evaluate("detailsMode='normal'");await click(button('Retry original save'));await check("!document.querySelector('[role=dialog]')",'confirmed save refreshed');
  assert.deepEqual((await calls())[1],first);
  assert.equal((await queryFixture(`SELECT COUNT(*) AS count FROM show_details_request WHERE orgId='display-smoke' AND requestId='${first.requestId}'`))[0].count,1);
  assert.equal((await queryFixture("SELECT name FROM rundown WHERE orgId='display-smoke' AND id='smoke-show'"))[0].name,'Retained browser details');
  await evaluate("detailsHeld.filter(item=>item.mode==='after').forEach(item=>item.release())");
  await openDetails();await fill(titleLabel,'Pending before delivery');await evaluate("detailsMode='before'");await click(button('Save show details'));
  await check("detailsHeld.some(item=>item.mode==='before')",'undelivered save held');await check(`!!${button('Review save')}`,'review available after deadline');await click(button('Review save'));await check(`!!${button('Save show details')}`,'review unlocks retained draft');
  const cancelled=(await calls()).at(-1);
  assert.equal((await queryFixture(`SELECT outcome FROM show_details_request WHERE orgId='display-smoke' AND requestId='${cancelled.requestId}'`))[0].outcome,'cancelled');
  await evaluate("detailsHeld.filter(item=>item.mode==='before').forEach(item=>item.release());detailsMode='normal'");
  await fill(titleLabel,'Reviewed browser details');await click(button('Save show details'));await check("!document.querySelector('[role=dialog]')",'reviewed details refreshed');
  assert.notEqual((await calls()).at(-1).requestId,cancelled.requestId);
  assert.equal((await queryFixture("SELECT name FROM rundown WHERE orgId='display-smoke' AND id='smoke-show'"))[0].name,'Reviewed browser details');
  await openDetails();await fill(titleLabel,'My reviewed replacement');
  const response=await fetch(`${origin}/api/rundown/${orgId}/command?showId=smoke-show&serviceDate=${date}`,{method:'POST',headers:{Cookie:operatorCookie,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({action:'update-meta',payload:{serviceName:'Another operator title'}})});
  assert.equal(response.status,200,await response.clone().text());await response.arrayBuffer();
  await click(button('Save show details'));await check("document.querySelector('[aria-label=\"Current show details\"]')?.textContent.includes('Another operator title')",'current conflicting details visible');
  await layout('Keep my edits','conflict');await click(button('Keep my edits'));await click(button('Save show details'));await check("!document.querySelector('[role=dialog]')",'reviewed conflict saved');
  assert.equal((await queryFixture("SELECT name FROM rundown WHERE orgId='display-smoke' AND id='smoke-show'"))[0].name,'My reviewed replacement');
  assert.equal(await evaluate('detailsDocument'),'same');assert.deepEqual(await evaluate('detailsErrors'),[]);
  console.log(JSON.stringify({draftRetained:true,originalSaveRetried:true,oneReceipt:true,delayedSaveFenced:true,reviewedRequestSaved:true,conflictReviewedBeforeOverwrite:true,viewports:[320,768,1440],errors:[]}));
 });
});
