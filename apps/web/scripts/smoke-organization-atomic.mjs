// Built Worker, actual auth HTTP route, and a real D1 owner-insert failure.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";

await withLocalSmokeFixture(async ({ origin, operatorCookie, queryFixture, capturedEmails, stopServer }) => {
  let recoveredId, nativeId;
  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    await page("Page.enable");
    await page("Page.addScriptToEvaluateOnNewDocument", { source: `window.creationErrors=[];
      addEventListener('error',event=>window.creationErrors.push(event.message));
      addEventListener('unhandledrejection',event=>window.creationErrors.push(String(event.reason)));` });
    const check = (expression, label) => poll(() => evaluate(expression), label).catch(async error => {
      console.log(JSON.stringify({ label, body: await evaluate("document.body?.innerText"), errors: await evaluate("window.creationErrors") }));
      await writeFile("/tmp/showpilot-organization-atomic-failure.png", Buffer.from((await page("Page.captureScreenshot", { format: "png" })).data, "base64"));
      throw error;
    });
    const text = value => check(`document.body?.innerText.includes(${JSON.stringify(value)})`, value);
    const button = name => `[...(document.querySelector('[role=dialog][data-state=open]')??document).querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(name)}&&!n.disabled&&!n.closest('[role=dialog][data-state=closed]')&&n.getBoundingClientRect().height>0)`;
    const point = name => `(async()=>{const n=${button(name)};if(!n)return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));for(let p=n;p;p=p.parentElement)if(p.getAnimations().some(a=>a.playState==='running'))return null;const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null})()`;
    const click = async name => {
      const position = await poll(() => evaluate(point(name)), `reachable ${name}`);
      await page("Input.dispatchMouseEvent", { type: "mousePressed", ...position, button: "left", clickCount: 1 });
      await page("Input.dispatchMouseEvent", { type: "mouseReleased", ...position, button: "left", clickCount: 1 });
    };
    const fill = value => evaluate(`(()=>{const n=document.getElementById('organization-name');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await page("Page.navigate", { url: `${origin}/setup?mode=new` });
    await text("Create another organization");
    await click("Exit setup"); await text("Exit setup?"); await click("Keep setting up");
    await check("!document.querySelector('[role=dialog]')", "hydrated creation form");
    await fill("Atomic failure fixture"); await click("Create organization");
    await text("Organization creation was not confirmed.");
    assert.equal(await evaluate("document.getElementById('organization-name').value"), "Atomic failure fixture");
    assert.equal(await evaluate("location.search"), "?mode=new");
    for (const [width, height] of [[320,568], [768,1024], [1440,900]]) {
      await page("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await check(point("Create organization"), `retry reachable at ${width}`);
      await check(`(()=>{const n=${button("Create organization")},r=n.getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth+1&&document.querySelector('.spob').scrollWidth<=innerWidth+1&&r.width>=44&&r.height>=44&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()`, `retry bounds at ${width}`);
      if (width === 320) await writeFile("/tmp/showpilot-organization-atomic-error-320.png", Buffer.from((await page("Page.captureScreenshot", { format: "png" })).data, "base64"));
    }
    await fill("Atomic recovered fixture"); await click("Create organization"); await text("What are you running?");
    recoveredId = await evaluate("new URL(location.href).searchParams.get('orgId')"); assert.ok(recoveredId);
    const native = await evaluate(`fetch('/api/auth/organization/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Native compatibility fixture',slug:'native-compatibility-fixture',metadata:{fixture:'native'}})}).then(async r=>({status:r.status,body:await r.json()}))`);
    assert.equal(native.status, 200); nativeId = native.body.id; assert.ok(nativeId);
    assert.deepEqual(native.body.metadata, { fixture: "native" });
    const session = await evaluate("fetch('/api/auth/get-session').then(r=>r.json())");
    assert.equal(session.session.activeOrganizationId, nativeId);
    assert.deepEqual(await evaluate("window.creationErrors"), []);
  });

  const send = (body, headers) => fetch(`${origin}/api/auth/organization/create`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: operatorCookie, Origin: origin, ...headers }, body: JSON.stringify(body),
  });
  const forbidden = await send({ name: "Foreign origin", slug: "foreign-origin-fixture" }, { Origin: "https://untrusted.invalid", "cf-connecting-ip": "192.0.2.170" });
  assert.equal(forbidden.status, 403); await forbidden.arrayBuffer();
  const expo = await send({ name: "Expo fixture", slug: "expo-compatibility-fixture", keepCurrentActiveOrganization: true }, { Origin: "showpilot://", "expo-origin": "showpilot://", "cf-connecting-ip": "192.0.2.171" });
  assert.equal(expo.status, 200); await expo.arrayBuffer();
  for (let i = 0; i < 11; i++) {
    const response = await send({ name: "   ", slug: "rate-limit-fixture" }, { "cf-connecting-ip": "192.0.2.172" });
    assert.equal(response.status, i < 10 ? 400 : 429, `rate limit attempt ${i + 1}`); await response.arrayBuffer();
  }
  assert.equal((await capturedEmails()).length, 0); await stopServer();
  assert.equal((await queryFixture("SELECT COUNT(*) AS count FROM organization WHERE slug IN ('atomic-failure-fixture','foreign-origin-fixture','rate-limit-fixture')"))[0].count, 0);
  const rows = await queryFixture("SELECT o.id,o.slug,o.cloud_enabled,o.createdAt,o.trialEndsAt,m.userId,m.role FROM organization o JOIN member m ON m.organizationId=o.id WHERE o.slug IN ('atomic-recovered-fixture','native-compatibility-fixture','expo-compatibility-fixture') ORDER BY o.slug");
  assert.equal(rows.length, 3);
  for (const row of rows) { assert.equal(row.userId, "smoke-operator"); assert.equal(row.role, "owner"); assert.equal(row.cloud_enabled, 1); assert.equal(new Date(row.trialEndsAt).getTime() - new Date(row.createdAt).getTime(), 14 * 24 * 60 * 60 * 1000); }
  assert.ok(rows.some(row => row.id === recoveredId)); assert.ok(rows.some(row => row.id === nativeId));
  assert.equal((await queryFixture("SELECT COUNT(*) AS count FROM app_setting WHERE key='onboarding-completed'"))[0].count, 0);
  console.log(JSON.stringify({ result: "passed", ownerInsertRollback: true, wizardRecovery: true, nativeDefaultActiveWorkspace: true, expoOrigin: true, foreignOriginDenied: true, rateLimit: true, createdOrganizations: rows.length, widths: [320,768,1440], browserErrors: [] }));
}, { organizationCreationFailures: true, captureEmail: true });
