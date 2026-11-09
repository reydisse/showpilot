// Compiled web UI, real local auth, R2 and ChatRelay; only responses are lost.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";
await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie }) => {
  const headers = { Cookie: operatorCookie };
  const history = async () => (await (await fetch(`${origin}/api/chat/${orgId}/history?room=production`, { headers })).json()).messages;
  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    await page("Page.enable"); await page("Emulation.setFocusEmulationEnabled", { enabled: true });
    await page("Page.addScriptToEvaluateOnNewDocument", { source: `
      window.attachmentErrors=[];window.uploadReplies=[];window.attachmentDocument='same';
      window.loseUpload=true;window.loseRemoval=false;window.holdUpload=false;
      addEventListener('error',e=>attachmentErrors.push(e.message));
      const originalFetch=window.fetch.bind(window);
      window.fetch=async function(input,init){
        const url=typeof input==='string'?input:input.url;
        const upload=url.includes('/upload?'),removal=url.includes('/cancel-upload?');
        if(upload&&window.holdUpload)await new Promise(resolve=>window.releaseUpload=resolve);
        const response=await originalFetch(input,init);
        if(upload&&response.ok){window.uploadReplies.push(await response.clone().json());if(window.loseUpload){window.loseUpload=false;throw new Error('Upload reply lost after storage');}}
        if(removal&&response.ok&&window.loseRemoval){window.loseRemoval=false;throw new Error('Removal reply lost after storage');}
        return response;
      };` });
    const panel = "document.querySelector('[data-testid=chat-panel]')";
    const check = (expression, label) => poll(() => evaluate(expression), label, 25000).catch(async error => {
      console.error(JSON.stringify({ label, body: await evaluate("document.body.innerText") }));
      await writeFile("/tmp/showpilot-web-attachment-failure.png", Buffer.from((await page("Page.captureScreenshot", { format: "png" })).data, "base64")); throw error;
    });
    const control = name => `[...document.querySelectorAll('button')].find(n=>n.getAttribute('aria-label')===${JSON.stringify(name)}&&!n.disabled&&n.getBoundingClientRect().height>0)`;
    const point = expression => `(async()=>{const n=${expression};if(!n)return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return n.contains(document.elementFromPoint(x,y))&&b.height>=44&&b.left>=0&&b.right<=innerWidth+1?{x,y}:null;})()`;
    const click = async name => { const position=await check(point(control(name)),`reachable ${name}`); await page("Input.dispatchMouseEvent",{type:"mousePressed",...position,button:"left",clickCount:1});await page("Input.dispatchMouseEvent",{type:"mouseReleased",...position,button:"left",clickCount:1}); };
    const pick = async name => {
      await check(`(()=>{const n=${panel}?.querySelector('input[type=file]');return n&&Object.keys(n).some(key=>key.startsWith('__reactProps'));})()`,"hydrated file input");
      return evaluate(`(()=>{const input=${panel}.querySelector('input[type=file]'),data=new DataTransfer();data.items.add(new File(['Stage notes'],${JSON.stringify(name)},{type:'text/plain'}));input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    };
    const room = async name => {
      await evaluate(`(()=>{const n=document.querySelector('select[aria-label="Switch chat room"]');n.value=${JSON.stringify(name)};n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await check(`${panel}?.innerText.includes(${JSON.stringify(name==='production'?'Production Chat':'Planning Room')})`,"room navigation");
      assert.equal(await evaluate("window.attachmentDocument"),"same");
    };
    const widths = async (kind, button) => {
      for (const [width,height] of [[320,568],[768,1024],[1440,900]]) {
        await page("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false});
        await check(`(()=>{const n=document.querySelector('aside'),r=n?.getBoundingClientRect();return r&&(innerWidth<1024?n.getAttribute('aria-hidden')==='true'&&r.right<=1:Math.abs(r.width-240)<1&&Math.abs(r.left)<1);})()`,`sidebar ${width}`);
        await check(point(control(button)),`recovery ${width}`);
        assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"),true);
        const heading=await evaluate(`(()=>{const n=${panel},h=n.firstElementChild,r=n.getBoundingClientRect(),b=h.getBoundingClientRect();return {panelTop:r.top,headerTop:b.top,headerBottom:b.bottom,scroll:n.scrollTop};})()`);
        assert.ok(heading.headerTop>=heading.panelTop-1,`unclipped chat heading ${width}: ${JSON.stringify(heading)}`);
        assert.equal(await evaluate(`(()=>{const group=document.querySelector('[aria-label="Chat recovery"]'),name=group?.querySelector('[data-testid^="chat-attachment-"] p'),g=group?.getBoundingClientRect(),n=name?.getBoundingClientRect();return g&&n&&n.top>=g.top-1&&n.bottom<=g.bottom+1;})()`),true,`visible attachment filename ${width}`);
        const bounds=await evaluate(`(()=>{const r=${panel}.querySelector('textarea').getBoundingClientRect();return {top:r.top,bottom:r.bottom};})()`);
        assert.ok(bounds.top>=0&&bounds.bottom<=height,`visible composer ${width}`);
        await writeFile(`/tmp/showpilot-web-attachment-${kind}-${width}.png`,Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));
      }
    };
    await page("Emulation.setDeviceMetricsOverride",{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await page("Page.navigate",{url:`${origin}/${orgId}/chat?room=production`});
    await check(`${panel}?.innerText.includes('Production Chat')&&!!${panel}.querySelector('input[type=file]')`,"attachment input");
    await pick("stage notes.txt");
    await check(`!!(${control('Retry uploading stage notes.txt')})`,"upload failure visible");
    const original = (await evaluate("window.uploadReplies"))[0];
    assert.equal(await (await fetch(`${origin}${original.url}`,{headers})).text(),"Stage notes");
    await widths("upload","Retry uploading stage notes.txt");
    await room("planning"); assert.equal(await evaluate(`${panel}.innerText.includes('stage notes.txt')`),false);
    await room("production"); await click("Retry uploading stage notes.txt");
    await check(`${panel}.innerText.includes('Ready to send')`,"upload recovery");
    assert.deepEqual((await evaluate("window.uploadReplies"))[1],original);
    await evaluate("window.loseRemoval=true"); await click("Remove stage notes.txt");
    await check(`!!(${control('Retry removing stage notes.txt')})`,"removal failure visible");
    assert.equal((await fetch(`${origin}${original.url}`,{headers})).status,404);
    await widths("removal","Retry removing stage notes.txt");
    await room("planning");await room("production");await click("Retry removing stage notes.txt");
    await check(`!${panel}.querySelector('[data-testid^=chat-attachment-]')`,"removal recovered");
    await evaluate("window.holdUpload=true");await pick("cancel-before-arrival.txt");
    await check("typeof window.releaseUpload==='function'","upload held before server");
    await click("Remove cancel-before-arrival.txt");
    await check(`!${panel}.querySelector('[data-testid^=chat-attachment-]')`,"cancel before arrival");
    await evaluate("window.holdUpload=false;window.releaseUpload()");
    await pick("send-me.txt");await check(`${panel}.innerText.includes('Ready to send')`,"new attachment ready");
    await click("Send message");
    await check(`!${panel}.querySelector('[data-testid^=chat-attachment-]')&&${panel}.innerText.includes('send-me.txt')`,"attachment sent");
    const messages=await history();assert.equal(messages.length,1);assert.equal(messages[0].attachments[0].name,"send-me.txt");
    assert.equal(await (await fetch(`${origin}${messages[0].attachments[0].url}`,{headers})).text(),"Stage notes");
    assert.deepEqual(await evaluate("window.attachmentErrors"),[]);
  });
  console.log(JSON.stringify({result:"pass",realStorage:true,lostUploadReply:true,lostRemovalReply:true,cancelBeforeArrival:true,roomRecovery:true,sendAttachment:true,widths:[320,768,1440]}));
});
