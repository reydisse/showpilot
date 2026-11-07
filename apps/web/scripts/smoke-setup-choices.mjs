// Real setup RPCs and Settings writes; only browser transport faults are injected.
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
const ids = {}, names = ["getSetupChoices", "saveSetupWorkspace", "saveSetupRole", "setWorkspaceType"];
const assets = resolve(import.meta.dirname, "../dist/server/assets");
for (const file of (await readdir(assets)).filter(file => file.endsWith(".js"))) {
  const source = await readFile(resolve(assets, file), "utf8");
  assert.doesNotMatch(source, /const (?:saveWorkspaceType|saveOnboardingRole)_createServerFn_handler/, "Retired unchecked setup RPCs must be absent");
  for (const name of names) ids[name] ??= source.match(new RegExp(`const ${name}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`))?.[1];
}
assert.ok(names.every(name => ids[name]));
for (const scenario of ["recover", "conflict"]) await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, stopServer, queryFixture }) => {
  const rpc = async (name, data = { orgId }) => {
    const payload = JSON.stringify(await toJSONAsync({ data })), read = name === "getSetupChoices";
    const response = await fetch(`${origin}/_serverFn/${ids[name]}${read ? `?${new URLSearchParams({ payload })}` : ""}`, {
      method: read ? "GET" : "POST", headers: { Cookie: operatorCookie, Origin: origin, "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin", "x-tsr-serverFn": "true" }, ...(read ? {} : { body: payload }),
    });
    assert.equal(response.status, 200); const reply = fromCrossJSON(await response.json(), { refs: new Map(), plugins: defaultSerovalPlugins });
    assert.equal(reply.error, undefined); return reply.result;
  };
  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    await page("Page.enable");
    await page("Page.addScriptToEvaluateOnNewDocument", { source: `
      window.choiceErrors=[];window.choiceCalls={workspace:0,role:0};
      window.choiceFault=sessionStorage.getItem('choiceStarted')?'none':${JSON.stringify(scenario === "recover" ? "hold-read" : "none")};sessionStorage.setItem('choiceStarted','yes');
      addEventListener('error',event=>window.choiceErrors.push(event.message));addEventListener('unhandledrejection',event=>window.choiceErrors.push(String(event.reason)));
      const original=window.fetch;
      window.fetch=async(input,options)=>{
        const url=input instanceof Request?input.url:String(input),fault=window.choiceFault;
        const kind=url.includes(${JSON.stringify(ids.saveSetupWorkspace)})?'workspace':url.includes(${JSON.stringify(ids.saveSetupRole)})?'role':null;
        if(url.includes(${JSON.stringify(ids.getSetupChoices)})&&fault==='hold-read')return new Promise(()=>{});
        if(!kind)return original(input,options);window.choiceCalls[kind]++;
        if(fault==='reject-'+kind)return new Response('Fixture rejected before saving',{status:503});
        if(fault==='before-'+kind)return new Promise(resolve=>{window.releaseChoice=async()=>{const response=await original(input,{...options,signal:undefined});const body=await response.text();window.choiceReleased=kind;resolve(new Response(body,{status:response.status,headers:response.headers}));};});
        const response=await original(input,options);
        if(fault==='after-'+kind){const body=await response.text();window.choiceCommitted={kind,status:response.status};return new Promise(resolve=>{window.releaseChoice=()=>resolve(new Response(body,{status:response.status,headers:response.headers}));});}
        return response;
      };` });
    const check = (expression, label, timeout) => poll(() => evaluate(expression), label, timeout).catch(async error => {
      console.log(JSON.stringify({ scenario, label, body: await evaluate("document.body?.innerText"), calls: await evaluate("window.choiceCalls") }));
      await writeFile(`/tmp/showpilot-setup-choices-${scenario}-failure.png`, Buffer.from((await page("Page.captureScreenshot", { format: "png" })).data, "base64")); throw error;
    });
    const text = value => check(`document.body?.innerText.toLowerCase().includes(${JSON.stringify(value.toLowerCase())})`, value);
    const click = async name => {
      const point = await poll(() => evaluate(`(async()=>{const node=[...document.querySelectorAll('button')].find(node=>node.textContent.includes(${JSON.stringify(name)})&&!node.disabled);if(!node)return null;node.scrollIntoView({block:'center'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const r=node.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return node.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`), `reachable ${name}`);
      await page("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 }); await page("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
    };
    const field = label => `[...document.querySelectorAll('input')].find(node=>[...node.labels??[]].some(label=>label.textContent.trim()===${JSON.stringify(label)}))`;
    const fill = (label, value) => evaluate(`(()=>{const node=${field(label)};Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    const geometry = async (name, label, selector) => {
      for (const [width,height] of [[320,568],[768,1024],[1440,900]]) {
        await page("Emulation.setDeviceMetricsOverride", { width,height,deviceScaleFactor:1,mobile:false });
        await check(`(async()=>{const node=${selector ?? `[...document.querySelectorAll('button')].find(node=>node.textContent.includes(${JSON.stringify(name)})&&!node.disabled)`};if(!node)return false;node.scrollIntoView({block:'center'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));for(let p=node;p;p=p.parentElement)if(p.getAnimations().some(a=>a.playState==='running'))return false;const r=node.getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth+1&&document.querySelector('.spob').scrollWidth<=innerWidth+1&&r.width>=44&&r.height>=44&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`, `${label} at ${width}`);
        if(width===320)await writeFile(`/tmp/showpilot-setup-choices-${label}-320.png`,Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));
      }
    };
    const deadline = label => check("!!document.querySelector('[role=alert]')&&!document.querySelector('[aria-busy=true]')", label, 15_000);
    const open = () => page("Page.navigate", { url: `${origin}/setup?orgId=${orgId}` });
    await open();
    if(scenario === "recover") {
      await deadline("initial read deadline"); await text("Could not read your saved choices."); await geometry("Check saved choices","read-error");
      await evaluate("window.choiceFault='none'"); await click("Check saved choices"); await text("What are you running?");
      await click("Custom"); await fill("What do you call your productions?","Fixture Tour"); await fill("Event noun","Gig"); await fill("Item noun","Act");
      await geometry(null,"custom-field",field("Event noun"));
      await evaluate("window.choiceFault='reject-workspace'"); await click("Continue"); await text("This choice was not confirmed.");
      assert.deepEqual((await rpc("getSetupChoices")).settings,{}); assert.equal(await evaluate(`${field("Event noun")}.value`),"Gig");
      await geometry("Retry saving workspace","workspace-error"); await evaluate("window.choiceFault='after-workspace'"); await click("Retry saving workspace");
      await check("window.choiceCommitted?.kind==='workspace'&&window.choiceCommitted.status===200","actual workspace commit"); await deadline("workspace write deadline");
      await evaluate("window.choiceFault='none'"); await click("Check saved choices"); await text("Saved workspace:"); await evaluate("window.releaseChoice()");
      assert.equal(await evaluate("document.body.innerText.includes(\"What's your role on the team?\")"),false);
      await click("Continue with saved workspace"); await text("What's your role on the team?");
      await evaluate("window.choiceFault='reject-role'"); await click("Technical Director"); await text("This choice was not confirmed.");
      assert.equal((await rpc("getSetupChoices")).roleValue,null); await geometry("Retry saving role","role-error");
      await evaluate("window.choiceFault='after-role'"); await click("Retry saving role"); await check("window.choiceCommitted?.kind==='role'&&window.choiceCommitted.status===200","actual role commit"); await deadline("role write deadline");
      await evaluate("window.choiceFault='none'"); await click("Check saved choices"); await text("Saved role: Technical Director."); await evaluate("window.releaseChoice()");
      await geometry("Continue with saved role","role-confirmed"); await click("Continue with saved role"); await text("Pick your first gig.");
    } else {
      await text("What are you running?"); await evaluate("window.choiceFault='before-workspace'"); await click("School"); await deadline("pending workspace deadline");
      await rpc("setWorkspaceType",{orgId,type:"theatre",resetModules:true}); await evaluate("window.releaseChoice()"); await check("window.choiceReleased==='workspace'","late workspace request completed");
      assert.equal((await rpc("getSetupChoices")).settings["workspace-type"],"theatre");
      await evaluate("window.choiceFault='none'"); await click("Check saved choices"); await text("Saved workspace: Theatre."); await click("Retry saving workspace"); await text("Saved choices changed while this request was waiting.");
      await geometry("Check saved choices","workspace-conflict"); await click("School"); await text("What's your role on the team?");
      await evaluate("window.choiceFault='before-role';window.choiceReleased=null"); await click("Technical Director"); await deadline("pending role deadline");
      const current = await rpc("getSetupChoices"); await rpc("saveSetupRole",{orgId,kind:"role",requestId:crypto.randomUUID(),expectedRevision:current.roleValue,archetype:"pm"});
      await evaluate("window.releaseChoice()"); await check("window.choiceReleased==='role'","late role request completed");
      assert.equal(JSON.parse((await rpc("getSetupChoices")).roleValue).archetype,"pm");
      await evaluate("window.choiceFault='none'"); await click("Check saved choices"); await text("Saved role: Production Manager."); await click("Retry saving role"); await text("Saved choices changed while this request was waiting.");
      await geometry("Check saved choices","role-conflict"); await click("Stage Manager"); await text("Pick your first");
    }
    assert.deepEqual(await evaluate("window.choiceErrors"),[]); await open(); await text("Pick your first");
    assert.deepEqual(await evaluate("window.choiceCalls"),{workspace:0,role:0}); assert.deepEqual(await evaluate("window.choiceErrors"),[]);
  });
  const state = await rpc("getSetupChoices"); assert.equal(state.settings["workspace-type"],scenario==="recover"?"custom":"school"); assert.equal(JSON.parse(state.roleValue).archetype,scenario==="recover"?"td":"sm");
  if(scenario==="recover")assert.deepEqual(JSON.parse(state.settings["workspace-custom"]),{label:"Fixture Tour",terms:{event:"Gig",item:"Act"}});
  await stopServer(); const rows=await queryFixture("SELECT role FROM member WHERE organizationId='display-smoke' AND userId='smoke-operator'"); assert.equal(rows[0].role,"owner");
  assert.equal((await queryFixture("SELECT COUNT(*) AS count FROM app_setting WHERE orgId='display-smoke' AND key IN ('onboarding-template-seeded','onboarding-completed')"))[0].count,0);
  console.log(JSON.stringify({scenario,result:"passed",workspace:state.settings["workspace-type"],role:JSON.parse(state.roleValue).archetype}));
},{setupChoices:true});
