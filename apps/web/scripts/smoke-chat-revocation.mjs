// Actual signed links, Worker/D1/R2, two isolated Chrome sessions and a lost reply.
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";
const assets = resolve(import.meta.dirname, "../dist/server/assets");
let revokeId;
for (const name of (await readdir(assets)).filter(name => name.endsWith(".js"))) {
  const source = await readFile(resolve(assets, name), "utf8");
  revokeId ??= source.match(/const revokeChatPass_createServerFn_handler = createServerRpc\(\{\s*id: "([^"]+)"/)?.[1];
}
assert.ok(revokeId, "compiled revoke RPC");
await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, crewChatPass, planningChatPass, stopServer, queryFixture, capturedEmails }) => {
  const crew = crewChatPass(300);
  const crewUrl = `${origin}/join/chat/${encodeURIComponent(crew)}`;
  const planning = planningChatPass();
  const planningUrl = `${origin}/join/chat/planning/${encodeURIComponent(planning)}`;
  const upload = () => {
    const body = new FormData(); body.set("file", new File(["Revocation attachment fixture"], "fixture.txt", { type: "text/plain" }));
    return fetch(`${origin}/api/chat/${orgId}/upload?guestToken=${encodeURIComponent(crew)}`, { method: "POST", headers: { Origin: origin }, body });
  };
  const saved = await upload(); assert.equal(saved.status, 200); const attachment = await saved.json();
  const fileUrl = `${origin}${attachment.url}?guestToken=${encodeURIComponent(crew)}`;
  const before = await fetch(fileUrl); assert.equal(before.status, 200); assert.equal(before.headers.get("Cache-Control"), "private, no-store"); await before.text();
  async function setup(browser, label) {
    const { page, evaluate } = browser;
    await page("Page.enable");
    await page("Page.addScriptToEvaluateOnNewDocument", { source: `window.revokeErrors=[];window.revokeSockets=[];window.revokeFault=false;window.revokeCommitted=false;window.revokeRequests=0;
      addEventListener('error',e=>window.revokeErrors.push(e.message));addEventListener('unhandledrejection',e=>window.revokeErrors.push(String(e.reason)));
      const Socket=window.WebSocket;window.WebSocket=class extends Socket{constructor(...args){super(...args);window.revokeSockets.push(this);}};
      const fetchOriginal=window.fetch;window.fetch=(input,options)=>{const url=input instanceof Request?input.url:String(input);if(!url.includes(${JSON.stringify(revokeId)}))return fetchOriginal(input,options);window.revokeRequests++;const reply=fetchOriginal(input,options);if(window.revokeFault)return reply.then(async r=>{await r.text();window.revokeCommitted=true;return new Promise(()=>{});});return reply;};` });
    const check = (expression, description) => poll(() => evaluate(expression), description).catch(async error => {
      console.log(JSON.stringify({ label, description, body: await evaluate("document.body?.innerText"), errors: await evaluate("window.revokeErrors") }));
      await writeFile(`/tmp/showpilot-chat-revocation-${label}-failure.png`, Buffer.from((await page("Page.captureScreenshot", { format: "png" })).data, "base64")); throw error;
    });
    const text = text => check(`document.body?.innerText.includes(${JSON.stringify(text)})`, text);
    const control = name => `[...document.querySelectorAll('button,a')].find(n=>n.textContent.trim()===${JSON.stringify(name)}&&!n.disabled&&n.getBoundingClientRect().height>0)`;
    const point = name => `(async()=>{const n=${control(name)};if(!n)return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));for(let p=n;p;p=p.parentElement)if(p.getAnimations().some(a=>a.playState==='running'))return null;const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return !n.disabled&&n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`;
    const click = async name => {
      const p = await check(point(name), `reachable ${name}`);
      await page("Input.dispatchMouseEvent", { type: "mousePressed", ...p, button: "left", clickCount: 1 });
      await page("Input.dispatchMouseEvent", { type: "mouseReleased", ...p, button: "left", clickCount: 1 });
    };
    const fill = async (selector, value) => {
      await check(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});return n&&Object.keys(n).some(k=>k.startsWith('__reactProps'));})()`, "hydrated field");
      await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),p=n.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    };
    const geometry = async (name, file) => {
      for(const [width,height] of [[320,568],[768,1024],[1440,900]]) {
        await page("Emulation.setDeviceMetricsOverride", { width,height,deviceScaleFactor:1,mobile:false });
        await check(point(name), `${file} hit at ${width}`);
        await check(`(()=>{const r=(${control(name)}).getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth+1&&r.height>=44&&r.width>=44&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})()`, `${file} bounds at ${width}`);
        if(width===320)await writeFile(`/tmp/showpilot-chat-revocation-${file}-320.png`,Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));
      }
    };
    return { ...browser, check, text, click, fill, geometry };
  }
  await withRealBrowser({ origin, cookie: operatorCookie }, async memberBrowser => {
    const member = await setup(memberBrowser, "member");
    await member.page("Page.navigate", { url: `${origin}/${orgId}/chat` });
    await member.text("Production Chat");
    console.log(JSON.stringify({entryErrors:await member.evaluate("window.revokeErrors")}));
    await member.geometry("Disable a chat link", "entry");
    await withRealBrowser({ origin }, async guestBrowser => {
      const guest = await setup(guestBrowser, "guest");
      await guest.page("Page.navigate", { url: crewUrl }); await guest.text("Join production chat");
      await guest.fill("#crew-chat-display-name", "Camera revoke fixture"); await guest.click("Join Team Chat");
      await guest.check("window.revokeSockets.some(s=>s.readyState===WebSocket.OPEN)", "guest connected before revocation");
      await member.click("Disable a chat link"); await member.fill("[role=dialog] textarea", crewUrl);
      await member.click("Review disable"); await member.text("Disable this chat link?"); await member.geometry("Cancel", "confirmation");
      await member.click("Cancel"); assert.equal(await member.evaluate("window.revokeRequests"), 0);
      await member.check("![...document.querySelectorAll('[role=dialog]')].some(n=>n.textContent.includes('Disable this chat link?'))", "confirmation closed");
      await member.evaluate("window.revokeFault=true");
      await member.click("Review disable"); await member.click("Disable link");
      await member.check("window.revokeCommitted", "actual revocation reply withheld");
      await guest.text("This crew pass was revoked");
      await guest.check("window.revokeSockets.every(s=>s.readyState===WebSocket.CLOSED)", "guest sockets closed");
      await guest.geometry("Return to ShowPilot", "revoked");
      await member.text("The result is unconfirmed"); await member.geometry("Retry disable", "lost-reply");
      await member.evaluate("window.revokeFault=false"); await member.click("Retry disable"); await member.click("Disable link");
      await member.text("This link is disabled."); await member.geometry("Close", "confirmed");
      assert.equal(await member.evaluate("window.revokeRequests"), 2);
      assert.equal(await guest.evaluate("window.revokeSockets.length"), 1, "revoked guest never reconnects");
      for (const method of ["GET", "DELETE"]) {
        const denied = await fetch(fileUrl, { method }); assert.equal(denied.status,401,`revoked file ${method}`); await denied.text();
      }
      const uploadDenied = await upload(); assert.equal(uploadDenied.status,401); await uploadDenied.text();
      const socketStatus = await new Promise((resolve, reject) => {
        const request = httpRequest(`${origin}/api/chat/${orgId}/ws?guestToken=${encodeURIComponent(crew)}`, { headers: { Upgrade:"websocket", Connection:"Upgrade", "Sec-WebSocket-Key":"c2hvd3BpbG90LWZpeHR1cmU=", "Sec-WebSocket-Version":"13" } }, response => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
        request.on("error",reject);request.on("upgrade",(_response,socket)=>{socket.destroy();reject(new Error("Revoked socket upgraded"));});request.setTimeout(5000,()=>request.destroy(new Error("Handshake timed out")));request.end();
      });
      assert.equal(socketStatus,401);
      await member.fill("[role=dialog] textarea", planningUrl); await member.click("Review disable"); await member.click("Disable link");
      await member.text("This link is disabled.");
      const planningResponse = await fetch(planningUrl, { headers:{ Cookie:operatorCookie },redirect:"manual" });
      assert.equal(planningResponse.status,200); assert.ok((await planningResponse.text()).includes("This Planning invite was revoked"));
      await guest.page("Page.navigate",{url:crewUrl}); await guest.text("This crew pass was revoked");
      assert.equal(await guest.evaluate("window.revokeSockets.length"),0,"revoked links do not connect");
      // A name-entry screen loaded while valid must also recover if the link
      // is revoked before Join, when the rejected upgrade has no close reason.
      const staleCrewUrl = `${origin}/join/chat/${encodeURIComponent(crewChatPass(301))}`;
      await guest.page("Page.navigate",{url:staleCrewUrl}); await guest.text("Join production chat");
      await member.fill("[role=dialog] textarea",staleCrewUrl); await member.click("Review disable"); await member.click("Disable link"); await member.text("This link is disabled.");
      await guest.fill("#crew-chat-display-name","Late guest fixture"); await guest.click("Join Team Chat"); await guest.text("This crew pass was revoked");
      await guest.check("window.revokeSockets.every(s=>s.readyState===WebSocket.CLOSED)","revocation before Join recovered");
      assert.deepEqual(await guest.evaluate("window.revokeErrors"),[]);assert.deepEqual(await member.evaluate("window.revokeErrors"),[]);
      await member.click("Close");
      await member.check("window.revokeSockets.some(s=>s.readyState===WebSocket.OPEN)","normal member remains connected");
    });
  });
  assert.equal((await capturedEmails()).length,0);await stopServer();
  const rows=await queryFixture("SELECT orgId,tokenHash,scope,revokedBy FROM chat_pass_revocation");
  assert.equal(rows.length,3);assert.deepEqual(rows.map(r=>r.scope).sort(),["crew-chat","crew-chat","planning-chat"]);
  for(const row of rows){assert.equal(row.orgId,orgId);assert.equal(row.revokedBy,"smoke-operator");assert.match(row.tokenHash,/^sha256:[0-9a-f]{64}$/);}
  assert.equal(JSON.stringify(rows).includes(crew),false);assert.equal(JSON.stringify(rows).includes(planning),false);
  assert.equal((await queryFixture("SELECT COUNT(*) AS count FROM member WHERE organizationId='display-smoke' AND userId='smoke-operator'"))[0].count,1);
  console.log(JSON.stringify({result:"passed",guestCutOff:true,filesDenied:true,newSocketsDenied:true,planningRevoked:true,memberAccessPreserved:true,lostReplyRetry:true,revocationBeforeJoin:true,revocationRows:3,widths:[320,768,1440],externalEmail:0,browserErrors:[]}));
},{captureEmail:true});
