// Compiled app, real Chrome/auth/D1, disposable organization. Only the browser
// transport is faulted; all Team commands run against the real endpoints.
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";
const assets = resolve(import.meta.dirname, "../dist/server/assets"), ids = {};
const functions = ["addCrewMember", "updateCrewMember", "deleteCrewMember", "getCrewMembers"];
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
      await writeFile("/tmp/showpilot-crew-roster-failure.png", Buffer.from((await page("Page.captureScreenshot", { format: "png" })).data, "base64")); throw error;
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
      await check(`([...document.querySelectorAll('label')].find(n=>n.textContent.trim()===${JSON.stringify(label)}))?.control!=null`, `field ${label}`);
      await evaluate(`(()=>{const n=[...document.querySelectorAll('label')].find(n=>n.textContent.trim()===${JSON.stringify(label)}).control;Object.getOwnPropertyDescriptor(n.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event(n.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);
    };
    const form = () => check("document.querySelector('[role=dialog]')?.textContent.includes('crew member')", "crew editor");
    const value = label => evaluate(`([...document.querySelectorAll('label')].find(n=>n.textContent.trim()===${JSON.stringify(label)}))?.control.value`);
    await page("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page("Page.navigate", { url: `${origin}/${orgId}/team` });
    await check("!!document.querySelector('[role=tablist]')", "Team rendered"); await ready(); await tab("Crew");
    for (const [width,height] of [[320,780],[768,1024],[1440,1000]]) {
      await page("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await check(width < 1024 ? "!!document.querySelector('button[aria-label=\"Open menu\"]')&&!document.querySelector('aside[aria-hidden=\"false\"]')" : "!document.querySelector('button[aria-label=\"Open menu\"]')", `responsive navigation ${width}`);
      await check(`(()=>{const nodes=[...document.querySelectorAll('[role=tabpanel]:not([hidden]) button')].filter(n=>n.getBoundingClientRect().height>0);return nodes.length>=4&&nodes.every(n=>{const b=n.getBoundingClientRect();return b.height>=44&&b.width>=44&&b.left>=0&&b.right<=innerWidth;})&&document.documentElement.scrollWidth<=innerWidth+1;})()`, `crew controls ${width}`);
      await click("Add crew member"); await form();
      await fill("Member ID", "CAM99"); await fill("Full Name", "Retained fixture crew"); await fill("Role", "Camera Operator");
      await check(`(()=>{const d=document.querySelector('[role=dialog]'),b=d.getBoundingClientRect();return b.left>=0&&b.right<=innerWidth&&b.top>=0&&b.bottom<=innerHeight&&d.scrollWidth<=d.clientWidth+1&&[...d.querySelectorAll('button,input:not([type=file]),select')].every(n=>{const r=n.getBoundingClientRect();return r.height>=44&&r.width>=44;});})()`, `crew editor controls ${width}`);
      if(width===320) await writeFile("/tmp/showpilot-crew-roster-320.png",Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));
      await key("Tab", "Tab", 9); await check("!!document.activeElement.closest('[role=dialog]')", "editor focus trap");
      await key("Escape", "Escape", 27); await ready();
      await check("document.activeElement?.textContent.trim()==='Add crew member'", "editor returns focus");
      await tab("Members"); await tab("Crew"); await click("Resume draft"); await form();
      assert.equal(await value("Full Name"), "Retained fixture crew");
      await click("Close editor"); await ready();
      if(width!==1440) { await click("Discard draft"); await click("Discard draft"); await ready(); }
    }
    await click("Songs"); await check("document.body.innerText.includes('Leave Team?')", "crew draft blocks navigation"); await click("Stay"); await ready();
    await click("Resume draft"); await form(); await hold("addCrewMember"); await click("Add crew member");
    await check("window.teamReplies.some(r=>r.kind==='addCrewMember'&&r.status===200)", "crew insert committed with lost reply");
    await tab("Members"); await retry("addCrewMember"); await tab("Crew");
    await check("document.body.innerText.includes('Retained fixture crew')&&!document.body.innerText.includes('Crew draft:')", "creation confirmed once");
    await hold("updateCrewMember"); await click("Edit Retained fixture crew"); await form(); await fill("Full Name", "First fixture edit"); await click("Save crew member");
    await check("window.teamReplies.some(r=>r.kind==='updateCrewMember'&&r.status===200)", "edit committed with lost reply");
    const newer = await evaluate(`(async()=>{const list=await fetch('/api/mobile/v1/team/crew?orgId=${orgId}').then(r=>r.json());const crew=list.members.find(m=>m.memberId==='CAM99');const response=await fetch('/api/mobile/v1/team/crew/'+crew.id+'/update?orgId=${orgId}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...crew,name:'Newer native edit',requestId:crypto.randomUUID(),expectedRevision:crew.profileRevision})});return response.status;})()`);
    assert.equal(newer,200); await retry("updateCrewMember");
    await check("document.body.innerText.includes('Newer native edit')", "old retry preserves newer native edit");
    await evaluate("window.teamReplies.forEach(r=>r.release())"); await ready();
    await click("Edit Newer native edit"); await form(); await fill("Full Name", "Confirmed refresh edit"); await hold("getCrewMembers"); await click("Save crew member");
    await check(`${button("Retry refresh")}!=null`, "saved edit with failed roster refresh");
    const writes=await evaluate("window.teamRequests.filter(r=>r.kind==='updateCrewMember').length");
    await hold(null); await click("Retry refresh"); await ready();
    assert.equal(await evaluate("window.teamRequests.filter(r=>r.kind==='updateCrewMember').length"),writes);
    await click("Remove Confirmed refresh edit"); await click("Cancel"); await ready();
    assert.equal(await evaluate("window.teamRequests.filter(r=>r.kind==='deleteCrewMember').length"),0);
    await hold("deleteCrewMember"); await click("Remove Confirmed refresh edit"); await click("Remove crew member");
    await retry("deleteCrewMember"); await check("!document.body.innerText.includes('Confirmed refresh edit')", "removal confirmed");
    assert.deepEqual(await evaluate("window.teamErrors"),[]);
  });
  await stopServer();
  const receipts=await queryFixture("SELECT kind FROM crew_write_receipt WHERE orgId='display-smoke' ORDER BY createdAt,rowid");
  assert.deepEqual(receipts.map(row=>row.kind),["create","update","update","update","delete"]);
  const crew=await queryFixture("SELECT id FROM crew_member WHERE orgId='display-smoke'"); assert.equal(crew.length,2);
  console.log(JSON.stringify({ receipts:receipts.length, remainingCrew:crew.length, checks:"real create/edit/delete with lost replies, newer native edit preserved, refresh-only retry, drafts, focus/Escape, navigation and 320/768/1440px" }));
}, { publicCheckInMembers:true });
