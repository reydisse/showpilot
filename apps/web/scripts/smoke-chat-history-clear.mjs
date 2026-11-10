// Actual Chat UI + Settings in separate Chrome sessions, with real auth/D1/relays.
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fromJSON } from 'seroval';
import { withLocalSmokeFixture } from './local-smoke-fixture.mjs';
import { poll, withRealBrowser } from './real-browser-fixture.mjs';
let clearId;
for(const file of (await readdir(resolve(import.meta.dirname,'../dist/server/assets'))).filter(f=>f.endsWith('.js'))) {
  const source=await readFile(resolve(import.meta.dirname,'../dist/server/assets',file),'utf8');
  clearId??=source.match(/const clearChatHistory_createServerFn_handler = createServerRpc\(\{\s*id: "([^"]+)"/)?.[1];
}
assert.ok(clearId,'Compiled clear RPC');
await withLocalSmokeFixture(async ({origin,orgId,operatorCookie,stopServer,queryFixture,capturedEmails})=>{
  const headers={Cookie:operatorCookie,Origin:origin,'Content-Type':'application/json'};
  const rooms=['production','planning','dm:smoke-operator:smoke-second-operator'];
  const send=async(room,text)=>{
    const response=await fetch(`${origin}/api/chat/${orgId}/send?room=${encodeURIComponent(room)}`,{method:'POST',headers,body:JSON.stringify({text})});
    assert.equal(response.status,200);assert.equal((await response.json()).ok,true);
  };
  const history=async room=>{
    const response=await fetch(`${origin}/api/chat/${orgId}/history?room=${encodeURIComponent(room)}`,{headers});
    assert.equal(response.status,200);return (await response.json()).messages;
  };
  for(const room of rooms)await send(room,'BEFORE_CLEAR_'+room);
  await withRealBrowser({origin,cookie:operatorCookie},async observer=>{
    await observer.page('Page.enable');await observer.page('Emulation.setFocusEmulationEnabled',{enabled:true});
    await observer.page('Page.addScriptToEvaluateOnNewDocument',{source:`window.observerSockets=[];window.blockChatSocket=false;const OriginalSocket=WebSocket;window.WebSocket=class extends OriginalSocket{constructor(...args){if(window.blockChatSocket&&String(args[0]).includes('/api/chat/'))throw new Error('Fixture offline');super(...args);if(String(args[0]).includes('/api/chat/'))window.observerSockets.push(this);}};`});
    await observer.page('Page.navigate',{url:`${origin}/${orgId}/chat?room=production`});
    const panel="document.querySelector('[data-testid=chat-panel]')";
    await poll(()=>observer.evaluate(`${panel}?.innerText.includes('BEFORE_CLEAR_production')`),'live chat before clear');
    await observer.evaluate("window.observerDocument='same-page'");
    await withRealBrowser({origin,cookie:operatorCookie},async({page,evaluate})=>{
      await page('Page.enable');await page('Emulation.setFocusEmulationEnabled',{enabled:true});
      await page('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
      await page('Page.addScriptToEvaluateOnNewDocument',{source:`
        window.clearErrors=[];window.clearCalls=[];window.holdClear=true;window.clearReplies=[];
        addEventListener('error',e=>window.clearErrors.push(e.message));addEventListener('unhandledrejection',e=>window.clearErrors.push(String(e.reason)));
        const original=fetch;window.fetch=async(input,options)=>{
          const url=input instanceof Request?input.url:String(input);
          const match=url.includes('/_serverFn/${clearId}');if(match)window.clearCalls.push(options.body);
          const response=await original(input,options);
          if(match&&window.holdClear){const body=await response.text();return new Promise(resolve=>window.clearReplies.push(()=>resolve(new Response(body,{status:response.status,headers:response.headers}))));}
          return response;
        };`});
      const check=(expression,label)=>poll(()=>evaluate(expression),label).catch(async error=>{
        console.log(JSON.stringify({label,body:await evaluate('document.body?.innerText'),errors:await evaluate('window.clearErrors')}));throw error;
      });
      const click=async name=>{
        await page('Page.bringToFront');
        const box=await check(`(async()=>{const n=[...document.querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(name)}&&!n.disabled);if(!n)return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`,'clickable '+name);
        await page('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...box});await page('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...box});
      };
      const fill=value=>evaluate(`(()=>{const n=document.querySelector('input[aria-label="Organization name to clear chat"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await page('Page.navigate',{url:`${origin}/${orgId}/settings?section=danger`});
      await check(`!!document.body&&[...document.querySelectorAll('h1')].some(n=>n.textContent==='Danger Zone')`,'Danger Zone');
      await check(`Object.keys(document.querySelector('button')??{}).some(k=>k.startsWith('__reactProps'))`,'hydrated Settings');
      await click('Clear chat history');
      await check(`!!document.querySelector('[role="dialog"] input')`,'typed confirmation');
      await fill('wrong');
      assert.equal(await evaluate(`[...document.querySelectorAll('button')].find(n=>n.textContent==='Permanently clear chat history').disabled`),true);
      assert.equal(await evaluate('window.clearCalls.length'),0);
      for(const width of [320,768,1440]) {
        await page('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
        await check(`document.querySelector('[role="dialog"]').getAnimations({subtree:true}).every(a=>a.playState==='finished')`,'settled dialog');
        const sizes=await evaluate(`[...document.querySelectorAll('[role="dialog"] button,[role="dialog"] input')].map(n=>({w:n.getBoundingClientRect().width,h:n.getBoundingClientRect().height}))`);
        assert.equal(sizes.length,3);assert.ok(sizes.every(n=>n.w>=44&&n.h>=44));
        assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth+1`),true);
        if(width===320)await writeFile('/tmp/showpilot-chat-clear-320.png',Buffer.from((await page('Page.captureScreenshot',{format:'png'})).data,'base64'));
      }
      await click('Cancel');assert.equal(await evaluate('window.clearCalls.length'),0);
      for(const room of rooms)assert.equal((await history(room)).length,1);
      await click('Clear chat history');await fill('Display fixture');await click('Permanently clear chat history');
      await check(`window.clearReplies.length===1`,'real clear reply withheld');
      await poll(()=>observer.evaluate(`${panel}&&!${panel}.innerText.includes('BEFORE_CLEAR_production')`),'live Chat UI clears without reload');
      assert.equal(await observer.evaluate('window.observerDocument'),'same-page');
      for(const room of rooms){assert.deepEqual(await history(room),[]);await send(room,'AFTER_CLEAR_'+room);}
      await poll(()=>observer.evaluate(`${panel}?.innerText.includes('AFTER_CLEAR_production')`),'new live message');
      await check(`[...document.querySelectorAll('button')].some(n=>n.textContent==='Retry clearing chat history')`,'bounded unconfirmed clear');
      await click('Notifications');await check(`[...document.querySelectorAll('h1')].some(n=>n.textContent==='Notifications')`,'navigate away');
      await click('Danger Zone');await check(`[...document.querySelectorAll('button')].some(n=>n.textContent==='Retry clearing chat history')`,'retained exact retry');
      await evaluate('window.holdClear=false');await click('Retry clearing chat history');
      await check(`document.body.textContent.includes('All 3 rooms confirmed')`,'clear receipt recovered');
      const commands=await evaluate('window.clearCalls');assert.equal(commands.length,2);assert.deepEqual(fromJSON(JSON.parse(commands[0])),fromJSON(JSON.parse(commands[1])));
      await evaluate('window.clearReplies.splice(0).forEach(release=>release())');
      for(const room of rooms)assert.deepEqual((await history(room)).map(m=>m.text),['AFTER_CLEAR_'+room]);
      assert.equal(await observer.evaluate(`${panel}.innerText.includes('BEFORE_CLEAR_production')`),false);
      assert.equal(await observer.evaluate(`${panel}.innerText.includes('AFTER_CLEAR_production')`),true);
      // A disconnected web client must learn that its retained history was cleared.
      await observer.evaluate(`window.blockChatSocket=true;window.observerSockets.forEach(socket=>socket.close())`);
      await poll(()=>observer.evaluate(`window.observerSockets.every(socket=>socket.readyState===WebSocket.CLOSED)`),'observer offline');
      await click('Clear chat history');await fill('Display fixture');await click('Permanently clear chat history');
      await check(`window.clearCalls.length===3&&document.body.textContent.includes('All 3 rooms confirmed')`,'second clear acknowledged');
      for(const room of rooms){assert.deepEqual(await history(room),[]);await send(room,'AFTER_OFFLINE_CLEAR_'+room);}
      await observer.evaluate('window.blockChatSocket=false');
      await poll(()=>observer.evaluate(`${panel}?.innerText.includes('AFTER_OFFLINE_CLEAR_production')&&!${panel}?.innerText.includes('AFTER_CLEAR_production')`),'offline clear replaces retained history on reconnect');
      assert.equal(await observer.evaluate('window.observerDocument'),'same-page');
      assert.deepEqual(await evaluate('window.clearErrors'),[]);
    });
  });
  await stopServer();
  const receipts=await queryFixture(`SELECT requestId,rooms FROM chat_history_clear_receipt WHERE orgId='${orgId}'`);
  assert.equal(receipts.length,2);assert.equal(JSON.parse(receipts[0].rooms).length,3);
  assert.deepEqual(await queryFixture("SELECT requestId FROM chat_history_clear_receipt WHERE orgId='display-other'"),[]);
  assert.equal((await capturedEmails()).length,0);
  console.log(JSON.stringify({passed:true,rooms:3,typedName:true,noClearOnCancel:true,liveChatCleared:true,newMessagesKept:true,exactRetryAcrossNavigation:true,widths:[320,768,1440],receipts:2,offlineClearRecovery:true,externalEmail:0}));
},{secondOperator:true,captureEmail:true});
