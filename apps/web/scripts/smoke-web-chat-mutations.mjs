// Built web UI and real disposable auth/ChatRelay. Drop only mutation replies,
// after the relay has committed the actual change.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";
await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie }) => {
  const history = async () => {
    const response = await fetch(`${origin}/api/chat/${orgId}/history?room=production`, { headers: { Cookie: operatorCookie } });
    assert.equal(response.status, 200); return (await response.json()).messages;
  };
  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    await page("Emulation.setFocusEmulationEnabled", { enabled: true });
    await page("Page.enable");
    await page("Page.addScriptToEvaluateOnNewDocument", { source: `
      window.chatErrors=[];window.chatSent=[];window.chatLoseMutation=true;
      addEventListener('error',e=>window.chatErrors.push(e.message));
      addEventListener('unhandledrejection',e=>window.chatErrors.push(String(e.reason)));
      const OriginalSocket=WebSocket;
      window.WebSocket=class extends OriginalSocket{
        constructor(...args){super(...args);this.chat=String(args[0]).includes('/api/chat/');
          if(this.chat)this.addEventListener('message',event=>{
            const packet=JSON.parse(event.data);
            if(window.chatLoseMutation&&packet.type==='mutation-result')event.stopImmediatePropagation();
          });
        }
        send(frame){if(this.chat){const packet=JSON.parse(frame);if(packet.type==='mutation')window.chatSent.push(packet);}return super.send(frame);}
      };` });
    const panel = "document.querySelector('[data-testid=chat-panel]')";
    const check = (expression, label) => poll(() => evaluate(expression), label, 25000).catch(async error => {
      console.error(JSON.stringify({ label, body: await evaluate("document.body.innerText"), errors: await evaluate("window.chatErrors") }));
      await writeFile("/tmp/showpilot-web-mutation-failure.png", Buffer.from((await page("Page.captureScreenshot", { format: "png" })).data, "base64"));
      throw error;
    });
    const control = name => `[...(document.querySelector('[role="dialog"]')??document).querySelectorAll('button')].find(n=>(n.textContent.trim()===${JSON.stringify(name)}||n.getAttribute('aria-label')===${JSON.stringify(name)})&&n.getBoundingClientRect().height>0&&!n.disabled)`;
    const point = expression => `(async()=>{const n=${expression};if(!n||!Object.keys(n).some(key=>key.startsWith('__reactProps')))return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return n.contains(document.elementFromPoint(x,y))&&b.height>=44&&b.left>=0&&b.right<=innerWidth+1?{x,y}:null;})()`;
    const click = async name => {
      await page("Page.bringToFront");
      const position = await check(point(control(name)), `44px reachable ${name}`);
      await page("Input.dispatchMouseEvent", { type: "mousePressed", ...position, button: "left", clickCount: 1 });
      await page("Input.dispatchMouseEvent", { type: "mouseReleased", ...position, button: "left", clickCount: 1 });
    };
    const send = async text => {
      await check(`!!${panel}?.querySelector('textarea')`, "composer ready");
      await evaluate(`(()=>{const n=${panel}.querySelector('textarea');n.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(n,${JSON.stringify(text)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await click("Send message");
    };
    const room = async value => {
      await evaluate(`(()=>{const n=document.querySelector('select[aria-label="Switch chat room"]');n.value=${JSON.stringify(value)};n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await check(`new URLSearchParams(location.search).get('room')===${JSON.stringify(value)}&&${panel}?.innerText.includes(${JSON.stringify(value === "production" ? "Production Chat" : "Planning Room")})`, "room navigation");
      assert.equal(await evaluate("window.chatDocument"), "unchanged");
    };
    const widths = async kind => {
      for (const [width,height] of [[320,568],[768,1024],[1440,900]]) {
        await page("Emulation.setDeviceMetricsOverride", { width,height,deviceScaleFactor:1,mobile:false });
        // Wait for the actual responsive drawer transition, not just two frames:
        // a reachable button alone can miss text obscured by a moving sidebar.
        await check(`(()=>{const n=document.querySelector('aside'),r=n?.getBoundingClientRect();return r&&(innerWidth<1024?n.getAttribute('aria-hidden')==='true'&&r.right<=1:Math.abs(r.width-240)<1&&Math.abs(r.left)<1);})()`, `settled sidebar ${width}`);
        await check(`(()=>{const r=${panel}?.getBoundingClientRect();return r&&r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1;})()`, `chat panel bounds ${width}`);
        if (kind === "edit") await check(point(`${panel}.querySelector('button[aria-label="Save message"]')`), `visible save control ${width}`);
        await check(point(control("Recover original change")), `${kind} recovery ${width}`);
        assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"), true);
        await writeFile(`/tmp/showpilot-web-mutation-${kind}-${width}.png`,Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));
      }
    };
    await page("Emulation.setDeviceMetricsOverride", { width:1440,height:900,deviceScaleFactor:1,mobile:false });
    await page("Page.navigate", { url:`${origin}/${orgId}/chat?room=production` });
    await check(`${panel}?.innerText.includes('Production Chat')&&!${panel}.innerText.includes('Connecting to chat')`, "chat hydration");
    await evaluate("window.chatDocument='unchanged'");
    const fill = async (selector, text) => {
      await check(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});return n&&Object.keys(n).some(key=>key.startsWith('__reactProps'));})()`, "hydrated draft input");
      await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.focus();Object.getOwnPropertyDescriptor(n.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(text)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    };
    await fill('textarea', 'Unsent production draft');
    await room('planning'); assert.equal(await evaluate(`${panel}.querySelector('textarea').value`), '');
    await fill('textarea', 'Unsent planning draft');
    await room('production'); assert.equal(await evaluate(`${panel}.querySelector('textarea').value`), 'Unsent production draft');
    await click('Create poll'); await fill('input[placeholder="Ask a question"]', 'Ready for soundcheck?');
    await fill('input[placeholder="Option 1"]', 'Yes'); await fill('input[placeholder="Option 2"]', 'Wait');
    for(let option=3;option<=6;option++) await click('Add option');
    await room('planning'); assert.equal(await evaluate(`!!document.querySelector('[aria-label="Poll draft"]')`),false);
    await room('production'); assert.equal(await evaluate(`document.querySelector('input[placeholder="Ask a question"]').value`),'Ready for soundcheck?');
    for (const [width,height] of [[320,568],[768,1024],[1440,900]]) {
      await page('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      await check(`(()=>{const n=document.querySelector('aside'),r=n?.getBoundingClientRect();return r&&(innerWidth<1024?n.getAttribute('aria-hidden')==='true'&&r.right<=1:Math.abs(r.width-240)<1&&Math.abs(r.left)<1);})()`, `poll sidebar ${width}`);
      await check(point(control('Send poll')), `reachable poll send ${width}`);
      assert.equal(await evaluate(`(()=>{const n=${panel},h=n.firstElementChild,b=h.getBoundingClientRect(),p=n.getBoundingClientRect(),t=n.querySelector('textarea').getBoundingClientRect();return b.top>=p.top-1&&t.top>=0&&t.bottom<=innerHeight+1&&document.documentElement.scrollWidth<=innerWidth+1;})()`),true,`poll layout ${width}`);
      await writeFile(`/tmp/showpilot-web-composer-poll-${width}.png`,Buffer.from((await page('Page.captureScreenshot',{format:'png'})).data,'base64'));
    }
    await click('Close poll composer');
    await send("Mutation original");
    await check(`${panel}.innerText.includes('Mutation original')&&!!(${control("Edit message")})`,"stored message");
    await fill('textarea', 'Announcement after edit');
    await click("Edit message");
    await fill('textarea', 'Unsent correction');
    await room('planning'); assert.equal(await evaluate(`${panel}.querySelector('textarea').value`), 'Unsent planning draft');
    await room('production'); assert.equal(await evaluate(`${panel}.querySelector('textarea').value`), 'Unsent correction');
    await click('Cancel edit'); assert.equal(await evaluate(`${panel}.querySelector('textarea').value`), 'Announcement after edit');
    await click('Edit message');
    await evaluate(`(()=>{const n=${panel}.querySelector('textarea');n.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(n,'Captured edited text');n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await click("Save message");
    await check(`${panel}.innerText.includes('Recover original change')`,"lost edit reply deadline");
    let stored = await history(); assert.equal(stored.length,1); assert.equal(stored[0].text,"Captured edited text");
    const editAt = stored[0].editedAt;
    assert.equal(await evaluate(`!!${panel}.querySelector('button[aria-label="Edit message"][disabled]')`),true);
    await widths("edit");
    await room("planning"); assert.equal(await evaluate(`${panel}.innerText.includes('Recover original change')`),false);
    await room("production"); await check(`${panel}.innerText.includes('Recover original change')`,"edit survives navigation");
    await evaluate("window.chatLoseMutation=false"); await click("Recover original change");
    await check(`${panel}.innerText.includes('Your change was saved.')`,"edit recovery confirmed");
    assert.equal((await history())[0].editedAt,editAt);
    assert.deepEqual(await evaluate("window.chatSent[0]"),await evaluate("window.chatSent[1]"));
    await click("Dismiss result");
    await evaluate("window.chatLoseMutation=true"); await click("Choose reaction"); await click("React 👍");
    await check(`${panel}.innerText.includes('Recover original change')`,"lost reaction reply deadline");
    assert.equal((await history())[0].reactions[0].userIds.length,1);
    await room("planning"); await room("production");
    await evaluate("window.chatLoseMutation=false"); await click("Recover original change");
    await check(`${panel}.innerText.includes('Your change was saved.')`,"reaction recovery confirmed");
    assert.deepEqual(await evaluate("window.chatSent[2]"),await evaluate("window.chatSent[3]"));
    assert.equal((await history())[0].reactions[0].userIds.length,1);
    await click("Dismiss result");
    await evaluate("window.chatLoseMutation=true"); await click("Delete message"); await click("Delete message");
    await check(`${panel}.innerText.includes('Recover original change')`,"lost deletion reply deadline");
    stored=await history(); assert.equal(stored.length,1); assert.ok(stored[0].deletedAt); const deletedAt=stored[0].deletedAt;
    await widths("delete");
    await room("planning"); await room("production");
    await evaluate("window.chatLoseMutation=false"); await click("Recover original change");
    await check(`${panel}.innerText.includes('Your change was saved.')`,"deletion recovery confirmed");
    assert.equal((await history())[0].deletedAt,deletedAt);
    assert.deepEqual(await evaluate("window.chatSent[4]"),await evaluate("window.chatSent[5]"));
    await click("Dismiss result");
    assert.deepEqual(await evaluate("window.chatErrors"),[]);
  });
  console.log(JSON.stringify({result:"pass",draftRoomRetention:true,editDraftRestoration:true,pollDraftRetention:true,realRelay:true,editRecovery:true,reactionRecovery:true,deleteRecovery:true,sameCommandRetry:true,navigationRecovery:true,widths:[320,768,1440]}));
});
