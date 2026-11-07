// Built setup UI, actual authenticated seed RPC, D1 and response-loss recovery.
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
const ids = {}, names = ["seedOrgTemplate", "getOnboardingSeed"];
const assets = resolve(import.meta.dirname, "../dist/server/assets");
for (const file of (await readdir(assets)).filter(file => file.endsWith(".js"))) {
  const source = await readFile(resolve(assets, file), "utf8");
  for (const name of names) ids[name] ??= source.match(new RegExp(`const ${name}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`))?.[1];
}
assert.ok(names.every(name => ids[name]));
for (const scenario of ["recover", "skip", "late"]) await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, stopServer, queryFixture }) => {
  const snapshot = async () => {
    const payload = JSON.stringify(await toJSONAsync({ data: { orgId } }));
    const response = await fetch(`${origin}/_serverFn/${ids.getOnboardingSeed}?payload=${encodeURIComponent(payload)}`, { headers: { Cookie: operatorCookie, Origin: origin, "x-tsr-serverFn": "true" } });
    assert.equal(response.status, 200); const reply = fromCrossJSON(await response.json(), { refs: new Map(), plugins: defaultSerovalPlugins });
    assert.equal(reply.error, undefined); return reply.result;
  };
  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    await page("Page.enable");
    await page("Page.addScriptToEvaluateOnNewDocument", { source: `
      window.seedErrors=[];window.seedCalls=0;window.seedFault='none';
      addEventListener('error',event=>window.seedErrors.push(event.message));
      addEventListener('unhandledrejection',event=>window.seedErrors.push(String(event.reason)));
      const original=window.fetch;
      window.fetch=async(input,options)=>{
        const url=input instanceof Request?input.url:String(input);
        const write=url.includes(${JSON.stringify(ids.seedOrgTemplate)});
        const read=url.includes(${JSON.stringify(ids.getOnboardingSeed)});
        if(read&&window.seedFault==='hold-read')return new Promise(()=>{});
        if(!write)return original(input,options);
        window.seedCalls++;
        if(window.seedFault==='reject')return new Response('Fixture rejected before save',{status:503});
        if(window.seedFault==='hold-before')return new Promise(resolve=>{window.releaseSeed=async()=>{const response=await original(input,{...options,signal:undefined});const body=await response.text();window.seedReleased=response.status;resolve(new Response(body,{status:response.status,headers:response.headers}));};});
        const response=await original(input,options);
        if(window.seedFault==='hold-after'){
          const body=await response.text();window.seedCommitted=response.status;
          return new Promise(resolve=>{window.releaseSeed=()=>resolve(new Response(body,{status:response.status,headers:response.headers}));});
        }
        return response;
      };` });
    const check = (expression, label, timeout) => poll(() => evaluate(expression), label, timeout).catch(async error => {
      console.log(JSON.stringify({ scenario, label, body: await evaluate("document.body?.innerText"), calls: await evaluate("window.seedCalls") }));
      await writeFile(`/tmp/showpilot-setup-rundown-${scenario}-failure.png`, Buffer.from((await page("Page.captureScreenshot", { format: "png" })).data, "base64")); throw error;
    });
    const text = value => check(`document.body?.innerText.toLowerCase().includes(${JSON.stringify(value.toLowerCase())})`, value);
    const click = async name => {
      const point = await poll(() => evaluate(`(async()=>{
        const node=[...document.querySelectorAll('button')].find(node=>(node.textContent.trim()===${JSON.stringify(name)}||node.getAttribute('aria-label')===${JSON.stringify(name)}||node.textContent.includes(${JSON.stringify(name)}))&&!node.disabled);
        if(!node)return null;node.scrollIntoView({block:'center'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const r=node.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return node.contains(document.elementFromPoint(x,y))?{x,y}:null;
      })()`), `reachable ${name}`);
      await page("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
      await page("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
    };
    const geometry = async (name, label) => {
      for (const [width, height] of [[320,568],[768,1024],[1440,900]]) {
        await page("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
        await check(`(async()=>{const node=[...document.querySelectorAll('button')].find(node=>node.textContent.includes(${JSON.stringify(name)})&&!node.disabled);if(!node)return false;node.scrollIntoView({block:'center'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));for(let parent=node;parent;parent=parent.parentElement)if(parent.getAnimations().some(animation=>animation.playState==='running'))return false;const r=node.getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth+1&&document.querySelector('.spob').scrollWidth<=innerWidth+1&&r.height>=44&&r.width>=44&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`, `${label} at ${width}`);
        if (width === 320) await writeFile(`/tmp/showpilot-setup-rundown-${label}-320.png`, Buffer.from((await page("Page.captureScreenshot", { format: "png" })).data, "base64"));
      }
    };
    const open = () => page("Page.navigate", { url: `${origin}/setup?orgId=${orgId}` });
    await open(); await text("Pick your first"); await geometry("Sunday Service", "templates");
    assert.deepEqual(await snapshot(), { status: "empty" });
    if (scenario !== "late") {
      await evaluate("window.seedFault='reject'"); await click("Sunday Service"); await text("Rundown creation was not confirmed.");
      assert.deepEqual(await snapshot(), { status: "empty" }); await geometry("Retry rundown creation", "save-error");
      if (scenario === "recover") {
        await evaluate("window.seedFault='hold-after'"); await click("Retry rundown creation");
        await check("window.seedCommitted===200", "actual committed rundown before lost response");
        await check("!!document.querySelector('[role=alert]')&&!document.querySelector('[aria-busy=true]')", "write deadline", 15_000);
        const result = await snapshot(); assert.equal(result.status, "saved"); assert.equal(result.template, "sunday"); assert.equal(result.items.length, 9);
        await evaluate("window.seedFault='hold-read'"); await click("Check saved rundown");
        await check("document.body.innerText.includes('Could not check the saved rundown.')&&!document.querySelector('[aria-busy=true]')", "read deadline", 15_000);
        await geometry("Check saved rundown", "read-error"); await evaluate("window.seedFault='none'"); await click("Check saved rundown");
        await text("Your rundown is saved"); await evaluate("window.releaseSeed()"); await text("Your rundown is saved");
        assert.equal(await evaluate("window.seedCalls"), 2);
      } else {
        await evaluate("window.seedFault='none'"); await click("Continue without adding a rundown"); await text("No rundown was added.");
        assert.equal((await snapshot()).template, "blank");
      }
    } else {
      await evaluate("window.seedFault='hold-before'"); await click("Sunday Service");
      await check("!!document.querySelector('[role=alert]')&&!document.querySelector('[aria-busy=true]')", "delayed request deadline", 15_000);
      await evaluate("window.seedFault='none'"); await click("Continue without adding a rundown"); await text("No rundown was added.");
      await evaluate("window.releaseSeed()"); await check("window.seedReleased===200", "late original request acknowledged");
      assert.equal((await snapshot()).template, "blank"); await text("No rundown was added.");
    }
    await geometry("Get your team in", `${scenario}-result`); assert.deepEqual(await evaluate("window.seedErrors"), []);
    await click("Get your team in"); await text("Build your team."); await open(); await text("Build your team.");
    assert.equal(await evaluate("window.seedCalls"), 0); assert.deepEqual(await evaluate("window.seedErrors"), []);
  });
  await stopServer();
  const counts = (await queryFixture(`SELECT
    (SELECT COUNT(*) FROM rundown WHERE orgId='display-smoke' AND id='display-smoke:onboarding:show') AS shows,
    (SELECT COUNT(*) FROM rundown_item WHERE orgId='display-smoke' AND showId='display-smoke:onboarding:show') AS items,
    (SELECT COUNT(*) FROM checklist_template WHERE orgId='display-smoke') AS checklist,
    (SELECT COUNT(*) FROM cue_note WHERE orgId='display-smoke' AND showId='display-smoke:onboarding:show') AS notes,
    (SELECT COUNT(*) FROM app_setting WHERE orgId='display-smoke' AND key='onboarding-completed') AS completed,
    (SELECT name FROM rundown WHERE orgId='display-smoke' AND id='smoke-show') AS original`))[0];
  assert.deepEqual(counts, { shows: scenario === "recover" ? 1 : 0, items: scenario === "recover" ? 9 : 0, checklist: scenario === "recover" ? 5 : 0, notes: scenario === "recover" ? 4 : 0, completed: 0, original: "Display test show" });
  console.log(JSON.stringify({ scenario, counts, result: "passed" }));
}, { setupSeed: true });
