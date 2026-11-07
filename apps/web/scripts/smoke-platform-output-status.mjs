// Read-only provider fixture: no real Stream account, paid input or broadcast.
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";

const audit = process.argv.includes("--audit");
const assets = resolve(import.meta.dirname, "../dist/server/assets");
let rpc;
for (const file of (await readdir(assets)).filter(file => file.endsWith(".js"))) {
  rpc ??= (await readFile(resolve(assets,file),"utf8")).match(/const getOutputStatuses_createServerFn_handler = createServerRpc\(\{\s*id: "([^"]+)"/)?.[1];
}
assert.ok(rpc);
await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, configureStreamOutputs, streamOutputRequests, stopServer, queryFixture }) => {
  let polls;
  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    await page("Emulation.setFocusEmulationEnabled",{enabled:true});
    await page("Page.enable");
    await page("Page.addScriptToEvaluateOnNewDocument",{source:`window.statusErrors=[];window.outputPolls=0;window.outputResponses=[];window.outputReplies=[];window.holdOutput=false;
      addEventListener('error',e=>window.statusErrors.push(e.message));addEventListener('unhandledrejection',e=>window.statusErrors.push(String(e.reason)));
      const original=window.fetch;window.fetch=(input,options)=>{const url=input instanceof Request?input.url:String(input);if(!url.includes(${JSON.stringify(rpc)}))return original(input,options);window.outputPolls++;const held=window.holdOutput;return original(input,options).then(async response=>{const body=await response.clone().text();window.outputResponses.push({status:response.status,body});return held?new Promise(resolve=>window.outputReplies.push(()=>resolve(new Response(body,{status:response.status,headers:response.headers})))):response;});};`});
    const check = (code,label) => poll(()=>evaluate(code),label).catch(async error => {
      console.log(JSON.stringify({label,body:await evaluate("document.body?.innerText"),errors:await evaluate("window.statusErrors")}));
      await writeFile("/tmp/showpilot-output-status-failure.png",Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));throw error;
    });
    const clickRetry = async () => {
      const point=await check(`(async()=>{const n=document.querySelector('button[aria-label="Retry output status"]');if(!n||n.disabled)return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`,"reachable Retry");
      await page("Input.dispatchMouseEvent",{type:"mousePressed",...point,button:"left",clickCount:1});
      await page("Input.dispatchMouseEvent",{type:"mouseReleased",...point,button:"left",clickCount:1});
    };
    await page("Emulation.setDeviceMetricsOverride",{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await page("Page.navigate",{url:`${origin}/${orgId}/streaming/platforms`});
    await check("window.outputResponses?.length>0&&document.body?.innerText.includes('Fixture enabled')","provider status received");
    if(audit) {
      await check("document.body.innerText.includes('Connecting to 4 platforms')","incorrect endless connecting summary");
      await evaluate("window.holdOutput=true;document.dispatchEvent(new Event('visibilitychange'))");
      await check("window.outputReplies.length>0","held successful poll");
      const deadline=Date.now()+9_000;await poll(()=>Date.now()>deadline,"poll deadline");
      assert.equal(await evaluate("!!document.querySelector('button[aria-label=\"Retry output status\"]')"),false);
      console.log(JSON.stringify({reproduced:{enabledShownAsConnecting:true,pollTimeoutHasNoRecovery:true}}));
      return;
    }
    await check("document.body.innerText.includes('1 output enabled')&&document.body.innerText.includes('Output disabled')&&document.body.innerText.includes('Output missing at provider')&&document.body.innerText.includes('Connection unconfirmed')","honest provider states");
    assert.equal(await evaluate("document.body.innerText.includes('Connecting to 4 platforms')||document.body.innerText.includes('Relay ready')"),false);
    assert.equal(await evaluate("JSON.stringify(window.outputResponses).includes('fixture-private-provider-key')"),false);
    await evaluate("window.holdOutput=true;document.dispatchEvent(new Event('visibilitychange'))");
    await check("window.outputReplies.length>0","held successful poll");
    await check("!!document.querySelector('button[aria-label=\"Retry output status\"]')","bounded transport failure");
    assert.equal(await evaluate("document.body.innerText.includes('Last confirmed: 1 output enabled')"),true);
    for(const [width,height] of [[320,780],[768,1024],[1440,1000]]) {
      await page("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false});
      await check(`(async()=>{const n=document.querySelector('button[aria-label="Retry output status"]');n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect();return b.height>=44&&b.left>=0&&b.right<=innerWidth&&n.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))&&document.documentElement.scrollWidth<=innerWidth+1;})()`,`Retry bounds ${width}`);
      if(width===320) await writeFile("/tmp/showpilot-output-status-320.png",Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));
    }
    await evaluate("window.holdOutput=false");await clickRetry();
    await check("!document.querySelector('button[aria-label=\"Retry output status\"]')&&!document.body.innerText.includes('Last confirmed:')","transport recovery");
    await configureStreamOutputs("error");
    await evaluate("document.dispatchEvent(new Event('visibilitychange'))");
    await check("document.body.innerText.includes('3 statuses unavailable')&&!!document.querySelector('button[aria-label=\"Retry output status\"]')","provider failure visible");
    await evaluate("window.outputReplies.splice(0).forEach(release=>release())");
    await check("document.body.innerText.includes('3 statuses unavailable')&&!document.body.innerText.includes('1 output enabled')","late successful poll cannot replace newer failure");
    await configureStreamOutputs("malformed");await clickRetry();
    await check("!document.querySelector('button[aria-label=\"Retry output status\"]').disabled&&document.body.innerText.includes('3 statuses unavailable')","malformed provider response is unknown");
    await configureStreamOutputs("slow");await clickRetry();
    await check("!document.querySelector('button[aria-label=\"Retry output status\"]').disabled&&document.body.innerText.includes('3 statuses unavailable')","slow provider bounded");
    await configureStreamOutputs("success");await clickRetry();
    await check("!document.querySelector('button[aria-label=\"Retry output status\"]')&&document.body.innerText.includes('1 output enabled')","provider Retry recovers");
    assert.deepEqual(await evaluate("window.statusErrors"),[]);
    polls=await evaluate("window.outputPolls");
  });
  const requests=await streamOutputRequests();
  assert.ok(requests.length>0&&requests.every(request=>request.method==="GET"));
  if(!audit) assert.ok(requests.length<=polls,"one provider request per live input in each poll");
  await stopServer();
  const rows=await queryFixture("SELECT id,cfOutputId,enabled FROM stream_destination WHERE orgId='display-smoke' ORDER BY id");
  assert.deepEqual(rows,["disabled","enabled","missing","pending"].map(kind=>({
    id:`smoke-${kind}`,cfOutputId:kind==="pending"?"pending:1:fixture":`fixture-output-${kind}`,enabled:1,
  })),"read-only status recovery leaves every configured output unchanged");
  console.log(JSON.stringify({passed:!audit,audited:audit,providerReads:requests.length,polls,unchangedDestinations:rows.length}));
},{streamOutputs:true});
