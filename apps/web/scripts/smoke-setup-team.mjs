// Built setup form, real crew/invitation writes and a local-only email provider.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";

await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, capturedEmails, stopServer, queryFixture }) => {
  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    await page("Page.enable");
    await page("Page.addScriptToEvaluateOnNewDocument", { source: `
      window.setupErrors=[];window.setupWrites=[];
      addEventListener('error',event=>window.setupErrors.push(event.message));
      addEventListener('unhandledrejection',event=>window.setupErrors.push(String(event.reason)));
      const original=window.fetch;
      window.fetch=(input,options)=>{
        const url=input instanceof Request?input.url:String(input);
        if(url.includes('/_serverFn/')&&(options?.method??(input instanceof Request?input.method:'GET'))==='POST')window.setupWrites.push(url);
        return original(input,options);
      };` });
    const check = (expression, label) => poll(() => evaluate(expression), label).catch(async error => {
      console.log(JSON.stringify({ label, page: await evaluate("document.body?.innerText"), path: await evaluate("location.pathname") }));
      await writeFile("/tmp/showpilot-setup-team-failure.png", Buffer.from((await page("Page.captureScreenshot", { format: "png" })).data, "base64"));
      throw error;
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
    const fill = (id, value) => evaluate(`(()=>{const node=document.getElementById(${JSON.stringify(id)});Object.getOwnPropertyDescriptor(node instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event(node instanceof HTMLSelectElement?'change':'input',{bubbles:true}));})()`);
    await page("Page.navigate", { url: `${origin}/setup?orgId=${orgId}` });
    await text("Build your team."); await text("Step 6 of 6");
    // Adding a row proves hydration before editing controlled values.
    await click("Add another crew member"); await check("!!document.getElementById('crew-1-name')", "hydrated extra row");
    await fill("crew-0-name", " Camera fixture ");
    await fill("invite-0-email", "invalid-email");
    await click("Finish setup"); await text("2 rows need attention.");
    assert.equal(await evaluate("document.activeElement.id"), "crew-0-pos");
    assert.deepEqual(await evaluate("window.setupWrites"), []);
    assert.equal((await capturedEmails()).length, 0);
    assert.equal(await evaluate("document.getElementById('crew-0-name').value"), " Camera fixture ");
    assert.equal(await evaluate("document.getElementById('invite-0-email').value"), "invalid-email");

    for (const [width, height] of [[320,568],[768,1024],[1440,900]]) {
      await page("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      const ids = await evaluate("[...document.querySelectorAll('form input,form select,form button')].map((node,index)=>{node.dataset.smokeControl=String(index);return index})");
      for (const id of ids) await check(`(async()=>{
        const node=document.querySelector('[data-smoke-control="${id}"]');node.scrollIntoView({block:'center'});
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        for(let parent=node;parent;parent=parent.parentElement)if(parent.getAnimations().some(animation=>animation.playState==='running'))return false;
        const r=node.getBoundingClientRect();
        const named=node.tagName==='BUTTON'||node.labels?.length>0;
        return named&&document.documentElement.scrollWidth<=innerWidth+1&&document.querySelector('.spob').scrollWidth<=innerWidth+1&&r.height>=44&&r.width>=44&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
      })()`, `control ${id} labelled and reachable at ${width}`);
      await evaluate("document.querySelector('.spob').scrollTop=0");
      await check(`(()=>{const nodes=[...document.querySelector('.spob > div').children];if(nodes.length!==2)return false;const [a,b]=nodes.map(node=>node.getBoundingClientRect());return a.left>=0&&b.left>=0&&a.right<=innerWidth&&b.right<=innerWidth&&(a.right<=b.left||a.bottom<=b.top)})()`, `non-overlapping header at ${width}`);
      if (width === 320) {
        await writeFile("/tmp/showpilot-setup-team-error-320.png", Buffer.from((await page("Page.captureScreenshot", { format: "png" })).data, "base64"));
        await evaluate("document.getElementById('invite-0-email').scrollIntoView({block:'center'})");
        await writeFile("/tmp/showpilot-setup-team-invite-320.png", Buffer.from((await page("Page.captureScreenshot", { format: "png" })).data, "base64"));
      }
    }
    await fill("crew-0-pos", " Camera 2 "); await fill("invite-0-email", " Lead@display-smoke.invalid ");
    await click("Add another invitation"); await fill("invite-1-email", "lead@display-smoke.invalid");
    await click("Finish setup"); await text("2 rows need attention.");
    await text("This email appears more than once. Keep one invitation.");
    assert.deepEqual(await evaluate("window.setupWrites"), []);
    await click("Clear invitation row 2");
    await fill("invite-1-role", "admin"); await click("Finish setup"); await text("1 row needs attention.");
    assert.deepEqual(await evaluate("window.setupWrites"), []);
    await click("Clear invitation row 2");
    await check("!document.querySelector('[role=alert]')", "explicitly cleared optional row");
    await text("1 complete crew row and 1 complete invitation row.");
    assert.deepEqual(await evaluate("window.setupErrors"), []);
    await fill("invite-0-role", "td");
    await click("Finish setup");
    await check(`location.pathname.startsWith('/${orgId}/')`, "workspace after real saves");
    await text("Show Flow");
    assert.deepEqual(await evaluate("window.setupErrors"), []);
  });
  const emails = await capturedEmails();
  assert.equal(emails.length, 1); assert.equal(emails[0].to, "lead@display-smoke.invalid"); assert.equal(emails[0].delivered, true);
  await stopServer();
  assert.deepEqual(await queryFixture("SELECT name,role FROM crew_member WHERE orgId='display-smoke'"), [{ name: "Camera fixture", role: "Camera 2" }]);
  assert.deepEqual(await queryFixture("SELECT email,role,status FROM invitation WHERE organizationId='display-smoke'"), [{ email: "lead@display-smoke.invalid", role: "td", status: "pending" }]);
  assert.equal((await queryFixture("SELECT value FROM app_setting WHERE orgId='display-smoke' AND key='onboarding-completed'")).length, 1);
  assert.equal((await queryFixture("SELECT id FROM crew_member WHERE orgId='display-other'")).length, 0);
  assert.equal((await queryFixture("SELECT id FROM invitation WHERE organizationId='display-other'")).length, 0);
  console.log(JSON.stringify({ invalidRowsBlockAllWrites: "passed", duplicates: "passed", roleWithoutEmail: "passed", explicitClear: "passed", normalizedRealSaves: "passed", oneLocalInvitationEmail: "passed", fieldLabelsAnd44pxTargets: "passed at 320/768/1440", responsiveHeader: "passed", databaseInspection: "passed" }, null, 2));
}, { setupTeam: true, captureEmail: true });
