// Real compiled setup, auth and D1. Hold replies after actual commits.
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";
let roleId;
const assets = resolve(import.meta.dirname, "../dist/server/assets");
for (const file of (await readdir(assets)).filter(file => file.endsWith(".js"))) {
  const source = await readFile(resolve(assets, file), "utf8");
  roleId ??= source.match(/const saveSetupRole_createServerFn_handler = createServerRpc\(\{\s*id: "([^"]+)"/)?.[1];
}
assert.ok(roleId);
for (const scenario of ["back-exit-resume", "leave-creation", "creation-during-exit"]) await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, capturedEmails, stopServer, queryFixture }) => {
  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    await page("Page.enable");
    await page("Page.addScriptToEvaluateOnNewDocument", { source: `
      window.navErrors=[];window.navFault='none';window.navCommitted=null;window.navClicks=[];
      addEventListener('click',event=>window.navClicks.push({text:event.target.textContent,dialog:event.target.closest('[role=dialog]')?.dataset.state,time:performance.now()}),true);
      addEventListener('error',event=>window.navErrors.push(event.message));addEventListener('unhandledrejection',event=>window.navErrors.push(String(event.reason)));
      const original=window.fetch;
      window.fetch=async(input,options)=>{
        const url=input instanceof Request?input.url:String(input),fault=window.navFault;
        const held=fault==='role'&&url.includes(${JSON.stringify(roleId)})||fault==='create'&&url.includes('/api/auth/organization/create');
        const response=await original(input,options);
        if(!held)return response;
        const body=await response.text();window.navCommitted={kind:fault,status:response.status};
        return new Promise(resolve=>{window.releaseNavReply=()=>resolve(new Response(body,{status:response.status,headers:response.headers}));});
      };` });
    const check = (expression, label, timeout) => poll(() => evaluate(expression), label, timeout).catch(async error => {
      console.log(JSON.stringify({scenario,label,body:await evaluate("document.body?.innerText"),url:await evaluate("location.href"),clicks:await evaluate("window.navClicks"),errors:await evaluate("window.navErrors")}));
      await writeFile(`/tmp/showpilot-setup-navigation-${scenario}-failure.png`,Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));throw error;
    });
    const text = value => check(`document.body?.innerText.toLowerCase().includes(${JSON.stringify(value.toLowerCase())})`, value);
    const selector = (name, contains = false) => `[...(document.querySelector('[role=dialog][data-state=open]')??document).querySelectorAll('button,a')].find(node=>${contains ? `node.textContent.includes(${JSON.stringify(name)})` : `node.textContent.trim()===${JSON.stringify(name)}`}&&!node.disabled&&!node.closest('[role=dialog][data-state=closed]')&&node.getBoundingClientRect().height>0)`;
    const click = async (name, contains = false) => {
      const point = await poll(() => evaluate(`(async()=>{const node=${selector(name, contains)};if(!node)return null;node.scrollIntoView({block:'center'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));for(let p=node;p;p=p.parentElement)if(p.getAnimations().some(a=>a.playState==='running'))return null;const r=node.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return node.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`), `reachable ${name}`);
      await page("Input.dispatchMouseEvent",{type:"mousePressed",...point,button:"left",clickCount:1});await page("Input.dispatchMouseEvent",{type:"mouseReleased",...point,button:"left",clickCount:1});
    };
    const field = label => `[...document.querySelectorAll('input')].find(node=>[...node.labels??[]].some(label=>label.textContent.trim()===${JSON.stringify(label)})&&node.getBoundingClientRect().height>0)`;
    const fill = (label,value) => evaluate(`(()=>{const node=${field(label)};Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    const geometry = async (name,label) => {
      for(const [width,height] of [[320,568],[768,1024],[1440,900]]) {
        await page("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false});
        await check(`(async()=>{const node=${selector(name)};if(!node)return false;node.scrollIntoView({block:'center'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));for(let p=node;p;p=p.parentElement)if(p.getAnimations().some(a=>a.playState==='running'))return false;const r=node.getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth+1&&r.height>=44&&r.width>=44&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`,`${label} at ${width}`);
        await check("!document.getAnimations().some(a=>a.playState==='running'&&a.effect?.getComputedTiming().iterations!==Infinity)",`${label} paint settled`);
        if(width===320)await writeFile(`/tmp/showpilot-setup-navigation-${label}-320.png`,Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));
      }
    };
    const open = url => page("Page.navigate", { url: `${origin}${url}` });
    if(scenario === "back-exit-resume") {
      await open(`/setup?orgId=${orgId}`);await text("What are you running?");
      await click("Pick your own features",true);
      await text("Event noun");await fill("What do you call your productions?","Navigation fixture");await fill("Event noun","Gig");
      await geometry("Back","workspace-back");await click("Back");await text("Your organization is saved");
      await click("Continue with this organization");await text("What are you running?");assert.equal(await evaluate(`${field("Event noun")}.value`),"Gig");
      await click("Continue");await text("What's your role on the team?");await evaluate("window.navFault='role'");
      await click("Technical Director",true);
      await check("window.navCommitted?.kind==='role'&&window.navCommitted.status===200","actual role commit");await click("Back");await text("What are you running?");
      await evaluate("window.navFault='none';window.releaseNavReply()");await check(`!!(${selector("Continue with saved workspace")})`,"role completed without advancing");
      assert.equal(await evaluate("document.body.innerText.includes(\"What's your role on the team?\")"),false);
      await click("Continue with saved workspace");await text("Saved role: Technical Director.");await click("Continue with saved role");await text("Pick your first gig.");
      await click("Start Blank",true);
      await text("No rundown was added.");await click("Get your team in");await text("Build your team.");await fill("Crew 1 name","Unsaved navigation crew");
      await click("Back");await text("Continue with your workspace");await click("Get your team in");await text("Build your team.");assert.equal(await evaluate(`${field("Crew 1 name")}.value`),"Unsaved navigation crew");
      await geometry("Back","team-back");await click("Exit setup");await check("!!document.querySelector('[role=dialog][data-state=open]')","exit confirmation open");await geometry("Keep setting up","exit-cancel");await click("Keep setting up");await check("!document.querySelector('[role=dialog]')","exit cancelled and dialog closed");assert.equal(await evaluate(`${field("Crew 1 name")}.value`),"Unsaved navigation crew");
      await click("Exit setup");await check("!!document.querySelector('[role=dialog][data-state=open]')","exit confirmation open");await geometry("Exit setup","exit-confirm");await click("Exit setup");await check(`location.pathname==='/${orgId}/show'`,"exit to workspace");
      assert.deepEqual(await evaluate("window.navErrors"),[]);
      await open(`/${orgId}/settings?section=workspace`);await text("Resume setup");await geometry("Resume setup","settings-resume");await click("Resume setup");await text("Build your team.");
      assert.equal(await evaluate(`${field("Crew 1 name")}.value`),"");await text("Step 6 of 6");
      await fill("Crew 1 name","Unsaved navigation crew");
      await page("Page.reload");
      await poll(async()=>{
        try { await page("Page.handleJavaScriptDialog",{accept:false});return true; }
        catch(error) { if(!error.message.includes("No dialog is showing"))throw error;return false; }
      },"native reload warning");
      assert.equal(await evaluate(`${field("Crew 1 name")}.value`),"Unsaved navigation crew");
      await evaluate("history.back()");await text("Exit setup?");await click("Keep setting up");
      await check("!document.querySelector('[role=dialog]')","browser Back cancelled");
      assert.equal(await evaluate(`${field("Crew 1 name")}.value`),"Unsaved navigation crew");
      await evaluate("history.back()");await text("Exit setup?");await click("Exit setup");
      await check(`location.pathname==='/${orgId}/settings'`,"browser Back confirmed");await text("Resume setup");
    } else {
      await open("/setup?mode=new");await text("Create another organization");
      // A real dialog interaction proves hydration before assigning controlled inputs.
      await click("Exit setup");await text("Exit setup?");await click("Keep setting up");
      await check("!document.querySelector('[role=dialog]')","creation form hydrated");await fill("Organization name","Setup Navigation Created");
      await check(`!!(${selector("Create organization")})`,"available organization slug");await evaluate("window.navFault='create'");await click("Create organization");
      await check("window.navCommitted?.kind==='create'&&window.navCommitted.status===200","actual organization commit");
      await click("Exit setup");await check("!!document.querySelector('[role=dialog][data-state=open]')","exit confirmation open");await geometry("Exit setup",scenario);
      if(scenario==="creation-during-exit") {
        await evaluate("window.navFault='none';window.releaseNavReply()");await text("Continue setup");
        await click("Keep setting up");await check("!document.querySelector('[role=dialog]')","creation exit cancelled");
        await text("Continue setup");await click("Exit setup");await text("Exit setup?");
      }
      await click("Exit setup");await check(`location.pathname==='/${orgId}/show'`,"kept previous active workspace");
    }
    assert.deepEqual(await evaluate("window.navErrors"),[]);
  });
  assert.equal((await capturedEmails()).length,0);await stopServer();
  assert.equal((await queryFixture("SELECT COUNT(*) AS count FROM app_setting WHERE orgId='display-smoke' AND key='onboarding-completed'"))[0].count,0);
  assert.equal((await queryFixture("SELECT COUNT(*) AS count FROM crew_member WHERE orgId='display-smoke' AND name='Unsaved navigation crew'"))[0].count,0);
  if(scenario!=="back-exit-resume") {
    assert.equal((await queryFixture("SELECT COUNT(*) AS count FROM organization WHERE slug='setup-navigation-created'"))[0].count,1);
    assert.ok((await queryFixture("SELECT activeOrganizationId FROM session WHERE userId='smoke-operator'")).every(row=>row.activeOrganizationId==='display-smoke'));
    assert.equal((await queryFixture("SELECT COUNT(*) AS count FROM app_setting WHERE orgId IN (SELECT id FROM organization WHERE slug='setup-navigation-created') AND key='onboarding-started'"))[0].count,0);
  }
  console.log(JSON.stringify({scenario,result:"passed"}));
},{setupChoices:true,captureEmail:true});
