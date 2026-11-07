// Authenticated built-app rehearsal. All data lives in the disposable fixture.
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { withLocalSmokeFixture } from './local-smoke-fixture.mjs';
import { poll, withRealBrowser } from './real-browser-fixture.mjs';
const names=['getChecklistEntries','getSmartChecklistDraft','mutateChecklist'];
const ids={}; const assets=resolve(import.meta.dirname,'../dist/server/assets');
for(const file of (await readdir(assets)).filter(file=>file.endsWith('.js'))){
  const source=await readFile(resolve(assets,file),'utf8');
  for(const name of names) ids[name]??=source.match(new RegExp(`const ${name}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`))?.[1];
}
assert.ok(names.every(name=>ids[name]),'Resolve checklist RPCs from the tested build');
await withLocalSmokeFixture(async({origin,orgId,operatorCookie,stopServer,startServer,serverState,queryFixture})=>{
  await withRealBrowser({origin,cookie:operatorCookie},async({page,evaluate})=>{
    await page('Page.enable');
    await page('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await page('Page.addScriptToEvaluateOnNewDocument',{source:`
      window.checklistDocument=crypto.randomUUID();window.checklistErrors=[];
      addEventListener('error',event=>window.checklistErrors.push(event.message));addEventListener('unhandledrejection',event=>window.checklistErrors.push(String(event.reason)));
      const ids=${JSON.stringify(ids)};window.checklistModes={};window.checklistCalls={};window.checklistHeld=[];window.checklistWrites=[];
      const original=window.fetch;window.checklistOriginal=original;
      window.fetch=(input,init)=>{
        const url=input instanceof Request?input.url:String(input);const name=Object.keys(ids).find(name=>url.includes('/_serverFn/'+ids[name]));
        if(!name)return original(input,init);
        window.checklistCalls[name]=(window.checklistCalls[name]??0)+1;
        if(name==='mutateChecklist')window.checklistWrites.push({input,init});
        // Consume the real response before withholding it. An independent transport
        // lets the app abort its observation without interrupting Wrangler's stream.
        const response=original(input,{...init,signal:new AbortController().signal}).then(async response=>new Response(await response.arrayBuffer(),{status:response.status,headers:response.headers}));
        if(window.checklistModes[name]==='hold')return new Promise(resolve=>window.checklistHeld.push({name,signal:init?.signal,release:async()=>resolve(await response)}));
        return response;
      };`});
    const click=async name=>{
      let point;
      await poll(async()=>{
        point=await evaluate(`(async()=>{const button=[...document.querySelectorAll('button')].find(node=>(node.getAttribute('aria-label')===${JSON.stringify(name)}||node.textContent.trim()===${JSON.stringify(name)})&&node.getBoundingClientRect().width>0&&node.closest('[role="dialog"]')?.dataset.state!=='closed');if(!button||button.disabled)return null;button.scrollIntoView({block:'center'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const r=button.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return button.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`);
        return !!point;
      },`reachable ${name}`);
      await page('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
      await page('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
    };
    const fill=(selector,value)=>evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
    const mode=(name,value)=>evaluate(`window.checklistModes[${JSON.stringify(name)}]=${JSON.stringify(value)};true`);
    const release=name=>evaluate(`Promise.all(window.checklistHeld.filter(item=>item.name===${JSON.stringify(name)}).map(item=>item.release())).then(()=>true)`);
    let proxyRestarts=0;
    const observe=async(check,label,timeout)=>{
      try { return await poll(check,label,timeout); }
      catch(error) {
        const state=serverState();
        console.log(JSON.stringify({observation:label,server:state,ui:await evaluate(`({calls:window.checklistCalls,errors:window.checklistErrors,alerts:[...document.querySelectorAll('[role="alert"]')].map(node=>node.textContent),buttons:[...document.querySelectorAll('main button')].map(node=>({name:node.getAttribute('aria-label')||node.textContent,disabled:node.disabled}))})`)}));
        if((state.exitCode===null&&state.signalCode===null)||proxyRestarts>=1)throw error;
        // Recover only a confirmed terminal local proxy process, never a running
        // server or an application observation timeout. Keep the same document.
        proxyRestarts++;await startServer();
        const retry=await evaluate(`['Retry checklist save','Retry checklist'].find(label=>[...document.querySelectorAll('button')].some(node=>node.getAttribute('aria-label')===label&&!node.disabled&&node.getBoundingClientRect().width>0))`);
        if(!retry)throw error;await click(retry);return poll(check,label,timeout);
      }
    };
    const failed=label=>observe(()=>evaluate(`!![...document.querySelectorAll('[role="alert"]')].find(node=>node.getAttribute('aria-label')===${JSON.stringify(label)}&&node.querySelector('time')&&node.getBoundingClientRect().width>0)`),label,14_000);
    const waitRow=label=>observe(()=>evaluate(`!!document.querySelector('button[aria-label=${JSON.stringify(label)}]')&&!document.querySelector('button[aria-label=${JSON.stringify(label)}]').disabled`),label);
    await page('Page.navigate',{url:`${origin}/${orgId}/production/checklist`});
    await observe(()=>evaluate(`window.checklistCalls.getChecklistEntries>=1&&!!document.querySelector('button[aria-label="Generate checklist from rundown"]')&&!document.querySelector('button[aria-label="Generate checklist from rundown"]').disabled`),'initial checklist');
    const documentId=await evaluate('window.checklistDocument');
    // A real add succeeds even if its subsequent list read stalls.
    await mode('getChecklistEntries','hold');await fill('#checklist-new-label','Fixture camera');await waitRow('Add checklist item');await click('Add checklist item');
    await failed('Retry checklist');assert.equal(await evaluate(`document.querySelector('#checklist-new-label').value`),'');
    assert.equal(await evaluate(`document.body.textContent.includes('Change saved.')`),true);
    await mode('getChecklistEntries','normal');await click('Retry checklist');await waitRow('Mark complete: Fixture camera');await release('getChecklistEntries');
    assert.equal(await evaluate('window.checklistCalls.mutateChecklist'),1);console.log('Acknowledged add and read-only recovery passed');
    // Lose the actual toggle acknowledgement, then retry exactly that write.
    await mode('mutateChecklist','hold');await click('Mark complete: Fixture camera');await failed('Retry checklist save');
    assert.equal(await evaluate(`!!document.querySelector('button[aria-label="Mark complete: Fixture camera"]')`),true);
    await release('mutateChecklist');assert.equal(await evaluate(`!!document.querySelector('button[aria-label="Retry checklist save"]')`),true,'late success is not an acknowledgement');
    await mode('mutateChecklist','normal');await click('Retry checklist save');await waitRow('Mark incomplete: Fixture camera');
    assert.equal(await evaluate('window.checklistWrites[1].init.body===window.checklistWrites[2].init.body'),true);console.log('Toggle response loss and exact retry passed');
    // A category is not presented as confirmed until its write is acknowledged.
    await mode('mutateChecklist','hold');
    await evaluate(`const node=[...document.querySelectorAll('select')].find(node=>node.id.startsWith('cat-'));node.value='video';node.dispatchEvent(new Event('change',{bubbles:true}));true`);
    await failed('Retry checklist save');assert.equal(await evaluate(`document.querySelector('select[id^="cat-"]').value`),'general');
    await mode('mutateChecklist','normal');await click('Retry checklist save');await waitRow('Mark incomplete: Fixture camera');
    assert.equal(await evaluate(`document.querySelector('select[id^="cat-"]').value`),'video');await release('mutateChecklist');
    // Cancel has no write; confirmed removal survives its own retry and an old add.
    const beforeCancel=await evaluate('window.checklistCalls.mutateChecklist');await click('Remove Fixture camera from this service');await click('Cancel');assert.equal(await evaluate('window.checklistCalls.mutateChecklist'),beforeCancel);
    await mode('mutateChecklist','hold');await click('Remove Fixture camera from this service');await click('Remove');await failed('Retry checklist save');
    await mode('mutateChecklist','normal');await click('Retry checklist save');
    await observe(()=>evaluate(`!document.querySelector('button[aria-label="Mark incomplete: Fixture camera"]')&&!document.querySelector('button[aria-label="Retry checklist save"]')`),'removed item');await release('mutateChecklist');
    assert.equal(await evaluate(`(async()=>{const saved=window.checklistWrites[0];const response=await window.checklistOriginal(saved.input,{...saved.init,signal:new AbortController().signal});const text=await response.text();return response.ok&&text.includes('applied');})()`),true,'old add receives its original acknowledgement');
    await evaluate(`document.dispatchEvent(new Event('visibilitychange'));true`);
    await observe(()=>evaluate(`!document.querySelector('button[aria-label="Generate checklist from rundown"]').disabled`),'old add receipt acknowledged');
    assert.equal(await evaluate(`document.body.textContent.includes('Fixture camera')`),false);
    // Suggestion reads have their own deadline. Retry is read-only.
    await mode('getSmartChecklistDraft','hold');await click('Generate checklist from rundown');await failed('Retry checklist suggestions');
    assert.equal(await evaluate(`document.querySelector('[role="dialog"]').textContent.includes('No new checks found')`),false);
    await mode('getSmartChecklistDraft','normal');await click('Retry checklist suggestions');
    await observe(()=>evaluate(`document.querySelectorAll('[role="dialog"] input[type="checkbox"]').length>0`),'review suggestions');await release('getSmartChecklistDraft');
    await click('Clear all');await evaluate(`document.querySelector('[role="dialog"] input[type="checkbox"]').click();true`);
    await mode('mutateChecklist','hold');await click('Add 1 checks');await failed('Retry checklist save');
    await mode('mutateChecklist','normal');await click('Retry checklist save');
    await observe(()=>evaluate(`!document.querySelector('[role="dialog"]')&&!!document.querySelector('button[aria-label^="Mark complete:"]')&&!document.querySelector('button[aria-label^="Mark complete:"]').disabled`),'draft committed once');await release('mutateChecklist');
    // Pending input gets a navigation warning and remains when Stay is chosen.
    await fill('#checklist-new-label','Unsaved fixture draft');
    await evaluate(`document.querySelector('a[href="/${orgId}/production/incidents"]').click();true`);
    await observe(()=>evaluate(`document.querySelector('[role="dialog"]')?.textContent.includes('Leave this checklist?')`),'navigation warning');await click('Stay');
    assert.equal(await evaluate(`document.querySelector('#checklist-new-label').value`),'Unsaved fixture draft');await fill('#checklist-new-label','');
    // New-show loading must not show previous checks or a false empty state.
    await mode('getChecklistEntries','hold');await click('Choose show');
    await observe(()=>evaluate(`!![...document.querySelectorAll('[role="menuitem"]')].find(node=>node.textContent.includes('Evening test show'))`),'show menu opens');
    await evaluate(`const item=[...document.querySelectorAll('[role="menuitem"]')].find(node=>node.textContent.includes('Evening test show'));if(!item)throw Error('Missing fixture show');item.click();true`);
    await failed('Retry checklist');assert.equal(await evaluate(`!!document.querySelector('button[aria-label^="Mark complete:"]')||document.body.textContent.includes('No checklist items for this date')||document.body.textContent.includes('Loading checklist...')`),false);
    for(const width of [320,768,1440]){
      await page('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
      await observe(()=>evaluate(width<1024?`!!document.querySelector('button[aria-label="Open menu"]')`:`!document.querySelector('button[aria-label="Open menu"]')`),'responsive layout');
      await evaluate(`document.querySelector('button[aria-label="Retry checklist"]').scrollIntoView({block:'center'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))`);
      const bounds=await evaluate(`(()=>{const node=document.querySelector('button[aria-label="Retry checklist"]'),r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height,hit:node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};})()`);
      assert.ok(bounds.left>=0&&bounds.right<=width&&bounds.top>=0&&bounds.bottom<=900&&bounds.height>=44&&bounds.hit,JSON.stringify({width,bounds}));
      if(width===320){const shot=await page('Page.captureScreenshot',{format:'png'});await writeFile('/tmp/showpilot-checklist-recovery-320.png',Buffer.from(shot.data,'base64'));}
    }
    await mode('getChecklistEntries','normal');await click('Retry checklist');
    await observe(()=>evaluate(`document.body.textContent.includes('No checklist items for this date')&&!document.querySelector('button[aria-label="Retry checklist"]')`),'confirmed empty second show');await release('getChecklistEntries');
    await click('Choose show');
    await observe(()=>evaluate(`!![...document.querySelectorAll('[role="menuitem"]')].find(node=>node.textContent.includes('Display test show'))`),'return show menu');
    await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(node=>node.textContent.includes('Display test show')).click();true`);
    await observe(()=>evaluate(`!!document.querySelector('button[aria-label^="Mark complete:"]')&&!document.querySelector('button[aria-label^="Mark complete:"]').disabled`),'return to saved checklist');
    for(const width of [320,768,1440]){
      await page('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
      await observe(()=>evaluate(width<1024?`!!document.querySelector('button[aria-label="Open menu"]')`:`!document.querySelector('button[aria-label="Open menu"]')`),'item layout');
      const controls=['button[aria-label^="Mark complete:"]','button[aria-label^="Remove "]','select[id^="cat-"]','#checklist-new-label','#new-category','button[aria-label="Add checklist item"]'];
      for(const selector of controls){
        const bounds=await evaluate(`(async()=>{const node=document.querySelector(${JSON.stringify(selector)});node.scrollIntoView({block:'center'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height,opacity:getComputedStyle(node).opacity,hit:node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};})()`);
        assert.ok(bounds.left>=0&&bounds.right<=width&&bounds.height>=44&&(selector==='button[aria-label="Add checklist item"]'||bounds.opacity==='1')&&bounds.hit,JSON.stringify({width,selector,bounds}));
      }
      if(width===320){await evaluate(`document.querySelector('button[aria-label^="Mark complete:"]').scrollIntoView({block:'center'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))`);const shot=await page('Page.captureScreenshot',{format:'png'});await writeFile('/tmp/showpilot-checklist-items-320.png',Buffer.from(shot.data,'base64'));}
    }
    assert.equal(await evaluate('window.checklistDocument'),documentId);assert.deepEqual(await evaluate('window.checklistErrors'),[]);
    console.log(JSON.stringify({passed:true,fixtureProxyRestarts:proxyRestarts,lostWriteResponses:['toggle','category','delete','draft'],readRetryDoesNotWrite:true,oldAddCannotRecreate:true,draftNavigationWarning:true,showIsolation:true,retryWidths:[320,768,1440]}));
  });
  await stopServer();
  const entries=await queryFixture(`SELECT e.showId,t.label,e.revision,e.checked FROM checklist_entry e JOIN checklist_template t ON e.templateId=t.id WHERE e.orgId='${orgId}'`);
  assert.equal(entries.length,1);assert.equal(entries[0].showId,'smoke-show');assert.notEqual(entries[0].label,'Fixture camera');assert.equal(entries[0].revision,0);
  const receipts=await queryFixture(`SELECT key FROM app_setting WHERE orgId='${orgId}' AND key LIKE 'checklist-write:%'`);
  assert.equal(receipts.length,5);console.log(JSON.stringify({persistedEntries:entries.length,distinctWriteReceipts:receipts.length}));
},{secondShow:true});
