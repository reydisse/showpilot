// Real signup-session permissions, D1 receipts, email hook and compiled setup UI.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";
const require = createRequire(new URL("../package.json", import.meta.url));
const router = createRequire(require.resolve("@tanstack/react-router"));
const core = createRequire(router.resolve("@tanstack/router-core"));
const { toJSONAsync, fromCrossJSON } = core("seroval");
const { defaultSerovalPlugins } = router("@tanstack/router-core");
const ids = {}, names = ["saveSetupTeam", "getSetupTeam", "sendSetupInvitation", "finishSetupTeam"];
const assets = resolve(import.meta.dirname, "../dist/server/assets");
for (const file of (await readdir(assets)).filter(file => file.endsWith(".js"))) {
  const source = await readFile(resolve(assets, file), "utf8");
  assert.doesNotMatch(source, /const completeOnboarding_createServerFn_handler/, "Unchecked completion RPC must be removed");
  for (const name of names) ids[name] ??= source.match(new RegExp(`const ${name}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`))?.[1];
}
assert.ok(names.every(name => ids[name]));
for (const scenario of ["recover", "skip"]) await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, configureEmail, capturedEmails, stopServer, queryFixture }) => {
  const snapshot = async () => {
    const payload = JSON.stringify(await toJSONAsync({ data: { orgId } }));
    const response = await fetch(`${origin}/_serverFn/${ids.getSetupTeam}?payload=${encodeURIComponent(payload)}`, { headers: { Cookie: operatorCookie, Origin: origin, "x-tsr-serverFn": "true" } });
    assert.equal(response.status, 200); const reply = fromCrossJSON(await response.json(), { refs: new Map(), plugins: defaultSerovalPlugins });
    assert.equal(reply.error, undefined); return reply.result;
  };
  await configureEmail("fail");
  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    await page("Page.enable");
    await page("Page.addScriptToEvaluateOnNewDocument", { source: `
      window.setupErrors=[];window.setupCalls={save:0,send:0,finish:0};window.setupFault='none';
      addEventListener('error',event=>window.setupErrors.push(event.message));
      addEventListener('unhandledrejection',event=>window.setupErrors.push(String(event.reason)));
      const original=window.fetch;
      window.fetch=async(input,options)=>{
        const url=input instanceof Request?input.url:String(input);
        const kind=url.includes(${JSON.stringify(ids.saveSetupTeam)})?'save':url.includes(${JSON.stringify(ids.sendSetupInvitation)})?'send':url.includes(${JSON.stringify(ids.finishSetupTeam)})?'finish':null;
        if(kind)window.setupCalls[kind]++;
        if(kind==='save'&&window.setupFault==='reject-save')return new Response('Fixture rejected before save',{status:503});
        const response=await original(input,options);
        if((kind==='save'&&window.setupFault==='hold-save')||(kind==='finish'&&window.setupFault==='hold-finish')){
          const body=await response.text();window.setupCommitted={kind,status:response.status};
          return new Promise(resolve=>{window.releaseSetupReply=()=>resolve(new Response(body,{status:response.status,headers:response.headers}));});
        }
        return response;
      };` });
    const check = (expression, label, timeout) => poll(() => evaluate(expression), label, timeout).catch(async error => {
      console.log(JSON.stringify({ scenario, label, body: await evaluate("document.body?.innerText"), calls: await evaluate("window.setupCalls") }));
      await writeFile(`/tmp/showpilot-setup-save-${scenario}-failure.png`, Buffer.from((await page("Page.captureScreenshot", { format: "png" })).data, "base64")); throw error;
    });
    const text = value => check(`document.body?.innerText.toLowerCase().includes(${JSON.stringify(value.toLowerCase())})`, value);
    const click = async name => {
      const point = await poll(() => evaluate(`(async()=>{
        const node=[...document.querySelectorAll('button')].find(node=>(node.textContent.trim()===${JSON.stringify(name)}||node.getAttribute('aria-label')===${JSON.stringify(name)})&&!node.disabled);
        if(!node)return null;node.scrollIntoView({block:'center'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const r=node.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return node.contains(document.elementFromPoint(x,y))?{x,y}:null;
      })()`), `reachable ${name}`);
      await page("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
      await page("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
    };
    const fill = (id, value) => evaluate(`(()=>{const node=document.getElementById(${JSON.stringify(id)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    const geometry = async (name, label) => {
      for (const [width, height] of [[320,568],[768,1024],[1440,900]]) {
        await page("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
        await check(`(async()=>{const node=[...document.querySelectorAll('button')].find(node=>(node.textContent.trim()===${JSON.stringify(name)}||node.getAttribute('aria-label')===${JSON.stringify(name)})&&!node.disabled);if(!node)return false;node.scrollIntoView({block:'center'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));for(let parent=node;parent;parent=parent.parentElement)if(parent.getAnimations().some(animation=>animation.playState==='running'))return false;const r=node.getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth+1&&document.querySelector('.spob').scrollWidth<=innerWidth+1&&r.height>=44&&r.width>=44&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`, `${label} at ${width}`);
        if (width === 320) await writeFile(`/tmp/showpilot-setup-save-${label}-320.png`, Buffer.from((await page("Page.captureScreenshot", { format: "png" })).data, "base64"));
      }
    };
    const open = () => page("Page.navigate", { url: `${origin}/setup?orgId=${orgId}` });
    await open(); await text("Build your team.");
    await click("Add another crew member"); await check("!!document.getElementById('crew-1-name')", "hydration");
    await fill("crew-0-name", "Recovery fixture"); await fill("crew-0-pos", "Camera"); await fill("invite-0-email", "first@display-smoke.invalid");
    if (scenario === "recover") {
      await click("Add another invitation"); await fill("invite-1-email", "second@display-smoke.invalid");
      await evaluate("window.setupFault='reject-save'"); await click("Finish setup"); await text("Some setup work was not confirmed.");
      assert.equal((await snapshot()).batch, null); assert.equal(await evaluate("window.setupCalls.send"), 0);
      await geometry("Retry saving team", "save-error");
      await evaluate("window.setupFault='hold-save'"); await click("Retry saving team");
      await check("window.setupCommitted?.kind==='save'&&window.setupCommitted.status===200", "actual committed team before response loss");
      await check("!!document.querySelector('[role=alert]')&&!document.querySelector('[aria-busy=true]')", "save timeout", 15_000);
      await click("Check saved results"); await text("Review your saved team");
      await evaluate("window.releaseSetupReply()");
      assert.equal(await evaluate("window.setupCalls.send"), 0); assert.equal(await evaluate("window.setupCalls.finish"), 0);
      const first = await snapshot(); assert.equal(first.batch.crew.length, 1); assert.deepEqual(first.invitations, [null, null]);
      assert.deepEqual(await evaluate("window.setupErrors"), []);
      await open(); await text("Review your saved team"); assert.deepEqual(await evaluate("window.setupCalls"), { save: 0, send: 0, finish: 0 });
      await click("Send invitation to first@display-smoke.invalid"); await text("Email delivery failed.");
      await geometry("Resend invitation to first@display-smoke.invalid", "delivery-error");
      await click("Check saved results"); assert.equal((await capturedEmails()).length, 1);
      await configureEmail("success"); await click("Send invitation to second@display-smoke.invalid"); await text("Email accepted for delivery.");
      await click("Resend invitation to first@display-smoke.invalid");
      await check("[...document.querySelectorAll('[role=status]')].filter(node=>node.textContent.includes('Email accepted for delivery')).length===2", "both invitations confirmed");
      assert.equal((await capturedEmails()).length, 3); const confirmed = await snapshot(); assert.equal(confirmed.completed, false);
      assert.ok(confirmed.invitations.every(job => job.state === "accepted"));
      await evaluate("window.setupFault='hold-finish'"); await click("Finish setup");
      await check("window.setupCommitted?.kind==='finish'&&window.setupCommitted.status===200", "actual completion before response loss");
      await text("Setup completion was not confirmed."); assert.equal((await snapshot()).completed, true);
      await geometry("Check saved results", "completion-error");
      await click("Check saved results"); await check(`location.pathname.startsWith('/${orgId}/')`, "confirmed completion navigation"); await text("Show Flow");
    } else {
      await click("Finish setup"); await text("Email delivery failed.");
      await click("Continue without remaining invitations"); await text("Continue with unresolved invitations?");
      await geometry("Cancel", "skip-dialog");
      await click("Cancel"); assert.equal((await snapshot()).completed, false);
      await geometry("Continue without remaining invitations", "skip-choice");
      await click("Continue without remaining invitations"); await text("pending requests may still finish");
      await geometry("Continue to workspace", "skip-confirm");
      await click("Continue to workspace"); await check(`location.pathname.startsWith('/${orgId}/')`, "explicit skip completion"); await text("Show Flow");
    }
    assert.deepEqual(await evaluate("window.setupErrors"), []);
  });
  const final = await snapshot(); assert.equal(final.completed, true); assert.equal(final.batch.crew.length, 1);
  const messages = await capturedEmails(); assert.equal(messages.length, scenario === "recover" ? 3 : 1);
  assert.equal(messages.filter(message => message.delivered).length, scenario === "recover" ? 2 : 0);
  await stopServer();
  assert.deepEqual(await queryFixture("SELECT name,role FROM crew_member WHERE orgId='display-smoke'"), [{ name: "Recovery fixture", role: "Camera" }]);
  assert.equal((await queryFixture("SELECT id FROM invitation WHERE organizationId='display-smoke'")).length, scenario === "recover" ? 2 : 1);
  assert.equal((await queryFixture("SELECT id FROM crew_member WHERE orgId='display-other'")).length, 0);
  console.log(JSON.stringify({ scenario, actualCrewSavedOnce: true, invitationRecords: final.invitations.length, deliveryStates: final.invitations.map(job => job.state), capturedEmails: messages.length, browserErrors: [], widths: [320,768,1440], completed: true }));
}, { setupTeam: true, captureEmail: true });
