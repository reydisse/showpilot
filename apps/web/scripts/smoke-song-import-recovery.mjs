// Built browser and Worker through a real BridgeRelay, with a simulated ProPresenter peer.
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { once } from "node:events";
import { createBridgeSettingsRecipient } from "../../../packages/shared/src/bridge-settings.mjs";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";
const { WebSocket }=createRequire(new URL("../../bridge/package.json",import.meta.url))("ws");
let importId;
for(const name of (await readdir(resolve(import.meta.dirname,"../dist/server/assets"))).filter(n=>n.endsWith(".js"))) {
  const source=await readFile(resolve(import.meta.dirname,"../dist/server/assets",name),"utf8");
  importId ??= source.match(/const importProPresenterSong_createServerFn_handler = createServerRpc\(\{\s*id: "([^"]+)"/)?.[1];
}
assert.ok(importId);
await withLocalSmokeFixture(async ({origin,orgId,operatorCookie,stopServer,queryFixture})=>{
  let bridge,reads=0,listReads=0;
  let lyrics="Original first\nOriginal second";
  try {
  await withRealBrowser({origin,cookie:operatorCookie},async({page,evaluate})=>{
    await page("Emulation.setFocusEmulationEnabled",{enabled:true});await page("Page.enable");
    await page("Page.addScriptToEvaluateOnNewDocument",{source:`window.songErrors=[];window.importHold=false;window.importRequests=[];window.importReplies=[];window.holdTimeline=false;window.heldTimeline=0;
      const NativeSocket=window.WebSocket;window.WebSocket=class extends NativeSocket {set onmessage(handler){super.onmessage=event=>{let message;try{message=JSON.parse(event.data);}catch{}if(this.url.includes('/api/timecode/')&&window.holdTimeline&&['events-update','hydrate'].includes(message?.type)&&message.events?.length){window.heldTimeline++;return;}handler?.call(this,event);};}get onmessage(){return super.onmessage;}};
      addEventListener('error',e=>window.songErrors.push(e.message));addEventListener('unhandledrejection',e=>window.songErrors.push(String(e.reason)));
      const original=window.fetch;window.fetch=(input,options)=>{const url=input instanceof Request?input.url:String(input);if(!url.includes(${JSON.stringify(importId)}))return original(input,options);window.importRequests.push(options?.body);const hold=window.importHold;const reply=original(input,options);return hold?reply.then(async r=>{await r.text();window.importReplies.push(r.status);return new Promise(()=>{});}):reply;};`});
    const check = (code, label) => poll(() => evaluate(code),label).catch(async error=>{
      console.log(JSON.stringify({label,body:await evaluate("document.body?.innerText"),errors:await evaluate("window.songErrors"),form:await evaluate("[...document.querySelectorAll('input')].filter(n=>['Main room OBS','192.168.1.20','4455'].includes(n.placeholder)).map(n=>({placeholder:n.placeholder,value:n.value,valid:n.validity.valid,message:n.validationMessage}))")}));
      await writeFile("/tmp/showpilot-song-import-recovery-failure.png",Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));throw error;
    });
    const button = name => `[...(document.querySelector('[role=dialog]')??document).querySelectorAll('button,a')].find(n=>(n.textContent.trim()===${JSON.stringify(name)}||n.getAttribute('aria-label')===${JSON.stringify(name)})&&n.getBoundingClientRect().height>0&&!n.disabled)`;
    const field = label => `[...document.querySelectorAll('label')].find(n=>[...n.childNodes].filter(c=>c.nodeType===Node.TEXT_NODE).map(c=>c.textContent).join('').trim()===${JSON.stringify(label)})?.querySelector('input,textarea')`;
    const click = async name => {
      const p=await check(`(async()=>{const n=${button(name)};if(!n||!Object.keys(n).some(k=>k.startsWith('__reactProps')))return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`,name);
      await page("Input.dispatchMouseEvent",{type:"mousePressed",...p,button:"left",clickCount:1});
      await page("Input.dispatchMouseEvent",{type:"mouseReleased",...p,button:"left",clickCount:1});
    };
    const fill = async (expression,value) => {
      await check(`!!(${expression})&&Object.keys(${expression}).some(k=>k.startsWith('__reactProps'))`,"hydrated field");
      await evaluate(`(()=>{const n=${expression};Object.getOwnPropertyDescriptor(n instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    };
    await page("Emulation.setDeviceMetricsOverride",{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await page("Page.navigate",{url:`${origin}/${orgId}/settings?section=api`});
    await fill("document.querySelector('input[placeholder=\"Main room computer\"]')","Import fixture peer");
    await click("Create key");
    const key=await check("[...document.querySelectorAll('code')].map(n=>n.textContent).find(v=>/^sp_[a-f0-9]{64}$/.test(v))","fixture key created");
    await click("Dismiss key");
    await fill(field("Destination name"),"Import fixture destination");await fill(field("Host or IP address"),"127.0.0.1");await fill(field("Port"),"1025");
    await evaluate("(()=>{const n=[...document.querySelectorAll('label')].find(n=>n.textContent.startsWith('Protocol')).querySelector('select');n.value='propresenter';n.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await check(`(${field("Destination name")})?.value==='Import fixture destination'&&(${field("Host or IP address")})?.value==='127.0.0.1'&&(${field("Port")})?.value==='1025'`,"approval fields retained");
    await click("Approve destination");await check("!!document.querySelector('[aria-label=\"Remove approval for Import fixture destination\"]')","destination approved");
    const recipient=await createBridgeSettingsRecipient();
    bridge=new WebSocket(`${origin.replace('http:','ws:')}/api/bridge/${orgId}/ws?role=bridge`,{headers:{"x-showpilot-api-key":key,"x-showpilot-bridge-policy":"3","x-showpilot-settings-key":recipient.publicKey}});
    bridge.on('message',data=>{
      const message=JSON.parse(String(data));
      const send=value=>bridge.send(JSON.stringify(value));
      if(message.type==='bridge-role') {send({type:'bridge-role-applied',role:message.role,selectionId:message.selectionId});send({type:'bridge-status',version:'0.1.11',devices:1,uptime:1,targets:['propresenter:127.0.0.1:1025']});}
      if(message.type==='bridge-policy')send({type:'bridge-policy-applied',policyId:message.policyId});
      if(message.type==='command') {
        const command=JSON.parse(message.command);let response;
        if(command.action==='query-presentations') {
          listReads++;
          response={presentations:[{uuid:'fixture-presentation',name:'Imported fixture'}],libraries:{total:2,read:command.libraryIds?1:1,failed:command.libraryIds?[]:[{id:'unread-library',name:'Unread fixture library',error:'Fixture read failure'}]}};
        } else if(command.action==='query-presentation') {reads++;response={uuid:'fixture-presentation',name:'Imported fixture',slides:[{index:0,sourceId:'stable-fixture-slide',label:'Verse',text:lyrics,notes:''}]};}
        else {send({type:'command-response',id:message.id,success:false,error:'Unexpected fixture command'});return;}
        send({type:'command-response',id:message.id,success:true,response:JSON.stringify(response)});
      }
    });
    await once(bridge,'open');
    await page("Page.navigate",{url:`${origin}/${orgId}/songs`});await click("Import from ProPresenter");
    await check("document.body?.innerText.includes('Unread fixture library')","partial library warning");
    await click("Retry unread libraries");await check("!document.body?.innerText.includes('Unread fixture library')","unread library recovered");
    for(const [width,height] of [[320,568],[768,1024],[1440,1000]]) {
      await page("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false});
      await check("(()=>{const d=document.querySelector('[role=dialog]');if(!d)return false;const r=d.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1&&!!d.querySelector('input[aria-label=\"Search ProPresenter songs\"]');})()",`import dialog bounds ${width}`);
      if(width===320)await writeFile('/tmp/showpilot-song-import-320.png',Buffer.from((await page('Page.captureScreenshot',{format:'png'})).data,'base64'));
    }
    await evaluate("window.importHold=true");await click("Imported fixtureImport");
    await check("window.importReplies.length===1&&window.importReplies[0]===200","import committed before response loss");
    lyrics="Changed first\nChanged second";
    await check("document.body?.innerText.includes('Import result unconfirmed')","import Retry available");
    await click("Close import");await click("Import from ProPresenter");
    await evaluate("window.importHold=false");await click("Retry import");
    await check("document.querySelector('main h1')?.textContent==='Imported fixture'&&!document.querySelector('[role=dialog]')","import retry opens song");
    assert.equal(await evaluate("document.querySelector('main textarea').value"),"Original first\nOriginal second");assert.equal(reads,1,"retry uses the original slide snapshot");
    await evaluate("window.importHold=true");await click("Check ProPresenter");
    await check("window.importReplies.length===2","reimport committed before response loss");
    lyrics="Too late to replace the submitted draft";
    await check("document.body?.innerText.includes('Result unconfirmed')","reimport Retry available");
    await evaluate("window.importHold=false");await click("Retry update from propresenter");
    await check("document.querySelector('main textarea')?.value==='Changed first\\nChanged second'&&!document.body.innerText.includes('Result unconfirmed')","reimport recovers original snapshot");
    assert.equal(reads,2);assert.equal(listReads,2);
    const requests=await evaluate("window.importRequests");assert.equal(requests.length,4);assert.equal(requests[0],requests[1]);assert.equal(requests[2],requests[3]);
    await click("Cue");
    await evaluate("window.holdTimeline=true");await click("Load cues");
    await check("window.heldTimeline>0","relay acknowledgement actually withheld");
    await check("document.body?.innerText.includes('Save was not confirmed by the relay')","unconfirmed cue load shown as failure");
    assert.equal(await evaluate("document.body.innerText.includes('events confirmed by Timecode')"),false,"no premature success");
    const before = await fetch(`${origin}/api/timecode/${orgId}/events?showId=smoke-show`,{headers:{Cookie:operatorCookie}});
    assert.equal(before.status,200);assert.equal((await before.json()).length,2,"relay stored the real cue group despite lost acknowledgement");
    await evaluate("window.holdTimeline=false");await click("Retry Load cues");
    await check("document.body?.innerText.includes('2 lyric automation events confirmed by Timecode')","cue success waits for actual relay acknowledgement");
    const after = await fetch(`${origin}/api/timecode/${orgId}/events?showId=smoke-show`,{headers:{Cookie:operatorCookie}});
    assert.equal(after.status,200);assert.equal((await after.json()).length,2,"retry replaces the group without duplicating cues");
    assert.deepEqual(await evaluate("window.songErrors"),[]);
  });
  } finally {bridge?.terminate();}
  await stopServer();
  assert.equal((await queryFixture(`SELECT id FROM song WHERE orgId='${orgId}'`)).length,1);
  const sections=await queryFixture(`SELECT lyrics FROM song_section WHERE orgId='${orgId}'`);
  assert.deepEqual(sections,[{lyrics:"Changed first\nChanged second"}]);
  assert.equal((await queryFixture(`SELECT requestId FROM song_write_receipt WHERE orgId='${orgId}' AND kind='import'`)).length,2);
  console.log(JSON.stringify({ok:true,libraryReads:listReads,presentationReads:reads,importAttempts:4,committedImports:2,songs:1,relayAcknowledgementRecovery:true,viewportWidths:[320,768,1440],browserErrors:0}));
});
