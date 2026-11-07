// Disposable compiled landing Worker, actual R2 objects and Chrome downloads.
// Never reads or writes production R2, and never opens a store or app account.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { poll, withRealBrowser } from "../../web/scripts/real-browser-fixture.mjs";
const run = promisify(execFile);
const landing = resolve(import.meta.dirname,"..");
const directory = await mkdtemp(join(tmpdir(),"showpilot-landing-fallback-"));
let runtime;
const require = createRequire(new URL("../package.json",import.meta.url));
const wrangler = require("wrangler");
const { Miniflare, convertV4MiniflareOptions } = createRequire(require.resolve("wrangler"))("miniflare");
const artifact = "disposable-showpilot-download-fixture";
const desktop = { id:"desktop-macos-arm64",kind:"artifact",product:"desktop",version:"0.1.0-fixture",status:"beta",platform:"macOS",architecture:"Apple Silicon",label:"macOS Apple Silicon",key:"releases/fixture/desktop.dmg",fileName:"ShowPilot-fixture.dmg",size:artifact.length };
const windows = {...desktop,id:"desktop-windows-x64",platform:"Windows",architecture:"x64",label:"Windows",key:"releases/fixture/desktop.exe",fileName:"ShowPilot-fixture.exe"};
const mobile = {id:"mobile-ios",kind:"store",product:"mobile",version:"0.1.0-fixture",status:"beta",platform:"iOS",architecture:"Universal",label:"iOS",storeUrl:"https://apps.apple.com/app/showpilot-fixture/id1234567890"};
try {
  await readFile(join(landing,"dist/index.html"));
  const bundle = join(directory,"bundle");
  await run("pnpm",["exec","wrangler","deploy","--dry-run","--outdir",bundle],{cwd:landing,timeout:60_000,maxBuffer:2_000_000});
  const files = (await readdir(bundle)).filter(name=>name.endsWith(".js"));assert.equal(files.length,1);
  const config = JSON.parse(await readFile(join(landing,"wrangler.jsonc"),"utf8"));
  delete config.$schema;delete config.routes;delete config.observability;
  config.main=join(bundle,files[0]);config.assets.directory=join(landing,"dist");
  const configPath=join(directory,"wrangler.json");await writeFile(configPath,JSON.stringify(config));
  const {workerOptions,externalWorkers,main}=wrangler.unstable_getMiniflareWorkerOptions(configPath);
  const {modulesRules:_rules,...options}=workerOptions;
  runtime=new Miniflare(convertV4MiniflareOptions({host:"127.0.0.1",port:0,resourcePersistencePath:join(directory,"state"),workers:[{...options,modules:[{type:"ESModule",path:main}],modulesRoot:bundle},...externalWorkers]}));
  const origin=(await runtime.ready).origin;
  const bucket=await runtime.getR2Bucket("DOWNLOADS");
  const publish = releases => bucket.put("manifests/releases.json",JSON.stringify({schemaVersion:1,updatedAt:new Date().toISOString(),releases}));
  await bucket.put(desktop.key,artifact);await publish([desktop,mobile]);
  const home = await fetch(`${origin}/`);const html=await home.text();
  assert.equal(home.status,200);assert.ok(html.includes("14 days of Pro"));assert.ok(html.includes("Try Pro free for 14 days"));assert.ok(html.includes("Start your 14-day trial"));
  assert.equal((html.match(/data-download-id=/g)||[]).length,8);
  assert.equal(html.includes('aria-disabled="true"'),false);
  const store = await fetch(`${origin}/downloads/mobile-ios`,{redirect:"manual"});assert.equal(store.status,302);assert.equal(store.headers.get("Location"),mobile.storeUrl);
  const result=await run(process.execPath,[join(landing,"scripts/smoke-release-site.mjs"),origin],{cwd:landing,timeout:30_000,maxBuffer:1_000_000});assert.ok(result.stdout.includes("passed"));
  const downloads=join(directory,"downloads");await mkdir(downloads);
  await withRealBrowser({origin},async ({page,evaluate,browser})=>{
    await page("Emulation.setFocusEmulationEnabled",{enabled:true});await page("Page.enable");
    await browser("Browser.setDownloadBehavior",{behavior:"allow",downloadPath:downloads,eventsEnabled:true});
    const check=(expression,label)=>poll(()=>evaluate(expression),label).catch(async error=>{
      console.log(JSON.stringify({label,body:await evaluate("document.body?.innerText"),errors:await evaluate("window.landingErrors??[]")}));
      await writeFile("/tmp/showpilot-landing-fallback-failure.png",Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));throw error;
    });
    const text=value=>check(`document.body?.innerText.includes(${JSON.stringify(value)})`,value);
    const target=selector=>`document.querySelector(${JSON.stringify(selector)})`;
    const point=selector=>`(()=>{const n=${target(selector)};if(!n)return null;n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`;
    const click=async selector=>{
      const p=await check(point(selector),`reachable ${selector}`);
      await page("Input.dispatchMouseEvent",{type:"mousePressed",...p,button:"left",clickCount:1});
      await page("Input.dispatchMouseEvent",{type:"mouseReleased",...p,button:"left",clickCount:1});
    };
    const geometry=async (selectors,label)=>{
      for(const [width,height]of [[320,568],[768,1024],[1440,900]]){
        await page("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false});
        for(const selector of selectors){
          await check(`(()=>{const n=${target(selector)};return !n?.matches('[data-download-id]')||(parseFloat(getComputedStyle(n.querySelector('small')).fontSize)>=12&&parseFloat(getComputedStyle(n.querySelector('strong')).fontSize)>=14)})()`,`${label} readable labels ${width}`);
          await check(point(selector),`${label} hit ${width}`);
          await check(`(()=>{const n=${target(selector)},r=n.getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth+1&&r.height>=44&&r.width>=44&&r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1})()`,`${label} bounds ${width}`);
        }
        if(width===320)await writeFile(`/tmp/showpilot-landing-${label}-320.png`,Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));
      }
    };
    const open=path=>page("Page.navigate",{url:`${origin}${path}`});
    const downloaded=(name,expected=artifact)=>poll(async()=>{try{return(await readFile(join(downloads,name),"utf8"))===expected;}catch(error){if(error.code==="ENOENT")return false;throw error;}},`downloaded ${name}`);
    // CDP evaluation remains available while normal page scripts are disabled.
    await page("Emulation.setScriptExecutionDisabled",{value:true});
    await open("/#downloads");await text("CHECK AVAILABILITY");
    assert.equal(await evaluate("performance.getEntriesByType('resource').some(r=>r.name.includes('/downloads/manifest.json'))"),false);
    const ids=await evaluate("[...document.querySelectorAll('[data-download-id]')].map(n=>n.dataset.downloadId)");assert.equal(ids.length,8);
    for(const id of ids)assert.equal(await evaluate(`document.querySelector('[data-download-id="${id}"]').getAttribute('href')`),`/downloads/${id}`);
    await geometry(ids.map(id=>`[data-download-id="${id}"]`),"downloads-no-js");
    await click('[data-download-id="desktop-macos-arm64"]');await downloaded(desktop.fileName);
    await click('[data-download-id="desktop-windows-x64"]');await text("Download unavailable");
    await geometry(['a[href=""]','a[href="/#downloads"]','a[href="https://app.showpilot.tech"]'],"unavailable-no-js");
    await bucket.put(windows.key,artifact);await publish([desktop,windows,mobile]);
    await click('a[href=""]');await downloaded(windows.fileName);
    await open("/concept/");await check("!!document.querySelector('a[href=\"/#product\"]')","concept Product link");await click('a[href="/#product"]');
    await check("location.pathname==='/'&&location.hash==='#product'&&!!document.getElementById('product')","Product target reached without JavaScript");
    console.log("No-JavaScript downloads, retry and Product navigation passed");
    // Leave the document before enabling scripts: a hash-only navigation would
    // otherwise retain the page loaded with JavaScript disabled.
    await page("Page.navigate",{url:"about:blank"});
    // Ignore abort in this browser fault to prove the UI deadline itself settles.
    await page("Emulation.setScriptExecutionDisabled",{value:false});
    await page("Page.addScriptToEvaluateOnNewDocument",{source:`window.landingErrors=[];window.holdManifest=true;
      addEventListener('error',e=>window.landingErrors.push(e.message));addEventListener('unhandledrejection',e=>window.landingErrors.push(String(e.reason)));
      const original=window.fetch;window.fetch=(input,options)=>{const url=input instanceof Request?input.url:String(input);if(window.holdManifest&&url.includes('/downloads/manifest.json'))return new Promise(()=>{});return original(input,options);};`});
    await open("/#downloads");await text("STATUS UNAVAILABLE");
    await geometry(['[data-download-id="bridge-windows-x64"]'],"status-timeout");
    assert.deepEqual(await evaluate("window.landingErrors"),[]);
    await click('[data-download-id="bridge-windows-x64"]');await text("Download unavailable");
    // An invalid manifest is an actual Worker failure, not an invented browser response.
    await bucket.put("manifests/releases.json","{");await open("/downloads/desktop-macos-arm64");await text("Could not check this download");
    await geometry(['a[href=""]','a[href="/#downloads"]','a[href="https://app.showpilot.tech"]'],"service-recovery");
    const updated={...desktop,version:"0.1.1-fixture",key:"releases/fixture/desktop-updated.dmg",fileName:"ShowPilot-fixture-updated.dmg"};
    const updatedBytes="updated-disposable-showpilot-fixture";
    updated.size=updatedBytes.length;await bucket.put(updated.key,updatedBytes);await publish([updated,windows,mobile]);
    await click('a[href=""]');await downloaded(updated.fileName,updatedBytes);
    assert.deepEqual(await evaluate("window.landingErrors??[]"),[]);
    // Restore normal fetch on each new document for the final published metadata check.
    await page("Page.addScriptToEvaluateOnNewDocument",{source:"window.holdManifest=false"});
    await open("/#downloads");await text("0.1.1-FIXTURE");
    assert.equal(await evaluate("[...document.querySelectorAll('[data-download-id] small')].every(n=>parseFloat(getComputedStyle(n).fontSize)>=12)"),true);
    await geometry(['[data-download-id="desktop-macos-arm64"]','[data-download-id="mobile-ios"]'],"published");
    assert.deepEqual(await evaluate("window.landingErrors"),[]);
  });
  console.log(JSON.stringify({result:"passed",noJavaScriptDownloads:true,sameUrlUsesCurrentRelease:true,publishedStoreRedirect:true,unpublishedRecovery:true,invalidManifestRecovery:true,stalledStatusBounded:true,conceptProductAnchor:true,trialDays:14,releaseSmoke:true,widths:[320,768,1440],browserErrors:[],productionWrites:0}));
}finally{await runtime?.dispose();await rm(directory,{recursive:true,force:true});}
