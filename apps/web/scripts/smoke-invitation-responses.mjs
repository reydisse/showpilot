// Compiled Worker, real auth/D1, pointer input and deliberately lost committed replies.
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";
const ids = {};
const assets = resolve(import.meta.dirname, "../dist/server/assets");
for (const name of (await readdir(assets)).filter(name => name.endsWith(".js"))) {
  const source = await readFile(resolve(assets, name), "utf8");
  for (const fn of ["acceptInvitation", "rejectInvitation", "getInvitationDetails", "setActiveOrg"]) {
    ids[fn] ??= source.match(new RegExp(`const ${fn}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`))?.[1];
  }
}
for (const fn of ["acceptInvitation", "rejectInvitation", "getInvitationDetails", "setActiveOrg"]) assert.ok(ids[fn], `compiled ${fn}`);
await withLocalSmokeFixture(async ({ origin, operatorCookie, operatorEmail, operatorPassword, stopServer, startServer, queryFixture, removeInvitationMembership, capturedEmails }) => {
  const anonymous = await fetch(`${origin}/invite/invitation-accept`);
  assert.equal(anonymous.status, 200);
  const html = await anonymous.text();
  assert.ok(html.includes("Sign in to view your invitation"));
  assert.equal(html.includes("Other fixture"), false, "Anonymous HTML hides the invited organization");
  assert.equal(html.includes(operatorEmail), false, "Anonymous HTML hides the recipient");
  let accepts, declines;
  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    await page("Emulation.setFocusEmulationEnabled", { enabled: true });
    await page("Page.enable");
    await page("Page.addScriptToEvaluateOnNewDocument", { source: `
      window.invitationErrors=[];window.invitationRequests=[];window.invitationHeld=false;window.invitationReadHeld=false;window.invitationOpenFails=false;window.invitationCommitted=0;
      addEventListener('error',e=>window.invitationErrors.push(e.message));addEventListener('unhandledrejection',e=>window.invitationErrors.push(String(e.reason)));
      const original=window.fetch;window.fetch=(input,options)=>{const url=input instanceof Request?input.url:String(input);const ids=${JSON.stringify(ids)};
        if(window.invitationReadHeld&&url.includes(ids.getInvitationDetails))return new Promise(()=>{});
        if(window.invitationOpenFails&&url.includes(ids.setActiveOrg))return Promise.reject(new Error('Fixture workspace connection failed'));
        if(![ids.acceptInvitation,ids.rejectInvitation].some(id=>url.includes(id)))return original(input,options);
        window.invitationRequests.push({url,body:options?.body});const held=window.invitationHeld;
        const response=original(input,options);if(!held)return response;
        return response.then(async r=>{await r.clone().text();window.invitationCommitted++;return new Promise(resolve=>{window.invitationRelease=()=>resolve(r);});});
      };` });
    const check = (expression, label) => poll(() => evaluate(expression), label).catch(async error => {
      console.log(JSON.stringify({ label, body: await evaluate("document.body?.innerText"), errors: await evaluate("window.invitationErrors") }));
      await writeFile("/tmp/showpilot-invitation-response-failure.png", Buffer.from((await page("Page.captureScreenshot", { format: "png" })).data, "base64"));
      throw error;
    });
    const text = value => check(`document.body?.innerText.includes(${JSON.stringify(value)})`, value);
    const control = name => `[...document.querySelectorAll('button,a')].find(n=>n.textContent.trim()===${JSON.stringify(name)}&&!n.disabled&&n.getBoundingClientRect().height>0)`;
    const point = name => `(async()=>{const n=${control(name)};if(!n)return null;n.scrollIntoView({block:'center'});const painted=await Promise.race([new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true)))),new Promise(r=>setTimeout(()=>r(false),500))]);if(!painted)return null;for(let p=n;p;p=p.parentElement)if(p.getAnimations().some(a=>a.playState==='running'))return null;const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null})()`;
    const click = async name => {
      const p = await check(point(name), `reachable ${name}`);
      await page("Input.dispatchMouseEvent", { type: "mousePressed", ...p, button: "left", clickCount: 1 });
      await page("Input.dispatchMouseEvent", { type: "mouseReleased", ...p, button: "left", clickCount: 1 });
    };
    const geometry = async (names, label) => {
      for (const [width,height] of [[320,568],[768,1024],[1440,900]]) {
        await page("Emulation.setDeviceMetricsOverride", { width,height,deviceScaleFactor:1,mobile:false });
        for(const name of names) {
          await check(point(name), `${label} ${name} hit at ${width}`);
          await check(`(()=>{const r=(${control(name)}).getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth+1&&r.width>=44&&r.height>=44&&r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1})()`, `${label} ${name} bounds at ${width}`);
        }
        if(width===320)await writeFile(`/tmp/showpilot-invitation-response-${label}-320.png`, Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));
      }
    };
    const open = async path => { assert.deepEqual(await evaluate("window.invitationErrors ?? []"),[]); await page("Page.navigate", { url:`${origin}${path}` }); };
    const fill = async (id, value) => {
      await check(`!!document.getElementById(${JSON.stringify(id)})&&Object.keys(document.getElementById(${JSON.stringify(id)})).some(key=>key.startsWith('__reactProps'))`,`${id} hydrated`);
      await evaluate(`(()=>{const n=document.getElementById(${JSON.stringify(id)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    };
    await open("/invite/invitation-decline"); await text("Join Other fixture");
    await geometry(["Accept & Join","Decline","Check invitation status","Back to ShowPilot"],"pending");
    await click("Decline"); await text("Decline this invitation?");
    await geometry(["Cancel","Decline invitation"],"confirmation");
    for(let i=0;i<5;i++) {
      await page("Input.dispatchKeyEvent",{type:"keyDown",key:"Tab",code:"Tab",windowsVirtualKeyCode:9});
      await page("Input.dispatchKeyEvent",{type:"keyUp",key:"Tab",code:"Tab",windowsVirtualKeyCode:9});
      assert.equal(await evaluate("!!document.activeElement?.closest('[role=dialog],[role=alertdialog]')"),true);
    }
    await click("Cancel"); assert.equal(await evaluate("window.invitationRequests.length"),0);
    await evaluate("window.invitationHeld=true"); await click("Decline"); await click("Decline invitation");
    await check("window.invitationCommitted===1","real decline committed before withheld reply");
    await text("The result is unconfirmed"); await geometry(["Retry decline","Check invitation status"],"decline-recovery");
    await evaluate("window.invitationRelease();window.invitationHeld=false");
    assert.equal(await evaluate("document.body.innerText.includes('Invitation declined')"),false,"late success cannot replace recovery state");
    await click("Retry decline"); await text("Invitation declined");
    assert.equal(await evaluate("window.invitationRequests.length"),1,"retry checks and recovers the saved decision without another write");
    declines=await evaluate("window.invitationRequests");
    await open("/invite/invitation-decline");await text("Invitation declined");
    await open("/invite/invitation-accept");await text("Join Other fixture");
    await evaluate("window.invitationHeld=true"); await click("Accept & Join");
    await check("window.invitationCommitted===1","real acceptance committed before withheld reply");
    await text("The result is unconfirmed");await geometry(["Retry acceptance","Check invitation status"],"accept-recovery");
    await click("Check invitation status"); await text("Invitation accepted");
    accepts=await evaluate("window.invitationRequests");assert.equal(accepts.length,1);
    await evaluate("window.invitationRelease();window.invitationOpenFails=true");
    await click("Open workspace");await text("Fixture workspace connection failed");
    await geometry(["Retry opening workspace"],"open-recovery");
    await evaluate("window.invitationOpenFails=false");await click("Retry opening workspace");
    await check("location.pathname.startsWith('/display-other')","accepted workspace opened");
    await open("/invitations");await text("Your invitations");await text("Join Other fixture");
    await geometry(["Decline","Create your own workspace"],"list");
    await click("Decline");await click("Decline invitation");await text("Invitation declined");
    assert.equal(await evaluate("location.pathname"),"/invitations");
    await open("/invitations");await text("Your invitations");
    assert.equal(await evaluate(`!!(${control("Decline")})`),false,"saved decline does not reappear as pending after reload");
    for (const [id,heading] of [["expired","Invitation expired"],["canceled","Invitation canceled"],["wrong","This invitation is for another account"],["missing","Invitation unavailable"]]) {
      await open(`/invite/invitation-${id}`);await text(heading);await geometry(["Back to ShowPilot"],id);
    }
    await check("!!window.__TSR_ROUTER__","client router hydrated");
    await evaluate("window.invitationReadHeld=true;void window.__TSR_ROUTER__.navigate({href:'/invite/invitation-accept'});true");
    await text("Something went wrong");await geometry(["Try again"],"route-retry");
    await evaluate("window.invitationReadHeld=false");await click("Try again");await text("Invitation accepted");
    await open("/invite/invitation-wrong");await text("This invitation is for another account");await click("Use another account");
    await check("!!document.getElementById('email')","main login form");
    assert.equal(await evaluate("new URL(location.href).searchParams.get('returnTo')"),"/invite/invitation-wrong");
    await open("/invite/invitation-accept");await text("Sign in to view your invitation");await geometry(["Sign in","Create account"],"signed-out");
    await click("Sign in");await fill("email",operatorEmail);await fill("password",operatorPassword);await click("Sign in");
    await text("Invitation accepted");assert.equal(await evaluate("location.pathname"),"/invite/invitation-accept");
    await page("Page.navigate",{url:"about:blank"});await stopServer();await removeInvitationMembership();await startServer();
    await open("/invite/invitation-accept");await text("Workspace access has changed");await geometry(["Back to ShowPilot"],"access-removed");
    assert.equal(await evaluate(`!!(${control("Open workspace")})`),false);
    await evaluate("fetch('/api/auth/sign-out',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.json())");
    await open("/login?returnTo=%2Finvite%2Finvitation-unverified");await fill("email","unverified@display-smoke.invalid");await fill("password",operatorPassword);await click("Sign in");
    await text("Verify your email");
    await open("/invite/invitation-unverified");await text("Verify your email to respond");await geometry(["Verify email"],"unverified");
    assert.equal(await evaluate("document.body.innerText.includes('Other fixture')"),false);
    assert.deepEqual(await evaluate("window.invitationErrors"),[]);
  });
  await stopServer();
  const receipts=await queryFixture("SELECT invitationId,decision FROM invitation_response ORDER BY invitationId");
  assert.deepEqual(receipts,[{invitationId:"invitation-accept",decision:"accepted"},{invitationId:"invitation-decline",decision:"rejected"},{invitationId:"invitation-list",decision:"rejected"}]);
  assert.equal((await queryFixture("SELECT COUNT(*) AS count FROM member WHERE organizationId='display-other' AND userId='smoke-operator'"))[0].count,0);
  assert.equal((await queryFixture("SELECT COUNT(*) AS count FROM member WHERE organizationId='display-smoke' AND userId='smoke-operator'"))[0].count,1);
  assert.equal((await capturedEmails()).length,0);
  console.log(JSON.stringify({result:"passed",anonymousDetailsHidden:true,declineSaved:true,confirmation:true,committedReplyRecovery:true,lateRepliesIgnored:true,explicitWorkspaceOpen:true,listDeclineSaved:true,signInReturn:true,removedAccess:true,unverifiedReadOnly:true,receipts,acceptRequests:accepts.length,declineRequests:declines.length,widths:[320,768,1440],browserErrors:[],externalEmail:0}));
}, {invitationResponses:true,unverifiedOperator:true,captureEmail:true});
