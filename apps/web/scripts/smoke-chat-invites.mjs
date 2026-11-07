// Real auth, signed chat passes, compiled Worker/Chrome and disposable D1.
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";
let validationId;
const assets = resolve(import.meta.dirname, "../dist/server/assets");
for (const file of (await readdir(assets)).filter(file => file.endsWith(".js"))) {
  const source = await readFile(resolve(assets, file), "utf8");
  validationId ??= source.match(/const validatePlanningChatPass_createServerFn_handler = createServerRpc\(\{\s*id: "([^"]+)"/)?.[1];
}
assert.ok(validationId, "compiled Planning validation RPC");
await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, operatorEmail, operatorPassword, planningChatPass, crewChatPass, revokeFixtureOperator, stopServer, startServer, queryFixture, capturedEmails }) => {
  const planningPath = token => `/join/chat/planning/${encodeURIComponent(token)}`;
  const crewPath = token => `/join/chat/${encodeURIComponent(token)}`;
  const valid = planningChatPass();
  const response = await fetch(`${origin}${planningPath(valid)}`, { headers: { Cookie: operatorCookie }, redirect: "manual" });
  assert.ok([302,303,307,308].includes(response.status), `authorized SSR redirect: ${response.status}`);
  assert.equal(new URL(response.headers.get("Location"), origin).pathname, `/${orgId}/chat`);
  assert.equal(new URL(response.headers.get("Location"), origin).searchParams.get("room"), "planning");
  assert.equal((await response.text()).includes("This invite is for another member"), false);
  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    await page("Page.enable");
    await page("Page.addScriptToEvaluateOnNewDocument", { source: `
      window.inviteErrors=[];window.inviteSockets=[];window.wrongMemberSeen=false;window.inviteFault=false;
      addEventListener('error',event=>window.inviteErrors.push(event.message));addEventListener('unhandledrejection',event=>window.inviteErrors.push(String(event.reason)));
      new MutationObserver(()=>{if(document.body?.innerText.includes('This invite is for another member'))window.wrongMemberSeen=true;}).observe(document,{subtree:true,childList:true,characterData:true});
      const original=window.fetch;window.fetch=(input,options)=>{const url=input instanceof Request?input.url:String(input);if(window.inviteFault&&url.includes(${JSON.stringify(validationId)}))return new Promise(()=>{});return original(input,options);};
      const NativeSocket=window.WebSocket;window.WebSocket=class extends NativeSocket{constructor(...args){super(...args);window.inviteSockets.push(this);}};` });
    const check = (expression, label) => poll(() => evaluate(expression), label).catch(async error => {
      console.log(JSON.stringify({ label, body: await evaluate("document.body?.innerText"), errors: await evaluate("window.inviteErrors") }));
      await writeFile("/tmp/showpilot-chat-invites-failure.png", Buffer.from((await page("Page.captureScreenshot", { format: "png" })).data, "base64")); throw error;
    });
    const text = value => check(`document.body?.innerText.includes(${JSON.stringify(value)})`, value);
    const button = name => `[...document.querySelectorAll('button,a')].find(n=>n.textContent.trim()===${JSON.stringify(name)}&&!n.disabled&&n.getBoundingClientRect().height>0)`;
    const point = name => `(async()=>{const n=${button(name)};if(!n)return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));for(let p=n;p;p=p.parentElement)if(p.getAnimations().some(a=>a.playState==='running'))return null;const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return !n.disabled&&n.contains(document.elementFromPoint(x,y))?{x,y}:null})()`;
    const click = async name => {
      const p = await poll(() => evaluate(point(name)), `reachable ${name}`);
      await page("Input.dispatchMouseEvent", { type: "mousePressed", ...p, button: "left", clickCount: 1 });
      await page("Input.dispatchMouseEvent", { type: "mouseReleased", ...p, button: "left", clickCount: 1 });
    };
    const fill = async (id, value) => {
      await check(`!!document.getElementById(${JSON.stringify(id)})&&Object.keys(document.getElementById(${JSON.stringify(id)})).some(key=>key.startsWith('__reactProps'))`, `${id} hydrated`);
      await evaluate(`(()=>{const n=document.getElementById(${JSON.stringify(id)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    };
    const open = path => page("Page.navigate", { url: `${origin}${path}` });
    const geometry = async (name, label) => {
      for(const [width,height] of [[320,568],[768,1024],[1440,900]]) {
        await page("Emulation.setDeviceMetricsOverride", { width,height,deviceScaleFactor:1,mobile:false });
        await check(point(name), `${label} hit at ${width}`);
        await check(`(()=>{const n=${button(name)},r=n.getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth+1&&r.width>=44&&r.height>=44&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()`, `${label} bounds at ${width}`);
        if(width===320)await writeFile(`/tmp/showpilot-chat-invite-${label}-320.png`,Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));
      }
    };
    for (const [path, heading, label] of [
      [planningPath("broken"), "This Planning invite is invalid", "invalid"],
      [planningPath(planningChatPass(undefined,-1)), "This Planning invite has expired", "expired"],
      [planningPath(planningChatPass(["smoke-second-operator"])), "This invite is for another member", "wrong-account"],
      [planningPath(planningChatPass(undefined,300,"removed-fixture")), "This Planning invite is no longer available", "unavailable"],
      [crewPath("broken"), "This crew pass is invalid", "crew-invalid"],
      [crewPath(crewChatPass(-1)), "This crew pass has expired", "crew-expired"],
    ]) {
      await open(path); await text(heading); await geometry("Return to ShowPilot", label);
      assert.equal(await evaluate("window.inviteSockets.length"),0);assert.deepEqual(await evaluate("window.inviteErrors"),[]);
    }
    await open(planningPath(valid));
    await check(`location.pathname==='/${orgId}/chat'&&new URL(location.href).searchParams.get('room')==='planning'`, "authorized Planning handoff");
    await text("Planning Room"); assert.equal(await evaluate("window.wrongMemberSeen"),false);
    await evaluate("fetch('/api/auth/sign-out',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.json())");
    const longPass=planningChatPass(["smoke-operator",...Array.from({length:49},()=>randomUUID())]);
    assert.ok(planningPath(longPass).length>2048);
    await open(planningPath(longPass)); await text("Join the Planning Room"); await geometry("Sign in to continue","sign-in");
    await click("Sign in to continue"); await check("!!document.getElementById('email')&&!!document.getElementById('password')", "sign-in form");
    assert.equal(await evaluate("new URL(location.href).searchParams.get('returnTo')"),planningPath(longPass));
    await fill("email",operatorEmail);await fill("password",operatorPassword);await click("Sign in");
    await check(`location.pathname==='/${orgId}/chat'&&new URL(location.href).searchParams.get('room')==='planning'`, "long invite sign-in return");
    await text("Planning Room");assert.equal(await evaluate("window.wrongMemberSeen"),false);
    // Sign-in performs a full document navigation. Exercise a later SPA read
    // through the installed router so the browser-side transport can be held.
    await check("!!window.__TSR_ROUTER__", "client router hydrated");
    await evaluate(`window.inviteFault=true;void window.__TSR_ROUTER__.navigate({href:${JSON.stringify(planningPath(valid))}});true`);
    await text("Something went wrong");
    assert.equal(await evaluate("document.body.innerText.includes('This Planning invite has expired')||document.body.innerText.includes('This invite is for another member')"),false);
    await geometry("Try again","read-retry");
    await evaluate("window.inviteFault=false");await click("Try again");
    await check(`location.pathname==='/${orgId}/chat'&&new URL(location.href).searchParams.get('room')==='planning'`, "sign-in return and read Retry");
    await text("Planning Room");assert.equal(await evaluate("window.wrongMemberSeen"),false);assert.deepEqual(await evaluate("window.inviteErrors"),[]);
    await evaluate("fetch('/api/auth/sign-out',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.json())");
    await open(crewPath(crewChatPass(20)));await text("Join production chat");
    assert.equal(await evaluate("window.inviteSockets.length"),0);
    await fill("crew-chat-display-name","Camera invite fixture");await click("Join Team Chat");
    await check("window.inviteSockets.some(s=>s.readyState===WebSocket.OPEN)","actual guest connection");
    await text("This crew pass has expired");
    await check("window.inviteSockets.every(s=>s.readyState===WebSocket.CLOSED)","guest closed at expiry");
    assert.deepEqual(await evaluate("window.inviteErrors"),[]);
    // Fresh authentication, then remove only the disposable fixture membership.
    await evaluate(`fetch('/api/auth/sign-in/email',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:${JSON.stringify(operatorEmail)},password:${JSON.stringify(operatorPassword)}})}).then(r=>r.json())`);
    await page("Page.navigate",{url:"about:blank"});await stopServer();await revokeFixtureOperator();await startServer();
    await open(planningPath(valid));await text("Your Planning access has changed");await geometry("Return to ShowPilot","access-removed");
    assert.equal(await evaluate("window.wrongMemberSeen"),false);assert.deepEqual(await evaluate("window.inviteErrors"),[]);
  });
  assert.equal((await capturedEmails()).length,0);await stopServer();
  assert.equal((await queryFixture("SELECT COUNT(*) AS count FROM member WHERE organizationId='display-smoke' AND userId='smoke-operator'"))[0].count,0);
  assert.equal((await queryFixture("SELECT COUNT(*) AS count FROM member WHERE organizationId='display-smoke' AND userId='smoke-second-operator'"))[0].count,1);
  console.log(JSON.stringify({result:"passed",authorizedSsrRedirect:true,noWrongMemberFlash:true,invalidAndExpiredDistinct:true,longInviteSignInReturn:true,boundedReadRetry:true,guestNamedJoin:true,guestExpiryDisconnect:true,currentMembershipChecked:true,widths:[320,768,1440],externalEmail:0,browserErrors:[]}));
}, {secondOperator:true,secondOperatorMember:true,captureEmail:true});
