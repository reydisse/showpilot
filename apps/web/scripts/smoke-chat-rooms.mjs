// Compiled Worker + real authentication, relay history, SPA navigation and Chrome.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";

await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, capturedEmails }) => {
  const dm = "dm:smoke-operator:smoke-second-operator";
  const headers = { Cookie: operatorCookie, Origin: origin, "Content-Type": "application/json" };
  const send = async (room, text) => {
    const response = await fetch(`${origin}/api/chat/${orgId}/send?room=${encodeURIComponent(room)}`, {
      method: "POST", headers, body: JSON.stringify({ text }),
    });
    assert.equal(response.status, 200); return (await response.json()).message;
  };
  const oldest = await send("production", "PRODUCTION_OLDER_ONLY");
  // Exceed the actual relay hydration window, so Load older retrieves real data.
  for (let first = 0; first < 2000; first += 50) {
    await Promise.all(Array.from({ length: 50 }, (_, offset) => send("production", `PRODUCTION_${first + offset}`)));
  }
  await send("planning", "PLANNING_ONLY"); await send(dm, "DIRECT_ONLY");
  console.log("Seeded 2,003 real relay messages in three isolated rooms.");
  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    await page("Emulation.setFocusEmulationEnabled", { enabled: true });
    await page("Page.enable");
    await page("Page.addScriptToEvaluateOnNewDocument", { source: `
      window.chatErrors=[];window.chatHeld=[];window.chatHold=false;window.chatSockets=[];
      addEventListener('error',e=>window.chatErrors.push(e.message));
      addEventListener('unhandledrejection',e=>window.chatErrors.push(String(e.reason)));
      const OriginalSocket=WebSocket;window.WebSocket=class extends OriginalSocket{constructor(...args){super(...args);window.chatSockets.push(String(args[0]));}};
      const original=window.fetch;window.fetch=(input,options)=>{
        const url=input instanceof Request?input.url:String(input);
        if(!window.chatHold||!url.includes('/history?'))return original(input,options);
        // The real response arrives, but its delivery ignores abort. This models
        // an already completed response delayed past navigation or the deadline.
        return original(input,options).then(async response=>{
          const body=await response.text();
          return new Promise(resolve=>window.chatHeld.push(()=>resolve(new Response(body,{status:response.status,headers:response.headers}))));
        });
      };` });
    const check = (expression, label) => poll(() => evaluate(expression), label).catch(async error => {
      console.log(JSON.stringify({ label, url: await evaluate("location.href"), body: (await evaluate("document.body.innerText")).slice(0,9000), errors: await evaluate("window.chatErrors") }));
      await writeFile("/tmp/showpilot-chat-rooms-failure.png", Buffer.from((await page("Page.captureScreenshot", { format: "png" })).data, "base64"));
      throw error;
    });
    const control = name => `[...document.querySelectorAll('button')].find(n=>(n.textContent.trim()===${JSON.stringify(name)}||n.getAttribute('aria-label')===${JSON.stringify(name)}||[...n.querySelectorAll('span')].some(s=>s.textContent.trim()===${JSON.stringify(name)}))&&n.getBoundingClientRect().height>0&&!n.disabled)`;
    const point = expression => `(async()=>{const n=${expression};if(!n)return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return n.contains(document.elementFromPoint(x,y))&&b.height>=44?{x,y}:null;})()`;
    const click = async name => {
      await page("Page.bringToFront");
      const position = await check(point(control(name)), `44px reachable ${name}`);
      await page("Input.dispatchMouseEvent", { type: "mousePressed", ...position, button: "left", clickCount: 1 });
      await page("Input.dispatchMouseEvent", { type: "mouseReleased", ...position, button: "left", clickCount: 1 });
    };
    const panel = "document.querySelector('[data-testid=chat-panel]')";
    const room = async (value, title, marker, forbidden) => {
      await check(`new URLSearchParams(location.search).get('room')===${JSON.stringify(value)}&&${panel}?.innerText.includes(${JSON.stringify(title)})&&${panel}?.innerText.includes(${JSON.stringify(marker)})`, `${title} URL, panel and message`);
      assert.equal(await evaluate(`${panel}.innerText.includes(${JSON.stringify(forbidden)})`), false);
      assert.equal(await evaluate("window.chatDocument"), "unchanged");
      assert.equal(await evaluate(`document.querySelector('select[aria-label="Switch chat room"]').value`), value);
      assert.equal(await evaluate(`document.querySelector('main aside [aria-current=page]')?.textContent.includes(${JSON.stringify(title)})`), true);
    };
    await page("Emulation.setDeviceMetricsOverride", { width:1440, height:900, deviceScaleFactor:1, mobile:false });
    await page("Page.navigate", { url:`${origin}/${orgId}/chat?room=production` });
    await check(`${panel}?.innerText.includes('PRODUCTION_1999')`, "Production hydration");
    await evaluate("window.chatDocument='unchanged'");
    assert.equal(await evaluate(`${panel}.innerText.includes('PRODUCTION_OLDER_ONLY')`), false);
    await evaluate("window.chatHold=true"); await click("Load older messages");
    await check("window.chatHeld.length===1", "real nonempty older reply held");
    await click("Planning Room");
    await room("planning", "Planning Room", "PLANNING_ONLY", "PRODUCTION_");
    await evaluate("window.chatHeld.shift()();window.chatHold=false");
    await click("Load older messages");
    await check(`![...document.querySelectorAll('button')].some(n=>n.textContent.includes('Loading older messages'))`, "Planning history settled");
    assert.equal(await evaluate(`${panel}.innerText.includes('PRODUCTION_')`), false);
    assert.equal(await evaluate("document.body.innerText.includes('7 days')||document.body.innerText.includes('Seven-day')||[...document.querySelectorAll('button')].some(n=>/Join production/i.test(n.textContent))"), false);
    await click("Second fixture operator");
    await room(dm, "Second fixture operator", "DIRECT_ONLY", "PLANNING_ONLY");
    // Real composer send must land only in the selected conversation.
    await check(`!!${panel}?.querySelector('textarea')`, "DM composer");
    await evaluate(`(()=>{const n=${panel}.querySelector('textarea');n.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(n,'DIRECT_BROWSER_SENT');n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await page("Input.dispatchKeyEvent", { type:"keyDown",key:"Enter",code:"Enter",windowsVirtualKeyCode:13 });
    await page("Input.dispatchKeyEvent", { type:"keyUp",key:"Enter",code:"Enter",windowsVirtualKeyCode:13 });
    await poll(async () => {
      const response = await fetch(`${origin}/api/chat/${orgId}/history?room=${encodeURIComponent(dm)}`, { headers });
      return (await response.json()).messages.some(m => m.text === "DIRECT_BROWSER_SENT");
    }, "DM send persisted in relay");
    await evaluate("history.back()"); await room("planning", "Planning Room", "PLANNING_ONLY", "DIRECT_BROWSER_SENT");
    await evaluate("history.forward()"); await room(dm, "Second fixture operator", "DIRECT_ONLY", "PLANNING_ONLY");
    await click("Production Chat"); await room("production", "Production Chat", "PRODUCTION_1999", "DIRECT_BROWSER_SENT");
    await evaluate("window.chatHold=true"); await click("Load older messages");
    await check("window.chatHeld.length===1", "active-room reply held");
    await check(`${panel}.innerText.includes('timed out')`, "history deadline shown");
    await evaluate("window.chatHold=false"); await click("Retry older messages");
    await check(`${panel}.innerText.includes('PRODUCTION_OLDER_ONLY')`, "Retry loads actual older message");
    await evaluate("window.chatHeld.shift()()");
    assert.equal(await evaluate(`${panel}.innerText.includes('timed out')`), false);
    const select = "document.querySelector('select[aria-label=\"Switch chat room\"]')";
    for (const [width,height] of [[320,568],[768,1024],[1440,900]]) {
      await page("Emulation.setDeviceMetricsOverride", { width,height,deviceScaleFactor:1,mobile:false });
      for (const [value,title,marker,forbidden] of [["planning","Planning Room","PLANNING_ONLY","PRODUCTION_"],[dm,"Second fixture operator","DIRECT_ONLY","PLANNING_ONLY"],["production","Production Chat","PRODUCTION_1999","DIRECT_ONLY"]]) {
        if (width<1024) {
          await check(point(select), `44px selector ${width}`);
          assert.deepEqual(await evaluate(`[...${select}.querySelectorAll('optgroup')].map(n=>n.label)`), ["Rooms","Direct messages"]);
          await evaluate(`(()=>{const n=${select};n.value=${JSON.stringify(value)};n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        } else await click(title);
        await room(value,title,marker,forbidden);
        await check(`document.documentElement.scrollWidth<=innerWidth+1&&(()=>{const r=${panel}.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1;})()`, `${title} bounds ${width}`);
      }
      if(width===320) await writeFile("/tmp/showpilot-chat-rooms-320.png",Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));
    }
    assert.deepEqual(await evaluate("window.chatErrors"), []);
    // Invalid and foreign DM links never masquerade as Production or open a chat socket.
    for (const invalid of ["missing", "dm:someone:someone-else"]) {
      await page("Page.navigate", { url:`${origin}/${orgId}/chat?room=${encodeURIComponent(invalid)}` });
      await check("document.querySelector('main [role=alert]')?.innerText.includes('Conversation unavailable')", "invalid room recovery");
      assert.equal(await evaluate(`${panel}!==null`),false);
      assert.equal(await evaluate(`window.chatSockets.some(url=>url.includes('/api/chat/'))`),false);
      await click("Open Production Chat"); await check(`${panel}?.innerText.includes('PRODUCTION_1999')`, "invalid room recovers");
      assert.deepEqual(await evaluate("window.chatErrors"), []);
    }
  });
  const persisted = await fetch(`${origin}/api/chat/${orgId}/history?room=production&beforeTimestamp=${oldest.timestamp + 1}&beforeId=zzzz`, { headers });
  assert.ok((await persisted.json()).messages.some(message=>message.id===oldest.id));
  assert.equal((await capturedEmails()).length,0);
  console.log(JSON.stringify({result:"passed",rooms:3,spaBackForward:true,lateHistoryIsolated:true,realOlderHistoryRetry:true,widths:[320,768,1440],invalidRoomRecovery:true,browserErrors:[],externalEmail:0}));
}, { secondOperator:true, captureEmail:true });
