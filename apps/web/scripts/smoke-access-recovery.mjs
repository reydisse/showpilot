// Compiled app, real Chrome/auth/D1, disposable organization. Only the browser
// transport is faulted; all Team commands run against the real endpoints.
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";
const assets = resolve(import.meta.dirname, "../dist/server/assets"), ids = {};
const functions = ["grantMemberAccess", "revokeMemberAccess", "retryAccessGrantNotification", "getAccessManagementSnapshot"];
for (const name of (await readdir(assets)).filter(name => name.endsWith(".js"))) {
  const source = await readFile(resolve(assets, name), "utf8");
  for (const fn of functions) ids[fn] ??= source.match(new RegExp(`const ${fn}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`))?.[1];
}
for (const fn of functions) assert.ok(ids[fn], fn);
await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, stopServer, queryFixture }) => {
  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    await page("Emulation.setFocusEmulationEnabled", { enabled: true }); await page("Page.enable");
    await page("Page.addScriptToEvaluateOnNewDocument", { source: `window.teamErrors=[];window.teamRequests=[];window.teamHold=null;window.teamReplies=[];
      addEventListener('error',e=>window.teamErrors.push(e.message));addEventListener('unhandledrejection',e=>window.teamErrors.push(String(e.reason)));
      const original=window.fetch;window.fetch=(input,options)=>{const url=input instanceof Request?input.url:String(input);const kind=Object.entries(${JSON.stringify(ids)}).find(([kind,id])=>url.includes(id))?.[0];if(!kind)return original(input,options);window.teamRequests.push({kind,body:options?.body});const held=window.teamHold===kind;return original(input,options).then(async response=>{if(!held)return response;const body=await response.text();return new Promise(resolve=>window.teamReplies.push({kind,status:response.status,release:()=>resolve(new Response(body,{status:response.status,headers:response.headers}))}));});};` });
    const check = (code, label) => poll(() => evaluate(code), label).catch(async error => {
      console.log(JSON.stringify({ label, body: await evaluate("document.body?.innerText"), errors: await evaluate("window.teamErrors"), controls: await evaluate("[...document.querySelectorAll('[role=tabpanel]:not([hidden]) button,[role=dialog] button,[role=dialog] input,[role=dialog] select')].map(n=>({label:n.textContent||n.getAttribute('aria-label'),box:n.getBoundingClientRect().toJSON()}))") }));
      await writeFile("/tmp/showpilot-access-recovery-failure.png", Buffer.from((await page("Page.captureScreenshot", { format: "png" })).data, "base64")); throw error;
    });
    const button = name => `[...([...document.querySelectorAll('[role=dialog]')].at(-1)??document).querySelectorAll('button,a')].find(n=>(n.textContent.trim()===${JSON.stringify(name)}||n.getAttribute('aria-label')===${JSON.stringify(name)})&&n.getBoundingClientRect().height>0&&!n.disabled)`;
    const click = async name => {
      const point = await check(`(async()=>{const n=${button(name)};if(!n||!Object.keys(n).some(k=>k.startsWith('__reactProps'))||n.closest('[role=dialog]')?.getAnimations().some(a=>a.playState==='running'))return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return !n.disabled&&n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`, name);
      await page("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 }); await page("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
    };
    const key = async (key, code, windowsVirtualKeyCode) => { await page("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode, ...(key === "Enter" ? { text: "\r" } : {}) }); await page("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode }); };
    const ready = () => check("!document.querySelector('[role=dialog]')&&!document.querySelector('[aria-label=\"Team change\"]')&&!document.body.innerText.includes('Refreshing team')", "team confirmed and refreshed");
    const hold = kind => evaluate(`window.teamHold=${JSON.stringify(kind)}`);
    const retry = async kind => {
      await check(`${button("Retry change")}!=null`, "bounded Team failure"); await hold(null); await click("Retry change"); await ready();
      const bodies = await evaluate(`window.teamRequests.filter(r=>r.kind===${JSON.stringify(kind)}).map(r=>r.body)`);
      assert.equal(bodies.at(-1), bodies.at(-2), `${kind} retains its exact retry payload`);
    };
    const tab = async label => { await check(`(()=>{const n=[...document.querySelectorAll('[role=tab]')].find(n=>n.textContent.includes(${JSON.stringify(label)}));return n&&Object.keys(n).some(k=>k.startsWith('__reactProps'));})()`, `${label} hydrated`); await evaluate(`(()=>{const n=[...document.querySelectorAll('[role=tab]')].find(n=>n.textContent.includes(${JSON.stringify(label)}));n.focus();})()`); await key("Enter", "Enter", 13); await check(`document.querySelector('[role=tab][aria-selected=true]')?.textContent.includes(${JSON.stringify(label)})`, `${label} selected`); };
    const fill = async (label, value) => {
      await check(`([...document.querySelectorAll('label')].find(n=>[...n.childNodes].some(t=>t.nodeType===3&&t.textContent.trim()===${JSON.stringify(label)})))?.control!=null`, `field ${label}`);
      await evaluate(`(()=>{const n=[...document.querySelectorAll('label')].find(n=>[...n.childNodes].some(t=>t.nodeType===3&&t.textContent.trim()===${JSON.stringify(label)})).control;Object.getOwnPropertyDescriptor(n.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event(n.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);
    };
    await page("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page("Page.navigate", { url: `${origin}/${orgId}/team` });
    await check("!!document.querySelector('[role=tablist]')", "Team rendered"); await ready(); await tab("Access grants");
    await click("Grant access"); await fill("Capability", "rundown-operator"); await fill("Reason", "Browser recovery fixture");
    for (const [width,height] of [[320,780],[768,1024],[1440,1000]]) {
      await page("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await check(width < 1024 ? "!!document.querySelector('button[aria-label=\"Open menu\"]')&&!document.querySelector('aside[aria-hidden=\"false\"]')" : "!document.querySelector('button[aria-label=\"Open menu\"]')", `responsive navigation ${width}`);
      await check(`(()=>{const nodes=[...document.querySelectorAll('[role=tabpanel]:not([hidden]) button,[role=tabpanel]:not([hidden]) select,[role=tabpanel]:not([hidden]) input:not([type=radio]):not([type=checkbox])')].filter(n=>n.getBoundingClientRect().height>0);return nodes.length>=6&&nodes.every(n=>{const b=n.getBoundingClientRect();return b.height>=44&&b.width>=44&&b.left>=0&&b.right<=innerWidth;})&&document.documentElement.scrollWidth<=innerWidth+1;})()`, `access controls ${width}`);
      if(width===320) await writeFile("/tmp/showpilot-access-recovery-320.png",Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));
    }
    await click("Close grant form");
    await check("document.activeElement?.textContent.trim()==='Resume access draft'", "draft close restores focus");
    await tab("Workspace members"); await tab("Access grants"); await click("Resume access draft");
    assert.equal(await evaluate("document.querySelector('[role=tabpanel]:not([hidden]) input[maxlength]')?.value"),"Browser recovery fixture");
    await click("Songs"); await check("document.body.innerText.includes('Leave Team?')", "access draft blocks navigation"); await click("Stay"); await ready();
    await hold("grantMemberAccess"); await click("Grant access");
    await check("window.teamReplies.some(r=>r.kind==='grantMemberAccess'&&r.status===200)", "grant committed with reply withheld");
    const revokeStatus = await evaluate(`(async()=>{const list=await fetch('/api/mobile/v1/team/access?orgId=${orgId}').then(r=>r.json());const grant=list.grants.find(g=>g.capability==='rundown-operator');return (await fetch('/api/mobile/v1/team/access/grants/'+grant.id+'/revoke?orgId=${orgId}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:crypto.randomUUID()})})).status;})()`);
    assert.equal(revokeStatus,200); await tab("Workspace members"); await retry("grantMemberAccess"); await tab("Access grants");
    await check("document.body.innerText.includes('no longer active')&&document.body.innerText.includes('No custom access is active')", "old retry cannot recreate revoked access");
    await evaluate("window.teamReplies.forEach(r=>r.release())"); await ready();
    await click("Grant access"); await fill("Capability", "rundown-operator"); await fill("Reason", "Confirmed grant");
    await hold("getAccessManagementSnapshot"); await click("Grant access");
    await check(`${button("Retry refresh")}!=null`, "saved grant with refresh deadline");
    const writes=await evaluate("window.teamRequests.filter(r=>r.kind==='grantMemberAccess').length");
    await hold(null); await click("Retry refresh"); await ready();
    assert.equal(await evaluate("window.teamRequests.filter(r=>r.kind==='grantMemberAccess').length"),writes);
    await click("Revoke"); await key("Tab", "Tab", 9);
    await check("!!document.activeElement.closest('[role=dialog]')", "revoke confirmation traps focus");
    await key("Escape", "Escape", 27); await ready();
    assert.equal(await evaluate("window.teamRequests.filter(r=>r.kind==='revokeMemberAccess').length"),0);
    await hold("revokeMemberAccess"); await click("Revoke"); await click("Revoke access"); await retry("revokeMemberAccess");
    await check("document.body.innerText.includes('No custom access is active')", "revocation confirmed");
    assert.deepEqual(await evaluate("window.teamErrors"),[]);
  });
  await stopServer();
  const receipts=await queryFixture("SELECT kind FROM access_write_receipt WHERE orgId='display-smoke' ORDER BY createdAt,rowid");
  assert.deepEqual(receipts.map(row=>row.kind),["grant","revoke","grant","revoke"]);
  const active=await queryFixture("SELECT id FROM member_permission_grant WHERE orgId='display-smoke' AND revokedAt IS NULL"); assert.equal(active.length,0);
  const notices=await queryFixture("SELECT id FROM notification WHERE orgId='display-smoke' AND type='access-grant'"); assert.equal(notices.length,4);
  console.log(JSON.stringify({receipts:receipts.length,active:active.length,notifications:notices.length,checks:"exact retry after revocation, refresh-only retry, confirmation, retained drafts, keyboard, navigation and 320/768/1440px"}));
}, { secondOperator:true, secondOperatorMember:true });
