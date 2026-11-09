// Compiled Tech Manager commands with real local auth/D1 and captured notifications.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
const modules = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const { chromium } = createRequire(join(modules, "agent-browser/package.json"))("playwright-core");
const require = createRequire(new URL("../package.json", import.meta.url)), router = createRequire(require.resolve("@tanstack/react-router")), core = createRequire(router.resolve("@tanstack/router-core"));
const { toJSONAsync, fromJSON, fromCrossJSON } = core("seroval"), { defaultSerovalPlugins } = router("@tanstack/router-core");
const audit = process.argv.includes("--audit"), ids = {};
const names = audit ? ["assignFault", "saveTmDashboardLayout"] : ["getTmManagementState", "commandTmManagement", "reviewTmManagement"];
const assets = resolve(import.meta.dirname, "../dist/server/assets");
for (const file of (await readdir(assets)).filter(file => file.endsWith(".js"))) {
  const source = await readFile(join(assets, file), "utf8");
  for (const name of names) ids[name] ??= source.match(new RegExp(`const ${name}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`))?.[1];
}
assert.ok(names.every(name => ids[name]));
await withLocalSmokeFixture(async ({origin,orgId,operatorCookie,queryFixture,capturedEmails}) => {
  const browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.addCookies(operatorCookie.split("; ").map(part=>({name:part.slice(0,part.indexOf("=")),value:part.slice(part.indexOf("=")+1),url:origin})));
  const page=await context.newPage(),held=[],writes=[],errors=[],completed=[];
  let pause = null, auditPaused=ids.assignFault;
  const release=()=>held.splice(0).forEach(done=>done());
  const headers = { Cookie:operatorCookie, Origin:origin, "Sec-Fetch-Site":"same-origin", "x-tsr-serverFn":"true", "Content-Type":"application/json" };
  const scope = {orgId,userId:"smoke-operator"};
  async function rpc(name,data=scope) {
    const payload=JSON.stringify(await toJSONAsync({data})),url=`${origin}/_serverFn/${ids[name]}`,read=name==="getTmManagementState";
    const response=await fetch(read?`${url}?payload=${encodeURIComponent(payload)}`:url,{headers,...(read?{}:{method:"POST",body:payload})});
    assert.equal(response.status,200,await response.clone().text());
    const reply=fromCrossJSON(await response.json(),{refs:new Map(),plugins:defaultSerovalPlugins});
    assert.equal(reply instanceof Error,false,reply.message);assert.equal(reply.error,undefined);return reply.result;
  }
  const command=operation=>({...scope,requestId:crypto.randomUUID(),expiresAt:Date.now()+25000,operation});
  const current=()=>rpc("getTmManagementState");
  const incident=async()=>(await queryFixture("SELECT i.assignedTo,i.status,r.revision FROM incident i JOIN incident_management_revision r ON r.orgId=i.orgId AND r.incidentId=i.id WHERE i.id='smoke-date-incident'"))[0];
  const storedLayout=async()=>JSON.parse((await queryFixture("SELECT layout FROM dashboard_layout WHERE dashboard='tech-manager' LIMIT 1"))[0].layout);
  if (!audit) await page.addInitScript(() => { const now = Date.now.bind(Date); Date.now = () => now() + 3600000; });
  page.on("pageerror",error=>errors.push(error.message));
  await page.routeWebSocket("**/*",socket=>socket.close());
  await page.route("**/*",async route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.origin!==origin)return route.abort();
    if(req.method()==="POST" && names.filter(name=>!name.startsWith("get")).some(name=>url.pathname.endsWith(ids[name]))) {
      const value={path:url.pathname,body:req.postData()}; writes.push(value);
      const hold = audit ? url.pathname.endsWith(auditPaused)?"after":null : url.pathname.endsWith(ids.commandTmManagement)?pause:null;
      if(hold==="before")await new Promise(done=>held.push(done));
      const response=await route.fetch(); completed.push(value);
      if(hold==="after")await new Promise(done=>held.push(done));
      return route.fulfill({response}).catch(()=>{});
    }
    return route.continue();
  });
  const button=name=>page.getByRole("button",{name,exact:true});
  async function wait(check,label) {const until=Date.now()+20000;while(!await check()){assert.ok(Date.now()<until,`Timed out: ${label}`);await page.waitForTimeout(50);}}
  async function navigation() {
    await page.getByRole("link",{name:"Manage destinations",exact:true}).click();
    await page.waitForURL("**/streaming/platforms");await page.goBack();
    await page.getByRole("heading",{name:"Tech Manager",exact:true}).waitFor();
  }
  async function widths(label,names) {
    for(const [width,height] of [[320,480],[768,1024],[1440,1000]]) {
      await page.setViewportSize({width,height});
      await page.evaluate(async()=>{await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));});
      for(const name of names){const target=button(name);await target.scrollIntoViewIfNeeded();const box=await target.boundingBox();assert.ok(box&&box.height>=44&&box.width>=44&&box.x>=0&&box.x+box.width<=width+1,`${name} fits ${width}`);await target.click({trial:true});}
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      await page.screenshot({path:`/tmp/showpilot-tm-management-${label}-${width}.png`,fullPage:true});
    }
  }
  try {
    await page.goto(`${origin}/${orgId}/dashboard/tech-manager`);
    await page.waitForFunction(()=>[...document.querySelectorAll("button")].some(node=>node.textContent.trim()==="Take it"&&!node.disabled&&Object.keys(node).some(key=>key.startsWith("__reactProps$"))));
    if(audit){
      await button("Take it").click();await page.waitForTimeout(11500);
      console.log(JSON.stringify({case:"incident",writes:writes.length,stored:await incident(),retryVisible:await button("Retry incident change").count()>0,resolveDisabled:await button("Resolve").isDisabled()}));
      auditPaused=ids.saveTmDashboardLayout;release();await button("Arrange widgets").click();await button("Move System overview down").click();await page.waitForTimeout(11500);
      console.log(JSON.stringify({case:"layout",writes:writes.length,stored:await storedLayout(),savingVisible:(await page.locator("main").innerText()).includes("Saving…"),retryVisible:await button("Retry layout change").count()>0}));return;
    }
    pause="after";await button("Take it").evaluate(node => { node.click(); node.click(); });await button("Retry incident change").waitFor({timeout:16000});
    assert.equal(writes.length,1,"same-turn double click sends one command");
    assert.equal((await incident()).assignedTo,scope.userId);
    await widths("incident-retry",["Retry incident change","Review incident result"]);
    await rpc("commandTmManagement",command({kind:"assign",id:"smoke-date-incident",expectedRevision:(await incident()).revision,assignedTo:null}));
    await navigation();await button("Retry incident change").waitFor();
    pause=null;await button("Retry incident change").click();await button("Retry incident change").waitFor({state:"hidden"});
    assert.deepEqual(fromJSON(JSON.parse(writes[0].body)),fromJSON(JSON.parse(writes[1].body)));assert.equal((await incident()).assignedTo,null);release();
    console.log(JSON.stringify({case:"incident-lost-reply",retainedAcrossNavigation:true,identicalRetry:true,preservesNewerAssignment:true}));
    await wait(async()=>await button("Take it").isEnabled(),"incident refreshed");pause="before";
    const before=writes.length;await button("Take it").click();await button("Retry incident change").waitFor({timeout:16000});
    await button("Review incident result").click();await button("Continue with current incident").waitFor();
    assert.equal((await incident()).assignedTo,null);pause=null;release();await wait(()=>completed.length===writes.length,"cancelled request arrived");
    assert.equal((await incident()).assignedTo,null);assert.equal(writes.length,before+2);
    await button("Continue with current incident").click();
    console.log(JSON.stringify({case:"review-before-arrival",cancelled:true}));
    await button("Arrange widgets").click();pause="after";
    await button("Move System overview down").click();await button("Retry layout change").waitFor({timeout:16000});
    const desired=await storedLayout(),currentState=await current();
    const defaultLayout={version:1,sections:["overview","signal-path","workspace","operations"],main:["prep","faults","all-clear"]};
    await rpc("commandTmManagement",command({kind:"layout",expectedRevision:currentState.layoutRevision,layout:defaultLayout}));
    await button("Done arranging").click();await navigation();await button("Retry layout change").waitFor();
    await widths("layout-retry",["Retry layout change","Review layout result"]);
    const firstLayoutWrite=writes.find(value=>fromJSON(JSON.parse(value.body)).data.operation.kind==="layout");
    pause=null;await button("Retry layout change").click();await button("Retry layout change").waitFor({state:"hidden"});release();
    assert.deepEqual(fromJSON(JSON.parse(writes.at(-1).body)),fromJSON(JSON.parse(firstLayoutWrite.body)));
    assert.deepEqual(await storedLayout(),defaultLayout);
    console.log(JSON.stringify({case:"layout-lost-reply",retainedAcrossNavigation:true,identicalRetry:true,preservesNewerArrangement:true}));
    await button("Arrange widgets").click();pause="before";await button("Move System overview down").click();await wait(()=>held.length>0,"layout held before save");
    let state=await current();await rpc("commandTmManagement",command({kind:"layout",expectedRevision:state.layoutRevision,layout:{...defaultLayout,sections:["operations","overview","signal-path","workspace"]}}));
    pause=null;release();await button("Compare layouts").click();
    await widths("layout-review",["Keep my draft","Use saved layout","Save my layout"]);
    state=await current();await rpc("commandTmManagement",command({kind:"layout",expectedRevision:state.layoutRevision,layout:defaultLayout}));
    await button("Save my layout").click();await button("Compare layouts").waitFor();
    assert.deepEqual(await storedLayout(),defaultLayout,"stale review cannot replace a newer layout");
    await button("Compare layouts").click();await button("Save my layout").click();await button("Compare layouts").waitFor({state:"hidden"});
    await wait(async()=>JSON.stringify(await storedLayout())===JSON.stringify(desired),"explicit reviewed layout saved");
    await button("Done arranging").click();
    console.log(JSON.stringify({case:"layout-conflict",draftRetained:true,staleReviewRejected:true,explicitReplacement:true}));
    // Exercise the existing native endpoints against real D1 triggers too.
    async function native(action,body){const response=await fetch(`${origin}/api/mobile/v1/incidents/smoke-date-incident/${action}?orgId=${orgId}`,{method:"POST",headers:{Cookie:operatorCookie,Origin:origin,"Content-Type":"application/json"},body:JSON.stringify(body)});assert.equal(response.status,200,await response.clone().text());}
    await native("command",{action:"claim"});await native("command",{action:"unassign"});await native("command",{action:"claim"});
    await native("update",{category:"audio",severity:"high",description:"Updated through the native API"});await native("command",{action:"resolve"});await native("remove",{});
    assert.equal(await incident(),undefined);console.log(JSON.stringify({case:"native-compatibility",claim:true,release:true,edit:true,resolve:true,delete:true}));
    assert.deepEqual(errors,[]);assert.equal((await capturedEmails()).length,0);
    console.log(JSON.stringify({passed:true,widths:[320,768,1440],errors,emails:0,clientClockSkewMs:3600000}));
  } catch(error){console.log(JSON.stringify({writes:writes.map(value=>audit?value:fromJSON(JSON.parse(value.body))),errors,body:(await page.locator("body").innerText()).slice(-7000)}));throw error;}
  finally {release();await browser.close();}
},{captureEmail:true,dateOnlyIncident:true});
