// Compiled app, real Chrome/auth/D1, disposable organization. Browser replies
// and the isolated email provider are faulted; application endpoints run unchanged.
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";
const assets = resolve(import.meta.dirname, "../dist/server/assets"), ids = {};
const functions = ["inviteMember", "retryTeamInvitationDelivery", "getOrgInvitations"];
for (const name of (await readdir(assets)).filter(name => name.endsWith(".js"))) {
  const source = await readFile(resolve(assets, name), "utf8");
  for (const fn of functions) ids[fn] ??= source.match(new RegExp(`const ${fn}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`))?.[1];
}
for (const fn of functions) assert.ok(ids[fn], fn);
await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, stopServer, queryFixture, configureEmail, capturedEmails }) => {
  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    await page("Emulation.setFocusEmulationEnabled", { enabled: true }); await page("Page.enable");
    await page("Page.addScriptToEvaluateOnNewDocument", { source: `window.teamErrors=[];window.teamRequests=[];window.teamHold=null;window.teamReplies=[];
      addEventListener('error',e=>window.teamErrors.push(e.message));addEventListener('unhandledrejection',e=>window.teamErrors.push(String(e.reason)));
      const original=window.fetch;window.fetch=(input,options)=>{const url=input instanceof Request?input.url:String(input);const kind=Object.entries(${JSON.stringify(ids)}).find(([kind,id])=>url.includes(id))?.[0];if(!kind)return original(input,options);window.teamRequests.push({kind,body:options?.body});const held=window.teamHold===kind;return original(input,options).then(async response=>{if(!held)return response;const body=await response.text();return new Promise(resolve=>window.teamReplies.push({kind,status:response.status,release:()=>resolve(new Response(body,{status:response.status,headers:response.headers}))}));});};` });
    const check = (code, label) => poll(() => evaluate(code), label).catch(async error => {
      console.log(JSON.stringify({ label, body: await evaluate("document.body?.innerText"), errors: await evaluate("window.teamErrors") }));
      await writeFile("/tmp/showpilot-team-invitations-failure.png", Buffer.from((await page("Page.captureScreenshot", { format: "png" })).data, "base64")); throw error;
    });
    const button = name => `[...([...document.querySelectorAll('[role=dialog]')].at(-1)??(window.invitationTarget?[...document.querySelectorAll('article')].find(n=>n.getAttribute('aria-label')==='Invitation for '+window.invitationTarget):document)).querySelectorAll('button,a')].find(n=>(n.textContent.trim()===${JSON.stringify(name)}||n.getAttribute('aria-label')===${JSON.stringify(name)})&&n.getBoundingClientRect().height>0&&!n.disabled)`;
    const click = async name => {
      const point = await check(`(async()=>{const n=${button(name)};if(!n||!Object.keys(n).some(k=>k.startsWith('__reactProps'))||n.closest('[role=dialog]')?.getAnimations().some(a=>a.playState==='running'))return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return !n.disabled&&n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`, name);
      await page("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 }); await page("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
    };
    const key = async (key, code, windowsVirtualKeyCode) => { await page("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode, ...(key === "Enter" ? { text: "\r" } : {}) }); await page("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode }); };
    const ready = () => check("!document.querySelector('[role=dialog]')&&!document.querySelector('[aria-label=\"Team change\"]')&&!document.body.innerText.includes('Refreshing team')&&!document.body.innerText.includes('Refreshing invitations')", "team confirmed and refreshed");
    const hold = kind => evaluate(`window.teamHold=${JSON.stringify(kind)}`);
    const retry = async kind => {
      await check(`${button("Retry change")}!=null`, "bounded Team failure"); await hold(null); await click("Retry change"); await ready();
      const bodies = await evaluate(`window.teamRequests.filter(r=>r.kind===${JSON.stringify(kind)}).map(r=>r.body)`);
      assert.equal(bodies.at(-1), bodies.at(-2), `${kind} retains its exact retry payload`);
    };
    const selectRole = async role => {
      await check("document.querySelector('select[aria-label=\"Role for Second fixture operator\"]')?.disabled===false", "role control ready");
      await evaluate(`(()=>{const n=document.querySelector('select[aria-label="Role for Second fixture operator"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(n,${JSON.stringify(role)});n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    };
    const tab = async label => { await evaluate(`(()=>{const n=[...document.querySelectorAll('[role=tab]')].find(n=>n.textContent.includes(${JSON.stringify(label)}));n.focus();})()`); await key("Enter", "Enter", 13); await check(`document.querySelector('[role=tab][aria-selected=true]')?.textContent.includes(${JSON.stringify(label)})`, `${label} selected`); };
    const target = email => evaluate(`window.invitationTarget=${JSON.stringify(email)}`);
    const fill = email => evaluate(`(()=>{const n=[...document.querySelectorAll('form input[type=email]')].find(n=>n.getBoundingClientRect().height>0);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(email)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    const rowText = (email, text) => check(`[...document.querySelectorAll('article')].some(n=>n.getAttribute('aria-label')==='Invitation for '+${JSON.stringify(email)}&&n.textContent.includes(${JSON.stringify(text)}))`, `${email}: ${text}`);
    await page("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page("Page.navigate", { url: `${origin}/${orgId}/team` });
    await check("!!document.querySelector('[role=tablist]')", "Team rendered"); await ready();
    await click("Invite Member"); await fill("first@display-smoke.invalid");
    await click("Close invitation form"); await click("Resume invitation");
    assert.equal(await evaluate("document.querySelector('input[type=email]').value"), "first@display-smoke.invalid");
    await hold("inviteMember"); await click("Create invitation");
    await check("window.teamReplies.some(r=>r.kind==='inviteMember'&&r.status===200)", "creation committed with reply withheld");
    await tab("Content reports"); await retry("inviteMember"); await tab("Workspace members");
    await evaluate("window.teamReplies.forEach(r=>r.release())"); await ready();
    assert.equal((await capturedEmails()).length, 1);
    await rowText("first@display-smoke.invalid", "Email provider accepted");
    // A provider that accepted mail but lost its reply is retried with the same
    // body/key; the isolated provider records one accepted email, two requests.
    await configureEmail("lose-reply"); await fill("second@display-smoke.invalid"); await click("Create invitation"); await ready();
    await rowText("second@display-smoke.invalid", "Email acceptance is unknown");
    await configureEmail("success"); await target("second@display-smoke.invalid"); await click("Retry email"); await ready();
    await rowText("second@display-smoke.invalid", "Email provider accepted");
    let emails = await capturedEmails(); assert.equal(emails.length, 3); assert.equal(emails[2].replayed, true); assert.equal(emails[1].idempotencyKey, emails[2].idempotencyKey);
    await click("Send again"); await key("Escape", "Escape", 27); await ready(); assert.equal((await capturedEmails()).length, 3);
    await hold("getOrgInvitations"); await click("Send again"); await click("Send again"); await target(null);
    await check(`${button("Retry refresh")}!=null`, "acknowledged resend with lost list refresh");
    await hold(null); await click("Retry refresh"); await ready();
    emails = await capturedEmails(); assert.equal(emails.length, 4); assert.notEqual(emails[3].idempotencyKey, emails[2].idempotencyKey);
    await evaluate("window.teamReplies.forEach(r=>r.release())");
    await target("first@display-smoke.invalid");
    await evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>Promise.reject(new Error('Fixture clipboard denied'))}})");
    await click("Copy invitation link for first@display-smoke.invalid"); await rowText("first@display-smoke.invalid", "Could not copy");
    await evaluate("navigator.clipboard.writeText=async value=>{window.copiedInvitation=value}"); await click("Copy invitation link for first@display-smoke.invalid");
    await rowText("first@display-smoke.invalid", "Copied"); assert.ok((await evaluate("window.copiedInvitation")).startsWith(`${origin}/invite/`));
    await target(null);
    await fill("layout@display-smoke.invalid");
    for (const [width,height] of [[320,780],[768,1024],[1440,1000]]) {
      await page("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await check(width < 1024 ? "!!document.querySelector('button[aria-label=\"Open menu\"]')" : "!document.querySelector('button[aria-label=\"Open menu\"]')", `navigation layout ${width}`);
      await ready();
      await check("(()=>{const nodes=[...document.querySelectorAll('article button,form input,form select,form button')].filter(n=>n.getBoundingClientRect().height>0);return nodes.length>=8&&nodes.every(n=>{const b=n.getBoundingClientRect();return !n.disabled&&b.height>=44&&b.width>=44&&b.left>=0&&b.right<=innerWidth;})&&document.documentElement.scrollWidth<=innerWidth+1;})()", `invitation controls ${width}`);
      if(width===320)await writeFile("/tmp/showpilot-team-invitations-320.png", Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));
    }
    await fill("");
    await check("[...document.querySelectorAll('button')].some(n=>n.textContent.trim()==='Create invitation'&&n.disabled)", "layout draft cleared");
    assert.deepEqual(await evaluate("window.teamErrors"), []);
    // Settings uses the same controls and reports a definite provider rejection.
    await configureEmail("fail");
    await page("Page.navigate", { url: `${origin}/${orgId}/settings?section=team` });
    await check("document.body.innerText.includes('Team & Roles')", "Settings team section"); await ready();
    await click("Invite Member"); await fill("settings@display-smoke.invalid");
    await click("Organization"); await check("document.body.innerText.includes('Leave Settings?')", "Settings draft blocks accidental navigation"); await click("Stay");
    await click("Create invitation"); await ready(); await rowText("settings@display-smoke.invalid", "email was rejected");
    await configureEmail("success"); await target("settings@display-smoke.invalid"); await click("Retry email"); await ready(); await rowText("settings@display-smoke.invalid", "Email provider accepted");
    assert.deepEqual(await evaluate("window.teamErrors"), []);
  });
  const emails = await capturedEmails();
  assert.equal(emails.length, 6); assert.equal(emails.filter(email=>email.delivered&&!email.replayed).length, 4);
  await stopServer();
  const invitations = await queryFixture("SELECT id,email,status FROM invitation WHERE organizationId='display-smoke'"); assert.equal(invitations.length, 3); assert.ok(invitations.every(row=>row.status==='pending'));
  const deliveries = await queryFixture("SELECT state FROM team_invitation_delivery WHERE orgId='display-smoke'"); assert.equal(deliveries.length, 4); assert.ok(deliveries.every(row=>row.state==='accepted'));
  const receipts = await queryFixture("SELECT requestId FROM team_invitation_request WHERE orgId='display-smoke'"); assert.equal(receipts.length, 4);
  console.log(JSON.stringify({ invitations: invitations.length, deliveries: deliveries.length, receipts: receipts.length, providerRequests: emails.length, acceptedEmails: 4, checks: "lost creation/provider replies, exact retry, explicit resend, refresh-only retry, clipboard recovery, Settings, 320/768/1440px" }));
}, { captureEmail: true, paidPlan: true });
