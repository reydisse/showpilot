// Anonymous shared-kiosk rehearsal against the compiled Worker and disposable D1.
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
const ids={};const names=['publicCheckInByMemberId','getPublicCrewMemberByMemberId'];
const assets=resolve(import.meta.dirname,'../dist/server/assets');
for(const file of(await readdir(assets)).filter(file=>file.endsWith('.js'))){
 const source=await readFile(resolve(assets,file),'utf8');
 for(const name of names)ids[name]??=source.match(new RegExp(`const ${name}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`))?.[1];
}
assert.ok(names.every(name=>ids[name]));
const requests=new Set();
await withLocalSmokeFixture(async({origin,orgId,stopServer,queryFixture,serverState})=>{
 async function rpc(name,data){
  const serialized=JSON.stringify(await toJSONAsync({data}));
  const headers={Origin:origin,'Sec-Fetch-Site':'same-origin','x-tsr-serverFn':'true','Content-Type':'application/json'};
  const url=`${origin}/_serverFn/${ids[name]}`;
  const response=await fetch(name==='publicCheckInByMemberId'?url:`${url}?payload=${encodeURIComponent(serialized)}`,name==='publicCheckInByMemberId'?{method:'POST',headers,body:serialized}:{headers});
  assert.equal(response.status,200);
  const reply=fromCrossJSON(await response.json(),{refs:new Map(),plugins:defaultSerovalPlugins});
  assert.equal(reply.error,undefined);assert.ok(reply.result);return reply.result;
 }
 await withRealBrowser({origin},async({page,evaluate})=>{
  await page('Page.enable');await page('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await page('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.kioskDocument=crypto.randomUUID();window.kioskErrors=[];window.kioskModes={};window.kioskCalls={};window.kioskWrites=[];window.kioskHeld=[];
    localStorage.setItem('showpilot-checkin:${orgId}:memberId','TD3917');
    addEventListener('error',event=>window.kioskErrors.push(event.message));addEventListener('unhandledrejection',event=>window.kioskErrors.push(String(event.reason)));
    const ids=${JSON.stringify(ids)};const original=window.fetch;
    window.fetch=(input,init)=>{
      const url=input instanceof Request?input.url:String(input);const name=Object.keys(ids).find(name=>url.includes('/_serverFn/'+ids[name]));
      if(!name)return original(input,init);window.kioskCalls[name]=(window.kioskCalls[name]??0)+1;
      if(name==='publicCheckInByMemberId')window.kioskWrites.push(init.body);
      const mode=window.kioskModes[name];
      if(mode==='reject-once'){delete window.kioskModes[name];return Promise.reject(new Error('Fixture connection failed'));}
      const response=original(input,{...init,signal:new AbortController().signal}).then(async response=>new Response(await response.arrayBuffer(),{status:response.status,headers:response.headers}));
      if(mode==='hold')return new Promise(resolve=>window.kioskHeld.push({name,signal:init?.signal,release:async()=>resolve(await response)}));
      return response;
    };`});
  const check=async(expression,label,timeout)=>{
   try{return await poll(()=>evaluate(expression),label,timeout);}catch(error){console.log(JSON.stringify({failed:label,server:serverState(),ui:await evaluate(`({url:location.href,calls:window.kioskCalls,errors:window.kioskErrors,text:document.body.innerText})`)}));throw error;}
  };
  const click=async(name)=>{
   let point;await poll(async()=>{
    point=await evaluate(`(async()=>{const node=[...document.querySelectorAll('button')].find(node=>node.textContent.trim()===${JSON.stringify(name)}&&!node.disabled&&node.getBoundingClientRect().width>0&&node.closest('[role="dialog"]')?.dataset.state!=='closed');if(!node)return null;node.scrollIntoView({block:'center'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const r=node.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return node.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`);return !!point;
   },`reachable ${name}`);
   await page('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await page('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
  };
  const fill=id=>evaluate(`(()=>{const node=document.querySelector('#member-id');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,${JSON.stringify(id)});node.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  const mode=(name,value)=>evaluate(`window.kioskModes[${JSON.stringify(name)}]=${JSON.stringify(value)};true`);
  await page('Page.navigate',{url:`${origin}/checkin/${orgId}`});
  await check(`!!document.querySelector('#member-id')&&localStorage.getItem('showpilot-checkin:${orgId}:memberId')===null`,'fresh anonymous entry');
  const documentId=await evaluate('window.kioskDocument');
  assert.equal(await evaluate(`document.body.textContent.includes('Previous fixture person')`),false);
  assert.equal(await evaluate('window.kioskCalls.getPublicCrewMemberByMemberId??0'),0);
  assert.equal(await evaluate('window.kioskCalls.publicCheckInByMemberId??0'),0);
  await mode('getPublicCrewMemberByMemberId','hold');await fill('TD3917');await click('Find my name');
  await check(`document.body.textContent.includes('Confirmation timed out')`,'bounded lookup',14_000);
  for(const width of [320,768,1440]){
   await page('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
   await check('document.documentElement.scrollWidth<=innerWidth+1','no kiosk overflow');
   const bounds=await evaluate(`(()=>{const node=[...document.querySelectorAll('button')].find(n=>n.textContent==='Retry lookup');node.scrollIntoView({block:'center'});const r=node.getBoundingClientRect();return {height:r.height,width:r.width};})()`);
   assert.ok(bounds.height>=44&&bounds.width>=44);
   if(width===320)await writeFile('/tmp/showpilot-checkin-error-320.png',Buffer.from((await page('Page.captureScreenshot',{format:'png'})).data,'base64'));
  }
  await mode('getPublicCrewMemberByMemberId','normal');await click('Retry lookup');
  await check(`document.body.textContent.includes('Is this you, Previous fixture person?')`,'explicit identity confirmation');
  assert.equal(await evaluate('window.kioskCalls.publicCheckInByMemberId??0'),0);
  await click('Not me · use another ID');await check(`document.querySelector('#member-id')?.value===''`,'declined identity cleared');
  await fill('TD3917');await click('Find my name');await check(`document.body.textContent.includes('Is this you, Previous fixture person?')`,'fresh lookup again');
  await mode('publicCheckInByMemberId','hold');await click('Yes, check me in');
  await check(`document.body.textContent.includes('Attendance not confirmed')`,'bounded attendance',14_000);
  const current=await rpc('getPublicCrewMemberByMemberId',{slug:orgId,memberId:'TD3917'});assert.equal(current.isOnline,true,'lost reply was actually committed');
  const later={slug:orgId,memberId:'TD3917',intent:'check-out',expectedRevision:current.revision,requestId:crypto.randomUUID()};requests.add(later.requestId);
  assert.equal((await rpc('publicCheckInByMemberId',later)).member.isOnline,false);
  await evaluate('Promise.all(window.kioskHeld.map(item=>item.release())).then(()=>true)');
  assert.equal(await evaluate(`document.body.textContent.includes('Attendance not confirmed')`),true,'late acknowledgement ignored');
  await mode('publicCheckInByMemberId','normal');await click('Retry attendance');
  await check(`document.body.textContent.includes('Attendance changed')`,'old retry preserves later checkout');
  assert.equal(await evaluate(`document.body.textContent.includes('Checked in')`),false);
  assert.equal(await evaluate('window.kioskWrites[0]===window.kioskWrites[1]'),true,'same request on Retry');
  await click('Done');await fill('CAM42');await click('Find my name');await check(`document.body.textContent.includes('Is this you, Next fixture person?')`,'next person must enter own ID');
  await mode('publicCheckInByMemberId','reject-once');await click('Yes, check me in');
  await check(`document.body.textContent.includes('Attendance not confirmed')`,'network rejection');
  await click('Start over');await check(`!!document.querySelector('[role="dialog"][data-state="open"]')`,'discard retry warning');await click('Cancel');
  await click('Retry attendance');await check(`document.body.textContent.includes('Checked in')`,'new person confirmed');
  await page('Emulation.setDeviceMetricsOverride',{width:320,height:900,deviceScaleFactor:1,mobile:false});
  await writeFile('/tmp/showpilot-checkin-success-320.png',Buffer.from((await page('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await check(`!!document.querySelector('#member-id')&&!document.body.textContent.includes('Next fixture person')`,'completed identity expires',18_000);
  assert.equal(await evaluate('window.kioskDocument'),documentId);
  assert.equal(await evaluate(`localStorage.getItem('showpilot-checkin:${orgId}:memberId')`),null);
  assert.deepEqual(await evaluate('window.kioskErrors'),[]);
  const writes=(await evaluate('window.kioskWrites')).map(body=>fromJSON(JSON.parse(body)).data);
  writes.forEach(input=>requests.add(input.requestId));
  assert.equal(writes[2].requestId,writes[3].requestId);
  console.log(JSON.stringify({browserPassed:true,anonymous:true,freshIdentityRequired:true,lateResponseIgnored:true,oldRetryPreservesCheckout:true,viewports:[320,768,1440],errors:0}));
  await page('Page.navigate',{url:`${origin}/checkin/absent-fixture-org`});
  // Page.navigate acknowledges navigation before the new document has a body.
  // Require the destination as well as its content so the next check cannot
  // accidentally accept the previous error page during navigation.
  await check(`location.pathname==='/checkin/absent-fixture-org'&&document.body?.textContent.includes('Organization not found')`,'invalid org stays on explicit error page');
  assert.equal(await evaluate('location.pathname'),'/checkin/absent-fixture-org');
  await page('Page.navigate',{url:`${origin}/checkin/${'a'.repeat(65)}`});
  await check(`location.pathname==='/checkin/${'a'.repeat(65)}'&&document.body?.textContent.includes('Organization not found')`,'malformed org link');
  assert.deepEqual(await evaluate('window.kioskErrors'),[]);
 });
 await stopServer();
 const rows=await queryFixture("SELECT orgId,memberId,isOnline,lastCheckIn,lastCheckOut FROM crew_member ORDER BY orgId,memberId");
 assert.equal(rows.find(row=>row.orgId===orgId&&row.memberId==='TD3917').isOnline,0);
 assert.equal(rows.find(row=>row.orgId===orgId&&row.memberId==='CAM42').isOnline,1);
 assert.equal(rows.find(row=>row.orgId==='display-other').isOnline,0);
 const receipts=await queryFixture(`SELECT key FROM app_setting WHERE orgId='${orgId}' AND key LIKE 'public-attendance:%'`);
 assert.deepEqual(receipts.map(row=>row.key.slice('public-attendance:'.length)).sort(),[...requests].sort());
 assert.equal(receipts.length,3);
 console.log(JSON.stringify({databasePassed:true,receipts:receipts.length,otherOrgUnchanged:true}));
},{publicCheckInMembers:true});
