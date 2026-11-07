// Compiled app, real Chrome/auth/D1, disposable organization. Only the browser
// transport is faulted; all Team commands run against the real endpoints.
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";
const assets = resolve(import.meta.dirname, "../dist/server/assets"), ids = {};
const functions = ["updateMemberRole", "removeMember", "cancelInvitation", "closeContentReport", "getOrgMembers"];
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
      console.log(JSON.stringify({ label, body: await evaluate("document.body?.innerText"), errors: await evaluate("window.teamErrors") }));
      await writeFile("/tmp/showpilot-team-recovery-failure.png", Buffer.from((await page("Page.captureScreenshot", { format: "png" })).data, "base64")); throw error;
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
    const selectRole = async role => {
      await check("document.querySelector('select[aria-label=\"Role for Second fixture operator\"]')?.disabled===false", "role control ready");
      await evaluate(`(()=>{const n=document.querySelector('select[aria-label="Role for Second fixture operator"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(n,${JSON.stringify(role)});n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    };
    const tab = async label => { await evaluate(`(()=>{const n=[...document.querySelectorAll('[role=tab]')].find(n=>n.textContent.includes(${JSON.stringify(label)}));n.focus();})()`); await key("Enter", "Enter", 13); await check(`document.querySelector('[role=tab][aria-selected=true]')?.textContent.includes(${JSON.stringify(label)})`, `${label} selected`); };
    await page("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page("Page.navigate", { url: `${origin}/${orgId}/team` });
    await check("!!document.querySelector('[role=tablist]')", "Team rendered"); await ready();
    for (const [width, height] of [[320,780],[768,1024],[1440,1000]]) {
      await page("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await check(width < 1024 ? "!!document.querySelector('button[aria-label=\"Open menu\"]')&&!document.querySelector('aside[aria-hidden=\"false\"]')" : "!document.querySelector('button[aria-label=\"Open menu\"]')", `responsive navigation ${width}`);
      await ready();
      await check(`(()=>{const nodes=[...document.querySelectorAll('[role=tabpanel]:not([hidden]) button,[role=tabpanel]:not([hidden]) select')];return nodes.length>=4&&nodes.every(n=>{const b=n.getBoundingClientRect();return !n.disabled&&b.height>=44&&b.width>=44&&b.left>=0&&b.right<=innerWidth;})&&document.documentElement.scrollWidth<=innerWidth+1;})()`, `member controls ${width}`);
      if (width === 320) await writeFile("/tmp/showpilot-team-recovery-320.png", Buffer.from((await page("Page.captureScreenshot", { format: "png" })).data, "base64"));
    }
    await hold("updateMemberRole"); await selectRole("tm");
    await check("window.teamReplies.some(r=>r.kind==='updateMemberRole'&&r.status===200)", "role committed with reply withheld");
    const newer = await evaluate(`fetch('/api/auth/organization/update-member-role',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({organizationId:${JSON.stringify(orgId)},memberId:'smoke-second-member',role:'pm'})}).then(async r=>({status:r.status,body:await r.json()}))`);
    assert.equal(newer.status, 200);
    await tab("Reports"); await retry("updateMemberRole"); await tab("Members");
    await check("document.querySelector('select[aria-label=\"Role for Second fixture operator\"]')?.value==='pm'", "old retry preserves newer role");
    await evaluate("window.teamReplies.forEach(r=>r.release())"); await ready();
    await hold("getOrgMembers"); await selectRole("tm");
    await check(`${button("Retry refresh")}!=null`, "confirmed write with timed-out refresh");
    const writes = await evaluate("window.teamRequests.filter(r=>r.kind==='updateMemberRole').length");
    await hold(null); await click("Retry refresh"); await ready();
    assert.equal(await evaluate("window.teamRequests.filter(r=>r.kind==='updateMemberRole').length"), writes);
    await click("Cancel invitation for invited@display-smoke.invalid"); await click("Keep invitation"); await ready();
    assert.equal(await evaluate("window.teamRequests.filter(r=>r.kind==='cancelInvitation').length"), 0);
    await hold("cancelInvitation"); await click("Cancel invitation for invited@display-smoke.invalid"); await click("Cancel invitation");
    await check(`${button("Retry change")}!=null`, "cancel reply deadline");
    await click("Songs"); await check("document.body.innerText.includes('Leave Team?')", "unconfirmed change blocks navigation"); await click("Stay");
    await retry("cancelInvitation"); await check("!document.body.innerText.includes('invited@display-smoke.invalid')", "cancelled invitation removed");
    await tab("Members"); await key("End", "End", 35);
    await check("document.activeElement?.getAttribute('role')==='tab'&&document.activeElement.textContent.includes('Reports')&&document.activeElement.getAttribute('aria-selected')==='true'", "End selects and focuses Reports");
    await key("Home", "Home", 36); await check("document.activeElement.textContent.includes('Members')", "Home returns to Members");
    await key("ArrowLeft", "ArrowLeft", 37); await check("document.activeElement.textContent.includes('Reports')", "Left wraps to Reports");
    await hold("closeContentReport"); await click("Mark resolved"); await key("Tab", "Tab", 9);
    await check("!!document.activeElement.closest('[role=dialog]')", "moderation confirmation traps focus");
    await key("Escape", "Escape", 27); await ready(); assert.equal(await evaluate("window.teamRequests.filter(r=>r.kind==='closeContentReport').length"), 0);
    await click("Mark resolved"); await click("Resolve report"); await retry("closeContentReport");
    await check("document.body.innerText.includes('No open content reports')", "report closes after confirmation");
    await tab("Members"); await hold("removeMember"); await click("Remove Second fixture operator"); await click("Remove member"); await retry("removeMember");
    await check("!document.body.innerText.includes('Second fixture operator')", "removed membership stays removed");
    assert.deepEqual(await evaluate("window.teamErrors"), []);
  });
  await stopServer();
  const receipts = await queryFixture("SELECT result FROM team_command_receipt WHERE orgId='display-smoke'"); assert.equal(receipts.length, 6);
  const members = await queryFixture("SELECT id,role FROM member WHERE organizationId='display-smoke'"); assert.deepEqual(members, [{ id: "smoke-member", role: "owner" }]);
  const invitations = await queryFixture("SELECT status FROM invitation WHERE organizationId='display-smoke'"); assert.deepEqual(invitations, [{ status: "canceled" }]);
  const reports = await queryFixture("SELECT status,reviewedBy FROM content_report WHERE orgId='display-smoke'"); assert.deepEqual(reports, [{ status: "resolved", reviewedBy: "smoke-operator" }]);
  console.log(JSON.stringify({ receipts: receipts.length, remainingMembers: members.length, checks: "lost replies, newer role preservation, refresh-only retry, confirmations, keyboard, navigation, 320/768/1440px" }));
}, { secondOperator: true, secondOperatorMember: true, teamRecovery: true });
