// Real authenticated organization deletion, withheld acknowledgement and safe retry.
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fromJSON } from 'seroval';
import { withLocalSmokeFixture } from './local-smoke-fixture.mjs';
import { poll, withRealBrowser } from './real-browser-fixture.mjs';
let deleteId;
const assets=resolve(import.meta.dirname,'../dist/server/assets');
for(const file of(await readdir(assets)).filter(file=>file.endsWith('.js'))){
  const source=await readFile(resolve(assets,file),'utf8');
  deleteId??=source.match(/const deleteOrganization_createServerFn_handler = createServerRpc\(\{\s*id: "([^"]+)"/)?.[1];
}
assert.ok(deleteId);
for(const entry of ["settings","account"]) await withLocalSmokeFixture(async({origin,orgId,operatorCookie,stopServer,queryFixture,capturedEmails})=>{
  const headers={Cookie:operatorCookie,Origin:origin,'Content-Type':'application/json'};
  const seed=await fetch(`${origin}/api/chat/${orgId}/send?room=production`,{method:'POST',headers,body:JSON.stringify({text:'Disposable organization history'})});
  assert.equal(seed.status,200);assert.equal((await seed.json()).ok,true);
  await withRealBrowser({origin,cookie:operatorCookie},async({page,evaluate})=>{
    await page('Page.enable');await page('Emulation.setFocusEmulationEnabled',{enabled:true});
    await page('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await page('Page.addScriptToEvaluateOnNewDocument',{source:`
      window.deleteCalls=JSON.parse(sessionStorage.getItem('fixture-delete-calls')||'[]');window.deleteErrors=[];window.holdDelete=true;window.deleteReplies=[];
      addEventListener('error',e=>window.deleteErrors.push(e.message));addEventListener('unhandledrejection',e=>window.deleteErrors.push(String(e.reason)));
      const original=fetch;window.fetch=async(input,options)=>{
        const url=input instanceof Request?input.url:String(input),match=url.includes('/_serverFn/${deleteId}');
        if(match){window.deleteCalls.push(options.body);sessionStorage.setItem('fixture-delete-calls',JSON.stringify(window.deleteCalls));}
        const response=await original(input,options);
        if(match&&window.holdDelete){const body=await response.text();return new Promise(resolve=>window.deleteReplies.push(()=>resolve(new Response(body,{status:response.status,headers:response.headers}))));}
        return response;
      };`});
    const check=(expression,label)=>poll(()=>evaluate(expression),label).catch(async error=>{
      console.log(JSON.stringify({label,body:await evaluate('document.body?.innerText'),errors:await evaluate('window.deleteErrors')}));throw error;
    });
    const click=async name=>{
      const box=await check(`(async()=>{const n=[...document.querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(name)}&&!n.disabled);if(!n)return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`,'clickable '+name);
      await page('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...box});await page('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...box});
    };
    const fill=value=>evaluate(`(()=>{const n=document.querySelector('input[aria-label="Organization name to delete organization"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await page('Page.navigate',{url:entry==='settings'?`${origin}/${orgId}/settings?section=danger`:`${origin}/delete-account`});
    await check(`!!document.body&&[...document.querySelectorAll('h1')].some(n=>n.textContent===${JSON.stringify(entry==='settings'?'Danger Zone':'Delete your account')})`,'deletion entry page');
    await check(`Object.keys(document.querySelector('button')??{}).some(k=>k.startsWith('__reactProps'))`,'hydration');
    await click('Delete organization');await check(`!!document.querySelector('[role="dialog"] input')`,'typed confirmation');
    await fill('wrong');assert.equal(await evaluate(`[...document.querySelectorAll('button')].find(n=>n.textContent==='Permanently delete organization').disabled`),true);
    for(const width of [320,768,1440]){
      await page('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
      await check(`document.querySelector('[role="dialog"]').getAnimations({subtree:true}).every(a=>a.playState==='finished')`,'settled dialog');
      assert.equal(await evaluate(`(()=>{const d=document.querySelector('[role="dialog"]'),r=d.getBoundingClientRect();return d.scrollWidth<=d.clientWidth+1&&[...d.querySelectorAll('button,input')].every(n=>{const b=n.getBoundingClientRect();return b.width>=44&&b.height>=44&&b.x>=r.x&&b.right<=r.right;});})()`),true);
      assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),true);
      if(width===320)await writeFile('/tmp/showpilot-org-delete-320.png',Buffer.from((await page('Page.captureScreenshot',{format:'png'})).data,'base64'));
    }
    await click('Cancel');assert.equal(await evaluate('window.deleteCalls.length'),0);
    await click('Delete organization');await fill('Display fixture');await click('Permanently delete organization');
    await check('window.deleteReplies.length===1','real deletion reply withheld');
    await check(`[...document.querySelectorAll('button')].some(n=>n.textContent==='Retry organization deletion')`,'bounded deletion and retry');
    assert.equal(await evaluate(`location.pathname.endsWith(${JSON.stringify(entry==='settings'?'/settings':'/delete-account')})`),true);
    assert.deepEqual(await evaluate('window.deleteErrors'),[]);
    const session=await fetch(`${origin}/api/auth/get-session?disableCookieCache=true`,{headers});
    assert.equal((await session.json()).user.id,'smoke-operator','Account session must remain valid for recovery');
    await evaluate('window.holdDelete=false');await click('Retry organization deletion');
    if(entry==='settings')await check(`location.pathname==='/org-deleted'&&document.body?.textContent.includes('Your account and other organizations are kept.')`,'confirmed deletion page');
    else await check(`location.pathname==='/delete-account'&&!!document.querySelector('input[type="password"]')&&!document.body.textContent.includes('Transfer ownership to a team member')`,'account deletion can continue after workspace removal');
    const calls=(await evaluate('window.deleteCalls')).map(body=>fromJSON(JSON.parse(body)));
    assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1]);
  });
  await stopServer();
  assert.deepEqual(await queryFixture(`SELECT id FROM organization WHERE id='${orgId}'`),[]);
  assert.deepEqual(await queryFixture(`SELECT id FROM member WHERE organizationId='${orgId}'`),[]);
  assert.deepEqual(await queryFixture(`SELECT id FROM graphic_template WHERE orgId='${orgId}'`),[]);
  assert.deepEqual(await queryFixture(`SELECT id FROM app_setting WHERE orgId='${orgId}'`),[]);
  assert.equal((await queryFixture("SELECT id FROM organization WHERE id='display-other'")).length,1);
  assert.equal((await queryFixture("SELECT id FROM user WHERE id='smoke-operator'")).length,1);
  assert.equal((await capturedEmails()).length,0);
  console.log(JSON.stringify({passed:true,entry,typedName:true,cancelSendsNothing:true,lostReplyRecovered:true,exactRetry:true,accountKept:true,otherOrgKept:true,widths:[320,768,1440],externalEmail:0}));
},{captureEmail:true});
