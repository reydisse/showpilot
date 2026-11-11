// Real auth/D1/compiled UI; mail is intercepted by the disposable fixture.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile,readdir,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { withLocalSmokeFixture } from './local-smoke-fixture.mjs';
import { poll,withRealBrowser } from './real-browser-fixture.mjs';
const require=createRequire(new URL('../package.json',import.meta.url));
const router=createRequire(require.resolve('@tanstack/react-router')),core=createRequire(router.resolve('@tanstack/router-core'));
const {toJSONAsync,fromJSON,fromCrossJSON}=core('seroval');const {defaultSerovalPlugins}=router('@tanstack/router-core');
const ids={},names=['createNextService','getScheduleAssignment','changeScheduleAssignment','copyScheduleTeam'];
const assets=resolve(import.meta.dirname,'../dist/server/assets');
for(const file of(await readdir(assets)).filter(file=>file.endsWith('.js'))){const source=await readFile(resolve(assets,file),'utf8');for(const name of names)ids[name]??=source.match(new RegExp(`const ${name}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`))?.[1];}
assert.ok(names.every(name=>ids[name]));
await withLocalSmokeFixture(async({origin,orgId,operatorCookie,configureEmail,capturedEmails,queryFixture})=>{
  async function rpc(name,data){
    const payload=JSON.stringify(await toJSONAsync({data:{orgId,...data}})),url=`${origin}/_serverFn/${ids[name]}`;
    const headers={Cookie:operatorCookie,Origin:origin,'Sec-Fetch-Site':'same-origin','x-tsr-serverFn':'true','Content-Type':'application/json'};
    const response=await fetch(name==='getScheduleAssignment'?`${url}?payload=${encodeURIComponent(payload)}`:url,name==='getScheduleAssignment'?{headers}:{method:'POST',headers,body:payload});
    assert.equal(response.status,200);const reply=fromCrossJSON(await response.json(),{refs:new Map(),plugins:defaultSerovalPlugins});assert.equal(reply.error,undefined);assert.equal(reply instanceof Error,false);return reply.result;
  }
  const actor=await rpc('getScheduleAssignment',{id:'assignment-accept'});
  const target=await rpc('createNextService',{serviceDate:'2099-01-08',name:'Copy recovery target'});
  const showId=target.showId;assert.ok(showId);assert.match(showId,/^[A-Za-z0-9_-]+$/);
  await configureEmail('partial-schedule');
  await withRealBrowser({origin,cookie:operatorCookie},async({page,evaluate})=>{
    await page('Page.enable');await page('Emulation.setFocusEmulationEnabled',{enabled:true});await page('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await page('Page.addScriptToEvaluateOnNewDocument',{source:`
      window.copyCalls=[];window.copyHeld=[];window.copyErrors=[];window.holdCopy=true;window.copyDocument='same';
      addEventListener('error',e=>copyErrors.push(e.message));addEventListener('unhandledrejection',e=>copyErrors.push(String(e.reason)));
      const original=fetch;window.fetch=async(input,options)=>{
        const url=input instanceof Request?input.url:String(input);if(!url.includes('/_serverFn/${ids.copyScheduleTeam}'))return original(input,options);
        copyCalls.push(options.body);const hold=holdCopy;const response=await original(input,hold?{...options,signal:new AbortController().signal}:options);
        if(!hold)return response;const bytes=await response.arrayBuffer();return new Promise(resolve=>copyHeld.push(()=>resolve(new Response(bytes,{status:response.status,headers:response.headers}))));
      };`});
    const check=(expression,description)=>poll(()=>evaluate(expression),description).catch(async error=>{console.log(JSON.stringify({description,body:await evaluate('document.body.innerText'),errors:await evaluate('copyErrors')}));throw error;});
    const button=name=>`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(name)}&&!b.disabled&&b.getBoundingClientRect().width>0)`;
    const click=async expression=>{const point=await check(`(async()=>{const n=${expression};if(!n||!Object.keys(n).some(k=>k.startsWith('__reactProps')))return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`,'reachable '+expression);for(const type of ['mousePressed','mouseReleased'])await page('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point});};
    await page('Page.navigate',{url:`${origin}/${orgId}/schedule?date=2099-01-08&show=${showId}&month=2099-01`});
    await click(button('Copy team'));await check('copyHeld.length===1','copy completed with reply held');
    const initialEmails=await capturedEmails();assert.equal(initialEmails.length,3);
    const uncertain=initialEmails.find(email=>email.to==='other@display-smoke.invalid');assert.ok(uncertain?.delivered);
    assert.equal((await queryFixture(`SELECT id FROM service_assignment WHERE orgId='display-smoke' AND showId='${showId}'`)).length,3);
    await rpc('changeScheduleAssignment',{userId:actor.userId,requestId:crypto.randomUUID(),operation:{kind:'create',fields:{showId:'assignment-show',serviceDate:'2099-01-01',role:'Added after copy',department:'Production',crewMemberId:null,callTime:'',timeZone:'UTC',notes:''}}});
    await click(`document.querySelector('a[href="/${orgId}/songs"]')`);await check("location.pathname.endsWith('/songs')",'leave copy');await evaluate('history.back()');
    await check("location.pathname.endsWith('/schedule')",'return to original target');await check(`!!${button('Retry team copy')}`,'copy deadline retained across navigation');
    for(const [width,height]of [[320,480],[768,1024],[1440,1000]]){
      await page('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      const layout=await check(`(async()=>{await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const n=${button('Retry team copy')};if(!n)return null;n.scrollIntoView({block:'center'});const b=n.getBoundingClientRect();const sidebar=document.querySelector('aside[aria-hidden=true]');if(b.left<0||b.right>innerWidth||b.top<0||b.bottom>innerHeight||(sidebar&&sidebar.getBoundingClientRect().right>0)||!n.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)))return null;return {height:b.height}})()`,'reachable copy retry at '+width);assert.ok(layout.height>=44);
      await writeFile(`/tmp/showpilot-copy-${width}.png`,Buffer.from((await page('Page.captureScreenshot',{format:'png'})).data,'base64'));
    }
    await evaluate('holdCopy=false;copyHeld.splice(0).forEach(release=>release());true');await click(button('Retry team copy'));
    await check("document.body.innerText.includes('3 positions copied')&&!document.body.innerText.includes('Team copy was not confirmed')",'copy recovered');
    const calls=(await evaluate('copyCalls')).map(body=>fromJSON(JSON.parse(body)).data);assert.deepEqual(calls[1],calls[0]);
    const emails=await capturedEmails();assert.equal(emails.length,4);assert.equal(emails[3].replayed,true);assert.equal(emails[3].idempotencyKey,uncertain.idempotencyKey);
    const rows=await queryFixture(`SELECT id,role FROM service_assignment WHERE orgId='display-smoke' AND showId='${showId}' ORDER BY role`);assert.equal(rows.length,3);assert.ok(rows.every(row=>row.role!=='Added after copy'));
    const saved=(await rpc('getScheduleAssignment',{id:rows[0].id})).snapshot;
    await rpc('changeScheduleAssignment',{userId:actor.userId,requestId:crypto.randomUUID(),operation:{kind:'edit',id:saved.id,expectedRevision:saved.revision,fields:{showId,serviceDate:'2099-01-08',role:saved.role,department:saved.department,crewMemberId:saved.crewMemberId,callTime:saved.callTime,timeZone:'UTC',notes:'Newer target edit'}}});
    const replay=await rpc('copyScheduleTeam',calls[0]);assert.equal(replay.copied,3);assert.equal(replay.items.find(item=>item.id===saved.id).changed,true);
    assert.equal((await rpc('getScheduleAssignment',{id:saved.id})).snapshot.notes,'Newer target edit');
    assert.equal((await capturedEmails()).length,4);assert.deepEqual(await evaluate('copyErrors'),[]);assert.equal(await evaluate('copyDocument'),'same');
    console.log(JSON.stringify({frozenOriginalRoster:true,retainedAcrossNavigation:true,exactRetry:true,targetChangesPreserved:true,acceptedInvitationsNotRepeated:true,copied:3,capturedEmailAttempts:4,distinctAcceptedEmails:3,viewports:[320,768,1440],errors:[]}));
  });
},{personalAssignments:true,captureEmail:true});
