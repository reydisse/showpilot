// Compiled UI and Worker: lose the reply after D1 has committed, then retry or refresh.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";

for (const scenario of ["retry", "refresh"]) await withLocalSmokeFixture(async ({ origin, operatorCookie, queryFixture, capturedEmails, stopServer }) => {
  let savedId, receiptId;
  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    await page("Page.enable");
    await page("Page.addScriptToEvaluateOnNewDocument", { source: `
      window.creationErrors=[];window.creationFault='none';window.creationCommitted=null;window.creationRequests=[];
      addEventListener('error',event=>window.creationErrors.push(event.message));
      addEventListener('unhandledrejection',event=>window.creationErrors.push(String(event.reason)));
      const original=window.fetch;
      window.fetch=async(input,options)=>{
        const url=input instanceof Request?input.url:String(input),fault=window.creationFault;
        if(url.includes('/api/auth/organization/creation-result')&&fault==='read')return new Promise(()=>{});
        const create=url.includes('/api/auth/organization/create');
        if(create)window.creationRequests.push({body:options?.body,key:new Headers(options?.headers).get('Idempotency-Key')});
        const response=await original(input,options);
        if(!create||fault!=='create')return response;
        const body=await response.text();window.creationCommitted={status:response.status,body:JSON.parse(body)};
        return new Promise(resolve=>{window.releaseCreation=()=>resolve(new Response(body,{status:response.status,headers:response.headers}));});
      };` });
    const check = (expression, label) => poll(() => evaluate(expression), label).catch(async error => {
      console.log(JSON.stringify({ scenario, label, body: await evaluate("document.body?.innerText"), url: await evaluate("location.href"), errors: await evaluate("window.creationErrors") }));
      await writeFile(`/tmp/showpilot-organization-recovery-${scenario}-failure.png`, Buffer.from((await page("Page.captureScreenshot", { format: "png" })).data, "base64")); throw error;
    });
    const text = value => check(`document.body?.innerText.includes(${JSON.stringify(value)})`, value);
    const button = name => `[...(document.querySelector('[role=dialog][data-state=open]')??document).querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(name)}&&!n.disabled&&!n.closest('[role=dialog][data-state=closed]')&&n.getBoundingClientRect().height>0)`;
    const point = name => `(async()=>{const n=${button(name)};if(!n)return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));for(let p=n;p;p=p.parentElement)if(p.getAnimations().some(a=>a.playState==='running'))return null;const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return !n.disabled&&n.contains(document.elementFromPoint(x,y))?{x,y}:null})()`;
    const click = async name => {
      const position = await poll(() => evaluate(point(name)), `reachable ${name}`);
      await page("Input.dispatchMouseEvent", { type: "mousePressed", ...position, button: "left", clickCount: 1 });
      await page("Input.dispatchMouseEvent", { type: "mouseReleased", ...position, button: "left", clickCount: 1 });
    };
    await page("Page.navigate", { url: `${origin}/setup?mode=new` });
    await text("Create another organization");
    await click("Exit setup"); await text("Exit setup?"); await click("Keep setting up");
    await check("!document.querySelector('[role=dialog]')", "hydrated form");
    await evaluate(`(()=>{const n=document.getElementById('organization-name');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,'Recovery ${scenario} fixture');n.dispatchEvent(new Event('input',{bubbles:true}));window.creationFault='create';})()`);
    await click("Create organization");
    await check("window.creationCommitted?.status===200", "actual organization commit");
    savedId = await evaluate("window.creationCommitted.body.id");
    receiptId = await evaluate("new URL(location.href).searchParams.get('creationRequestId')");
    assert.equal(await evaluate("window.creationCommitted.body.creationRequestId"), receiptId);
    await text("Organization creation was not confirmed.");
    assert.equal(await evaluate("document.getElementById('organization-name').readOnly"), true);
    assert.equal(await evaluate("document.body.innerText.includes('What are you running?')"), false);
    if (scenario === "retry") {
      await evaluate("window.releaseCreation();window.creationFault='none'");
      await check(`!!(${button("Retry creation")})`, "late reply ignored");
      for (const [width,height] of [[320,568],[768,1024],[1440,900]]) {
        await page("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
        for (const name of ["Retry creation", "Check saved workspace"]) {
          await check(point(name), `${name} hit at ${width}`);
          await check(`(()=>{const n=${button(name)},r=n.getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth+1&&document.querySelector('.spob').scrollWidth<=innerWidth+1&&r.width>=44&&r.height>=44&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()`, `${name} bounds at ${width}`);
        }
        if (width === 320) await writeFile("/tmp/showpilot-organization-recovery-error-320.png", Buffer.from((await page("Page.captureScreenshot", { format: "png" })).data, "base64"));
      }
      await click("Retry creation"); await text("What are you running?");
      const requests = await evaluate("window.creationRequests"); assert.equal(requests.length, 2); assert.deepEqual(requests[0], requests[1]);
    } else {
      await page("Page.reload");
      await poll(async () => { try { await page("Page.handleJavaScriptDialog", { accept: true }); return true; } catch(error) { if(!error.message.includes("No dialog is showing")) throw error; return false; } }, "reload warning accepted");
      await text("Saved workspace:");
      assert.equal(await evaluate("window.creationRequests.length"), 0);
      assert.equal(await evaluate("document.body.innerText.includes('What are you running?')"), false);
      await evaluate("window.creationFault='read'"); await click("Check saved workspace");
      await text("Organization creation was not confirmed.");
      await evaluate("window.creationFault='none'"); await click("Check saved workspace");
      await text("Saved workspace:");
      await click("Continue setup"); await text("What are you running?");
      assert.equal(await evaluate("window.creationRequests.length"), 0);
    }
    assert.equal(await evaluate("new URL(location.href).searchParams.get('orgId')"), savedId);
    assert.deepEqual(await evaluate("window.creationErrors"), []);
  });
  assert.equal((await capturedEmails()).length, 0); await stopServer();
  const organizations = await queryFixture(`SELECT id FROM organization WHERE slug='recovery-${scenario}-fixture'`);
  assert.deepEqual(organizations, [{id:savedId}]);
  assert.equal((await queryFixture(`SELECT COUNT(*) AS count FROM member WHERE organizationId='${savedId}' AND role='owner'`))[0].count, 1);
  assert.equal((await queryFixture(`SELECT COUNT(*) AS count FROM organization_creation_receipt WHERE userId='smoke-operator' AND requestId='${receiptId}' AND orgId='${savedId}'`))[0].count, 1);
  assert.equal((await queryFixture(`SELECT COUNT(*) AS count FROM app_setting WHERE orgId='${savedId}' AND key='onboarding-started'`))[0].count, 1);
  assert.equal((await queryFixture(`SELECT COUNT(*) AS count FROM app_setting WHERE orgId='${savedId}' AND key='onboarding-completed'`))[0].count, 0);
  console.log(JSON.stringify({ scenario, result: "passed", actualCommitBeforeLostReply: true, oneOrganization: true, oneOwner: true, atomicCheckpoint: true, explicitRecovery: true, browserErrors: [] }));
}, { captureEmail: true });
