// Compiled app, real auth and relays. Delay delivery, never manufacture server state.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";

await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, capturedEmails }) => {
  const headers = { Cookie: operatorCookie, Origin: origin };
  const history = async () => {
    const response = await fetch(`${origin}/api/chat/${orgId}/history?room=production`, { headers, signal: AbortSignal.timeout(8000) });
    assert.equal(response.status, 200);
    return (await response.json()).messages;
  };
  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    await page("Emulation.setFocusEmulationEnabled", { enabled: true });
    await page("Page.enable");
    await page("Page.addScriptToEvaluateOnNewDocument", { source: `
      window.probe={hold:{timecode:true,chat:true},sockets:[],held:[],writes:[],errors:[],documentId:crypto.randomUUID()};
      addEventListener('error',e=>probe.errors.push(e.message));
      addEventListener('unhandledrejection',e=>probe.errors.push(String(e.reason)));
      const OriginalSocket=WebSocket;
      window.WebSocket=class extends OriginalSocket {
        constructor(...args){super(...args);this.kind=String(args[0]).includes('/api/timecode/')?'timecode':String(args[0]).includes('/api/chat/')?'chat':'other';probe.sockets.push(this);}
        set onmessage(handler){super.onmessage=event=>{if(probe.hold[this.kind])probe.held.push({kind:this.kind,socket:this,release:()=>handler.call(this,event)});else handler.call(this,event);};}
        send(data){probe.writes.push({kind:this.kind,data});super.send(data);}
      };
      probe.release=kind=>{probe.hold[kind]=false;const ready=probe.held.filter(item=>item.kind===kind);probe.held=probe.held.filter(item=>item.kind!==kind);ready.forEach(item=>item.release());};
      probe.disconnect=kind=>{probe.hold[kind]=true;probe.sockets.filter(socket=>socket.kind===kind&&socket.readyState===WebSocket.OPEN).forEach(socket=>socket.close());};
    ` });
    const check = (expression, label) => poll(() => evaluate(expression), label).catch(async error => {
      console.log(JSON.stringify({ label, url: await evaluate("location.href"), body: await evaluate("document.body.innerText"), errors: await evaluate("probe.errors"), sockets: await evaluate("probe.sockets.map(s=>({kind:s.kind,state:s.readyState}))") }));
      await writeFile("/tmp/showpilot-connection-failure.png", Buffer.from((await page("Page.captureScreenshot", { format: "png" })).data, "base64"));
      throw error;
    });
    const button = name => `[...(document.querySelector('[role=dialog]')??document).querySelectorAll('button,a')].find(n=>(n.textContent.trim()===${JSON.stringify(name)}||n.getAttribute('aria-label')===${JSON.stringify(name)})&&n.getBoundingClientRect().height>0&&!n.disabled)`;
    const clickNode = async (expression, label) => {
      const position = await check(`(async()=>{const n=${expression};if(!n||!Object.keys(n).some(k=>k.startsWith('__reactProps')))return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`, label);
      await page("Input.dispatchMouseEvent", { type:"mousePressed", ...position, button:"left", clickCount:1 });
      await page("Input.dispatchMouseEvent", { type:"mouseReleased", ...position, button:"left", clickCount:1 });
    };
    const click = name => clickNode(button(name), name);
    const route = async path => {
      await clickNode(`[...document.querySelectorAll('a')].find(n=>n.getAttribute('href')===${JSON.stringify(`/${orgId}/${path}`)}&&n.getBoundingClientRect().height>0)`, `navigate ${path}`);
      await check(`location.pathname===${JSON.stringify(`/${orgId}/${path}`)}`, `${path} route`);
    };
    const fill = async (expression, value) => {
      await check(`!!(${expression})&&Object.keys(${expression}).some(k=>k.startsWith('__reactProps'))`, "hydrated field");
      await evaluate(`(()=>{const n=${expression};n.focus();Object.getOwnPropertyDescriptor(n instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    };
    const field = label => `[...document.querySelectorAll('label')].find(n=>[...n.childNodes].filter(c=>c.nodeType===Node.TEXT_NODE).map(c=>c.textContent).join('').trim()===${JSON.stringify(label)})?.querySelector('input,textarea')`;
    const timecodeState = status => `document.querySelectorAll('[aria-label="Timecode ${status}"]').length`;
    const panel = "document.querySelector('[data-testid=chat-panel]')";
    const chatStatus = status => `${panel}?.innerText.includes(${JSON.stringify(status)})&&[...document.querySelectorAll('main section')].some(n=>n.querySelector('p')?.textContent==='Connection'&&n.innerText.includes(${JSON.stringify(status)}))`;
    await page("Emulation.setDeviceMetricsOverride", { width:1440,height:1000,deviceScaleFactor:1,mobile:false });
    await page("Page.navigate", { url:`${origin}/${orgId}/timecode` });
    await check(`${timecodeState("connecting")}===2&&probe.held.some(item=>item.kind==='timecode')`, "both clocks connecting despite an open socket");
    const documentId = await evaluate("probe.documentId");
    assert.equal(await evaluate("document.querySelector('main').innerText.includes('Disconnected')||document.querySelector('main').innerText.includes('No automation events')||document.querySelector('main').innerText.includes('No media output enabled')"), false);
    assert.equal(await evaluate("document.querySelector('main').innerText.includes('--:--:--:--')"), true);
    await check(`${timecodeState("reconnecting")}===2`, "initial hydration has a bounded deadline");
    await evaluate("probe.release('timecode')");
    await check(`${timecodeState("stopped")}===2`, "both clocks use confirmed state");
    const timecodeSockets = await evaluate("probe.sockets.filter(s=>s.kind==='timecode').length");
    await route("songs");
    await check("document.body.innerText.includes('Build your first lyrics cue map')", "empty song library");
    await click("Create manually");
    await fill(field("Title"), "Connection rehearsal");
    await fill(field("Section 1 lyrics"), "First line\nSecond line");
    await click("Create song");
    await check(`${timecodeState("stopped")}===1&&document.querySelector('main h1')?.textContent==='Connection rehearsal'`, "Song Studio shares the confirmed clock");
    assert.equal(await evaluate("probe.sockets.filter(s=>s.kind==='timecode').length"), timecodeSockets, "route changes do not replace the shared timecode connection");
    await evaluate("probe.disconnect('timecode')");
    await check(`${timecodeState("reconnecting")}===1`, "Song Studio shows retained reconnecting clock");
    assert.equal(await evaluate("document.body.innerText.includes('Timecode offline')"), false);
    await route("timecode");
    await check(`${timecodeState("reconnecting")}===2&&probe.held.some(item=>item.kind==='timecode'&&item.socket.readyState===WebSocket.OPEN)`, "Timecode matches Song Studio during reconnect");
    await evaluate("probe.release('timecode')");
    await check(`${timecodeState("stopped")}===2`, "reconnection confirmed");
    await route("chat");
    await check(`(${chatStatus("Connecting")})&&probe.held.some(item=>item.kind==='chat')`, "chat header and connection panel await room confirmation");
    assert.equal(await evaluate(`${panel}.innerText.includes('No messages yet')`), false);
    await fill(`${panel}.querySelector('textarea')`, "QUEUED_CONNECTION_REHEARSAL");
    await page("Input.dispatchKeyEvent", { type:"keyDown",key:"Enter",code:"Enter",windowsVirtualKeyCode:13 });
    await page("Input.dispatchKeyEvent", { type:"keyUp",key:"Enter",code:"Enter",windowsVirtualKeyCode:13 });
    await check(`${panel}.innerText.includes('QUEUED_CONNECTION_REHEARSAL')`, "queued message stays visible");
    assert.equal((await history()).length, 0, "unconfirmed room receives no message");
    assert.equal(await evaluate("probe.writes.filter(w=>w.kind==='chat'&&JSON.parse(w.data).type==='message').length"), 0);
    await check(`(${chatStatus("Reconnecting")})&&!!(${button("Reconnect chat")})&&!!${panel}.querySelector('time[dateTime]')`, "room deadline exposes reconnect and timestamp");
    for (const [width,height] of [[320,568],[768,1024],[1440,1000]]) {
      await page("Emulation.setDeviceMetricsOverride", { width,height,deviceScaleFactor:1,mobile:false });
      await check(`(async()=>{const n=${button("Reconnect chat")};if(!n)return false;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect();return b.height>=44&&b.left>=0&&b.right<=innerWidth+1&&b.top>=0&&b.bottom<=innerHeight&&document.documentElement.scrollWidth<=innerWidth+1&&n.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2));})()`, `reachable reconnect ${width}`);
      if(width===320) await writeFile("/tmp/showpilot-connection-320.png",Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));
      await check(`(async()=>{const region=document.querySelector('[data-testid=chat-scroll-region]');if(region.clientHeight<120)return false;const message=[...region.querySelectorAll('[data-chat-message-id]')].find(n=>n.innerText.includes('QUEUED_CONNECTION_REHEARSAL'));if(!message)return false;message.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=message.getBoundingClientRect();return b.top>=0&&b.bottom<=innerHeight&&message.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2));})()`, `queued message remains readable ${width}`);
      if(width===320) await writeFile("/tmp/showpilot-connection-message-320.png",Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));
    }
    const socketCount = await evaluate("probe.sockets.filter(s=>s.kind==='chat').length");
    await click("Reconnect chat");
    await check(`probe.sockets.filter(s=>s.kind==='chat').length>${socketCount}&&probe.held.some(item=>item.kind==='chat'&&item.socket.readyState===WebSocket.OPEN)`, "manual retry opens a fresh room");
    await evaluate("probe.release('chat')");
    await check(chatStatus("Connected"), "both chat labels confirm readiness");
    await poll(async () => (await history()).filter(message=>message.text==="QUEUED_CONNECTION_REHEARSAL").length===1, "queued message persisted once");
    assert.equal(await evaluate("probe.writes.filter(w=>w.kind==='chat'&&JSON.parse(w.data).type==='message').length"), 1, "late old hydration cannot duplicate a send");
    await route("show");
    await check(`${panel}?.innerText.includes('Connected')&&${panel}?.innerText.includes('QUEUED_CONNECTION_REHEARSAL')`, "Show Team Chat connects and retains room history");
    await route("board");
    await check("document.body.innerText.includes('Your show board is ready')", "board renders");
    assert.equal(await evaluate("/connected,? Live|Disconnected|Timecode offline/.test(document.body.innerText)"), false);
    await route("show");
    await route("chat");
    await check(`(${chatStatus("Connected")})&&${panel}.innerText.includes('QUEUED_CONNECTION_REHEARSAL')`, "returning to chat confirms same room");
    assert.equal(await evaluate("probe.documentId"), documentId, "all screen navigation is SPA");
    assert.deepEqual(await evaluate("probe.errors"), []);
  });
  assert.equal((await history()).filter(message=>message.text==="QUEUED_CONNECTION_REHEARSAL").length,1);
  assert.equal((await capturedEmails()).length,0);
  console.log(JSON.stringify({result:"passed",screens:["Timecode","Song Studio","Chat","Show","Board"],delayedHydration:true,sharedClock:true,queuedSends:1,lateRepliesIgnored:true,widths:[320,768,1440],browserErrors:0,externalEmail:0}));
}, { captureEmail:true });
