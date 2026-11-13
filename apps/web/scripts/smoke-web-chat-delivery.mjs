// Real compiled web client, auth, ChatRelay and inbox. Only network replies are
// delayed; persisted messages and partial inbox failures use disposable storage.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";

await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, queryFixture, restoreChatNotifications, readDeliveredChatNotification, capturedEmails }) => {
  const history = async () => {
    const response = await fetch(`${origin}/api/chat/${orgId}/history?room=production`, { headers: { Cookie: operatorCookie } });
    assert.equal(response.status, 200); return (await response.json()).messages;
  };
  const inbox = () => queryFixture("SELECT userId,source,readAt,dismissed FROM notification WHERE orgId='display-smoke' AND type='chat-group-message' ORDER BY userId,source");
  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    await page("Emulation.setFocusEmulationEnabled", { enabled: true });
    await page("Page.enable");
    await page("Page.addScriptToEvaluateOnNewDocument", { source: `
      window.chatErrors=[];window.chatSent=[];window.chatNotifications=[];window.chatHeld=[];
      window.chatLoseMessage=true;window.chatLostId=null;window.chatLoseNotification=false;
      addEventListener('error',e=>window.chatErrors.push(e.message));
      addEventListener('unhandledrejection',e=>window.chatErrors.push(String(e.reason)));
      const OriginalSocket=WebSocket;
      window.WebSocket=class extends OriginalSocket{
        constructor(...args){super(...args);this.chat=String(args[0]).includes('/api/chat/');
          if(this.chat)this.addEventListener('message',event=>{
            const packet=JSON.parse(event.data);
            if(window.chatLoseMessage&&packet.type==='message'&&packet.message.id===window.chatLostId)event.stopImmediatePropagation();
          });
        }
        send(frame){if(this.chat){const packet=JSON.parse(frame);if(packet.type==='message'){
          window.chatSent.push(packet);if(window.chatLoseMessage&&!window.chatLostId)window.chatLostId=packet.clientMessageId;
        }}return super.send(frame);}
      };
      const original=window.fetch;
      window.fetch=(input,options)=>{
        const url=input instanceof Request?input.url:String(input);
        if(!url.includes('/api/mobile/v1/chat/notify?'))return original(input,options);
        return original(input,options).then(async response=>{
          const body=await response.text();window.chatNotifications.push({body:JSON.parse(options.body),status:response.status});
          if(window.chatLoseNotification)return new Promise(resolve=>window.chatHeld.push(()=>resolve(new Response(body,{status:response.status,headers:response.headers}))));
          return new Response(body,{status:response.status,headers:response.headers});
        });
      };` });
    const panel = "document.querySelector('[data-testid=chat-panel]')";
    const check = (expression, label) => poll(() => evaluate(expression), label, 25000).catch(async error => {
      console.error(JSON.stringify({ label, body: await evaluate("document.body.innerText"), errors: await evaluate("window.chatErrors") }));
      await writeFile("/tmp/showpilot-webchat-failure.png", Buffer.from((await page("Page.captureScreenshot", { format: "png" })).data, "base64"));
      throw error;
    });
    const control = name => `[...document.querySelectorAll('button')].find(n=>(n.textContent.trim()===${JSON.stringify(name)}||n.getAttribute('aria-label')===${JSON.stringify(name)})&&n.getBoundingClientRect().height>0&&!n.disabled)`;
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
        await check(point(control(kind === "message" ? "Retry send" : "Retry notifications")), `${kind} recovery ${width}`);
        assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"), true);
        await writeFile(`/tmp/showpilot-webchat-${kind}-${width}.png`,Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));
      }
    };
    await page("Emulation.setDeviceMetricsOverride", { width:1440,height:900,deviceScaleFactor:1,mobile:false });
    await page("Page.navigate", { url:`${origin}/${orgId}/chat?room=production` });
    await check(`${panel}?.innerText.includes('Production Chat')&&!${panel}.innerText.includes('Connecting to chat')`, "chat hydration");
    await evaluate("window.chatDocument='unchanged'");
    await send("Lost message reply");
    await check(`${panel}.innerText.includes('Delivery was not confirmed')`, "bounded message acknowledgement");
    assert.equal((await history()).filter(message=>message.text === "Lost message reply").length,1);
    assert.equal(await evaluate("window.chatNotifications.length"),0);
    await widths("message");
    await click("Remove local copy"); await click("Cancel");
    assert.equal(await evaluate(`${panel}.innerText.includes('Retry send')`),true);
    await evaluate("window.chatLoseMessage=false"); await click("Retry send");
    await check(`${panel}.innerText.includes('Crew notifications were not confirmed')`, "partial inbox failure surfaced");
    assert.equal(await evaluate("window.chatSent.length"),2);
    assert.deepEqual(await evaluate("window.chatSent[0]"),await evaluate("window.chatSent[1]"));
    assert.equal((await history()).length,1);
    let rows = await inbox(); assert.equal(rows.length,1); assert.equal(rows[0].userId,"smoke-third-operator");
    await readDeliveredChatNotification();
    await room("planning"); assert.equal(await evaluate(`${panel}.innerText.includes('Retry notifications')`),false);
    await room("production"); await check(`${panel}.innerText.includes('Retry notifications')`,"notification retained through navigation");
    await widths("notification");
    await restoreChatNotifications(); await click("Retry notifications");
    await check(`!${panel}.innerText.includes('Retry notifications')&&!${panel}.innerText.includes('Sending crew notifications')`,"notification-only retry settled");
    assert.equal(await evaluate("window.chatSent.length"),2);
    assert.deepEqual(await evaluate("window.chatNotifications[0].body"),await evaluate("window.chatNotifications[1].body"));
    rows=await inbox(); assert.equal(rows.length,2);
    assert.equal(rows.find(row=>row.userId === "smoke-third-operator").readAt,"2026-11-09T00:00:00.000Z");
    assert.equal(rows.find(row=>row.userId === "smoke-third-operator").dismissed,1);
    await evaluate("window.chatLoseNotification=true"); await send("Lost notification reply");
    await check(`${panel}.innerText.includes('Crew notifications were not confirmed')`,"notification deadline");
    assert.equal((await inbox()).length,4);
    await room("planning"); await room("production");
    await evaluate("window.chatLoseNotification=false"); await click("Retry notifications");
    await check(`!${panel}.innerText.includes('Retry notifications')&&!${panel}.innerText.includes('Sending crew notifications')`,"lost notification recovered");
    await evaluate("window.chatHeld.splice(0).forEach(release=>release())");
    assert.equal(await evaluate("window.chatSent.length"),3);
    assert.equal((await history()).length,2); assert.equal((await inbox()).length,4);
    assert.deepEqual(await evaluate("window.chatNotifications[2].body"),await evaluate("window.chatNotifications[3].body"));
    assert.deepEqual(await evaluate("window.chatErrors"),[]);
  });
  assert.equal((await capturedEmails()).length,0);
  console.log(JSON.stringify({result:"pass",realRelay:true,realInbox:true,lostMessageReply:true,sameMessageRetry:true,partialInboxRecovery:true,preservedReadAndDismissed:true,lostNotificationReply:true,navigationRecovery:true,widths:[320,768,1440],externalEmail:0}));
},{secondOperator:true,chatDeliveryNotifications:true,captureEmail:true});
