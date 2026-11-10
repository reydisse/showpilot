// Real-auth two-operator attendance recovery, using compiled RPCs and disposable D1.
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
const ids={},names=['getCheckInMembers','changeCrewAttendance'];
const assets=resolve(import.meta.dirname,'../dist/server/assets');
for(const file of(await readdir(assets)).filter(file=>file.endsWith('.js'))){
 const source=await readFile(resolve(assets,file),'utf8');
 assert.doesNotMatch(source,/const (?:toggleCheckIn|setAllCrewCheckIn|checkInByMemberId)_createServerFn_handler/,'Retired unconditional attendance RPCs must not be bundled');
 for(const name of names)ids[name]??=source.match(new RegExp(`const ${name}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`))?.[1];
}
assert.ok(names.every(name=>ids[name]));
const expectedRequests=new Set();
await withLocalSmokeFixture(async({origin,orgId,operatorCookie,operatorPassword,stopServer,queryFixture,serverState})=>{
 const login=await fetch(`${origin}/api/auth/sign-in/email`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email:'second@display-smoke.invalid',password:operatorPassword})});
 assert.equal(login.status,200);await login.arrayBuffer();const secondCookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
 async function rpc(name,data,cookie=secondCookie){
  const serialized=JSON.stringify(await toJSONAsync({data:{orgId,...data}}));
  const headers={Cookie:cookie,Origin:origin,'Sec-Fetch-Site':'same-origin','x-tsr-serverFn':'true','Content-Type':'application/json'};
  const url=`${origin}/_serverFn/${ids[name]}`;
  const response=await fetch(name==='changeCrewAttendance'?url:`${url}?payload=${encodeURIComponent(serialized)}`,name==='changeCrewAttendance'?{method:'POST',headers,body:serialized}:{headers});
  assert.equal(response.status,200);const reply=fromCrossJSON(await response.json(),{refs:new Map(),plugins:defaultSerovalPlugins});assert.equal(reply.error,undefined);return reply.result;
 }
 async function otherChange(memberId,isOnline){
  const rows=await rpc('getCheckInMembers',{});const member=rows.find(row=>row.memberId===memberId);assert.ok(member);
  const input={requestId:crypto.randomUUID(),isOnline,members:[{id:member.id,expectedRevision:member.revision}]};expectedRequests.add(input.requestId);
  assert.equal((await rpc('changeCrewAttendance',input)).outcome,'applied');
 }
 await withRealBrowser({origin,cookie:operatorCookie},async({page,evaluate})=>{
  await page('Page.enable');await page('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await page('Page.addScriptToEvaluateOnNewDocument',{source:`
   window.attendanceDocument=crypto.randomUUID();window.attendanceErrors=[];window.attendanceModes={};window.attendanceCalls={};window.attendanceWrites=[];window.attendanceHeld=[];
   addEventListener('error',event=>window.attendanceErrors.push(event.message));addEventListener('unhandledrejection',event=>window.attendanceErrors.push(String(event.reason)));
   const ids=${JSON.stringify(ids)};const original=window.fetch;
   window.fetch=(input,init)=>{
    const url=input instanceof Request?input.url:String(input);const name=Object.keys(ids).find(name=>url.includes('/_serverFn/'+ids[name]));
    if(!name)return original(input,init);window.attendanceCalls[name]=(window.attendanceCalls[name]??0)+1;
    if(name==='changeCrewAttendance')window.attendanceWrites.push(init.body);
    const response=original(input,{...init,signal:new AbortController().signal}).then(async response=>new Response(await response.arrayBuffer(),{status:response.status,headers:response.headers}));
    if(window.attendanceModes[name]==='hold')return new Promise(resolve=>window.attendanceHeld.push({name,signal:init?.signal,release:async()=>resolve(await response)}));
    return response;
   };`});
  const check=async(expression,label,timeout)=>{
   try{return await poll(()=>evaluate(expression),label,timeout);}catch(error){console.log(JSON.stringify({failed:label,server:serverState(),ui:await evaluate(`({url:location.href,calls:window.attendanceCalls,errors:window.attendanceErrors,text:document.body.innerText})`)}));throw error;}
  };
  const click=async(name)=>{
   let point;await poll(async()=>{
    point=await evaluate(`(async()=>{for(const node of [...document.querySelectorAll('button')].filter(node=>(node.getAttribute('aria-label')===${JSON.stringify(name)}||node.textContent.trim()===${JSON.stringify(name)})&&!node.disabled&&node.getBoundingClientRect().width>0&&node.closest('[role="dialog"]')?.dataset.state!=='closed')){node.scrollIntoView({block:'center'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const r=node.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(node.contains(document.elementFromPoint(x,y)))return {x,y};}return null;})()`);return !!point;
   },`reachable ${name}`);
   await page('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await page('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
  };
  const fill=(selector,value)=>evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  const mode=(name,value)=>evaluate(`window.attendanceModes[${JSON.stringify(name)}]=${JSON.stringify(value)};true`);
  const hasButton=(name,enabled=false)=>`!![...document.querySelectorAll('button')].find(node=>(node.getAttribute('aria-label')===${JSON.stringify(name)}||node.textContent.trim()===${JSON.stringify(name)})${enabled?'&&!node.disabled':''})`;
  const rowReady=name=>check(hasButton(name,true),name);
  await page('Page.navigate',{url:`${origin}/${orgId}/checkin`});
  await check(`!!document.querySelector('#crew-member-id')&&window.attendanceCalls.getCheckInMembers>=1`,'hydrated attendance');
  const documentId=await evaluate('window.attendanceDocument');
  await fill('#crew-member-id','TD3917');await click('Find crew member');await rowReady('Check Previous fixture person in');
  assert.equal(await evaluate('window.attendanceCalls.changeCrewAttendance??0'),0,'ID entry only selects an explicit intent');
  await click('Browse crew');await mode('changeCrewAttendance','hold');await click('Check Previous fixture person in');
  await check(hasButton('Retry attendance'),'bounded row confirmation',14_000);
  const first=await rpc('getCheckInMembers',{});assert.equal(first.find(row=>row.memberId==='TD3917').isOnline,true);
  await otherChange('TD3917',false);
  await click('Enter member ID');assert.equal(await evaluate(hasButton('Retry attendance')),true,'mode switch retains uncertain operation');
  await evaluate(`document.querySelector('a[href="/${orgId}/show"]').click();true`);
  await check(`document.body.textContent.includes('Leave crew check-in?')`,'navigation guard');await click('Stay');
  for(const width of [320,768,1440]){
   await page('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
   await check('document.documentElement.scrollWidth<=innerWidth+1','no recovery overflow');
   let geometry;
   await poll(async()=>{
    geometry=await evaluate(`(async()=>{const node=[...document.querySelectorAll('button')].find(n=>n.textContent==='Retry attendance');node.scrollIntoView({block:'center'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const r=node.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height,width:r.width,hit:node.contains(hit),covering:hit?.outerHTML.slice(0,250)};})()`);
    return geometry.height>=44&&geometry.width>=44&&geometry.left>=0&&geometry.right<=width&&geometry.top>=0&&geometry.bottom<=900&&geometry.hit;
   },`settled ${width}px recovery target`).catch(async error=>{console.log(JSON.stringify({width,geometry}));await writeFile('/tmp/showpilot-crew-attendance-hit-failure.png',Buffer.from((await page('Page.captureScreenshot',{format:'png'})).data,'base64'));throw error;});
   if(width===320)await writeFile('/tmp/showpilot-crew-attendance-error-320.png',Buffer.from((await page('Page.captureScreenshot',{format:'png'})).data,'base64'));
  }
  await mode('changeCrewAttendance','normal');await click('Retry attendance');
  await check(`document.body.textContent.includes('Previous fixture person: checked out')`,'row Retry preserves later operator change');
  await evaluate('Promise.all(window.attendanceHeld.map(item=>item.release())).then(()=>true)');
  assert.equal(await evaluate('window.attendanceWrites[0]===window.attendanceWrites[1]'),true);
  await click('Browse crew');await mode('getCheckInMembers','hold');await click('Check Next fixture person in');
  await check(hasButton('Retry crew list'),'bounded refresh after acknowledged write',12_000);
  assert.equal(await evaluate(`document.body.textContent.includes('Attendance change saved')`),true);
  assert.equal(await evaluate(hasButton('Retry attendance')),false,'Read failure is not an unconfirmed write');
  const beforeReadRetry=await evaluate('window.attendanceCalls.changeCrewAttendance');
  await mode('getCheckInMembers','normal');await click('Retry crew list');await rowReady('Check Next fixture person out');
  assert.equal(await evaluate('window.attendanceCalls.changeCrewAttendance'),beforeReadRetry);
  await evaluate('Promise.all(window.attendanceHeld.map(item=>item.release())).then(()=>true)');
  console.log('Row acknowledgement, later-operator preservation, and read-only Retry passed');
  await fill('#crew-checkin-search','Previous');
  const beforeCancel=await evaluate('window.attendanceCalls.changeCrewAttendance');
  await click('Check all 2 crew out');await check(`!!document.querySelector('[role="dialog"][data-state="open"]')`,'bulk confirmation');await click('Cancel');
  assert.equal(await evaluate('window.attendanceCalls.changeCrewAttendance'),beforeCancel);
  await click('Check all 2 crew out');await check(`!!document.querySelector('[role="dialog"][data-state="open"]')`,'captured bulk selection');
  await otherChange('TD3917',true);
  await click('Check crew out');await rowReady('Review updated crew');
  assert.equal((await rpc('getCheckInMembers',{})).every(member=>member.isOnline),true,'Stale bulk request changes nobody');
  await click('Review updated crew');await click('Clear crew search');
  await mode('changeCrewAttendance','hold');await click('Check all 2 crew out');await click('Check crew out');
  await check(hasButton('Retry attendance'),'bounded bulk acknowledgement',14_000);
  const afterBulk=await rpc('getCheckInMembers',{});assert.equal(afterBulk.every(member=>!member.isOnline),true);
  await otherChange('CAM42',true);
  await mode('changeCrewAttendance','normal');await click('Retry attendance');await rowReady('Check Next fixture person out');await rowReady('Check Previous fixture person in');
  await evaluate('Promise.all(window.attendanceHeld.map(item=>item.release())).then(()=>true)');
  assert.equal(await evaluate('window.attendanceWrites[4]===window.attendanceWrites[5]'),true,'bulk Retry uses identical request');
  for(const width of [320,768,1440]){
   await page('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
   await check('document.documentElement.scrollWidth<=innerWidth+1','no roster overflow');
   await check(`(()=>{const heading=document.querySelector('h1'),r=heading.getBoundingClientRect();return r.height<=parseFloat(getComputedStyle(heading).lineHeight)+1;})()`,'readable one-line crew heading');
   for(const name of ['Check all 2 crew in','Check all 2 crew out','Check Previous fixture person in','Check Next fixture person out']){
    let bounds;
    await poll(async()=>{
     bounds=await evaluate(`(async()=>{const node=[...document.querySelectorAll('button')].find(n=>(n.getAttribute('aria-label')||n.textContent.trim())===${JSON.stringify(name)});node.scrollIntoView({block:'center'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height,hit:node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};})()`);
     return bounds.left>=0&&bounds.right<=width&&bounds.top>=0&&bounds.bottom<=900&&bounds.height>=44&&bounds.hit;
    },`settled ${width}px ${name}`).catch(error=>{console.log(JSON.stringify({width,name,bounds}));throw error;});
   }
   if(width===320)await writeFile('/tmp/showpilot-crew-attendance-list-320.png',Buffer.from((await page('Page.captureScreenshot',{format:'png'})).data,'base64'));
  }
  const writes=(await evaluate('window.attendanceWrites')).map(body=>fromJSON(JSON.parse(body)).data);writes.forEach(input=>expectedRequests.add(input.requestId));
  assert.equal(writes.length,6);assert.equal(writes[3].members.length,2,'filtered search does not shrink captured roster');
  assert.equal(await evaluate('window.attendanceDocument'),documentId);assert.deepEqual(await evaluate('window.attendanceErrors'),[]);
  console.log(JSON.stringify({browserPassed:true,readRetryDoesNotWrite:true,bulkConflictAtomic:true,laterOperatorChangesPreserved:true,writeAttempts:writes.length,uniqueRequests:expectedRequests.size,viewports:[320,768,1440]}));
 });
 await stopServer();
 const rows=await queryFixture("SELECT orgId,memberId,isOnline,lastCheckIn,lastCheckOut FROM crew_member ORDER BY orgId,memberId");
 assert.equal(rows.find(row=>row.orgId===orgId&&row.memberId==='TD3917').isOnline,0);
 assert.equal(rows.find(row=>row.orgId===orgId&&row.memberId==='CAM42').isOnline,1);
 assert.equal(rows.find(row=>row.orgId==='display-other').isOnline,0);
 const receipts=await queryFixture(`SELECT key,value FROM app_setting WHERE orgId='${orgId}' AND key LIKE 'attendance-write:%'`);
 assert.deepEqual(receipts.map(row=>row.key.slice('attendance-write:'.length)).sort(),[...expectedRequests].sort());assert.equal(receipts.length,7);
 assert.equal(receipts.filter(row=>JSON.parse(row.value).outcome==='conflict').length,1);
 console.log(JSON.stringify({databasePassed:true,receipts:receipts.length,otherOrgUnchanged:true}));
},{publicCheckInMembers:true,secondOperator:true});
