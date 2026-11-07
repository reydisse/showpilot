// Compiled Settings UI with real authentication, billing reads and timezone writes.
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";

const ids = {};
const assets = resolve(import.meta.dirname, "../dist/server/assets");
for (const file of (await readdir(assets)).filter(file => file.endsWith(".js"))) {
  const source = await readFile(resolve(assets, file), "utf8");
  for (const name of ["updateOrgSetting", "createCheckoutSession", "createPortalSession"])
    ids[name] ??= source.match(new RegExp(`const ${name}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`))?.[1];
}
assert.equal(Object.values(ids).filter(Boolean).length, 3);

await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, stopServer, queryFixture }) => {
  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    await page("Page.enable");
    await page("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page("Page.addScriptToEvaluateOnNewDocument", { source: `
      window.clarityErrors=[];window.clarityWrites=0;window.clarityPayments=0;
      addEventListener('error',e=>window.clarityErrors.push(e.message));
      addEventListener('unhandledrejection',e=>window.clarityErrors.push(String(e.reason)));
      const ids=${JSON.stringify(ids)}, original=window.fetch;
      window.fetch=(input,init)=>{
        const url=input instanceof Request?input.url:String(input);
        if([ids.createCheckoutSession,ids.createPortalSession].some(id=>url.includes('/_serverFn/'+id))){window.clarityPayments++;throw new Error('Payment calls forbidden in this rehearsal');}
        if(url.includes('/_serverFn/'+ids.updateOrgSetting))window.clarityWrites++;
        return original(input,init);
      };` });
    const check = (expression, label) => poll(() => evaluate(expression), label);
    const navigate = async (slug, section) => {
      await page("Page.navigate", { url: `${origin}/${slug}/settings?section=${section}` });
      await check(`!!document.querySelector('h1')&&[...document.querySelectorAll('h1')].some(n=>n.textContent===${JSON.stringify(section === "billing" ? "Billing" : "Organization")})`, `${slug} ${section}`);
      await check(`!!Object.keys(document.querySelector('button')??{}).find(k=>k.startsWith('__reactProps'))`, "hydrated UI");
    };
    const fillSearch = value => evaluate(`(()=>{const n=document.querySelector('input[type="search"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
    const select = value => evaluate(`(()=>{const n=document.querySelector('select[aria-label="Timezone"]');n.value=${JSON.stringify(value)};n.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
    for (const [name, plan, access] of [["trial","Free","Pro"],["starter","Starter","Starter"],["pro","Pro","Pro"],["founding","Founding","Pro"],["unpaid","Free","Free"],["beta","Free","Pro"],["expired","Free","Free"]]) {
      await navigate(`billing-${name}`, "billing");
      await check(`document.body.textContent.includes(${JSON.stringify(`Current plan: ${plan}`)})&&document.body.textContent.includes(${JSON.stringify(`Features available now: ${access}`)})`, `${name} plan and feature access`);
      const current = await evaluate(`[...document.querySelectorAll('[role="group"]')].filter(n=>[...n.querySelectorAll('span')].some(s=>s.textContent.trim()==='Current plan')).map(n=>n.getAttribute('aria-label'))`);
      assert.deepEqual(current, ["starter","pro","founding"].includes(name) ? [`${plan} plan`] : []);
      if (name === "trial") {
        assert.equal(await evaluate(`document.body.textContent.includes('Pro trial access:')`), true);
        for (const width of [320,768,1440]) {
          await page("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
          await check(`document.documentElement.scrollWidth<=innerWidth+1`, "billing width");
          const sizes = await evaluate(`[...document.querySelectorAll('[role="group"] button')].map(n=>({height:n.getBoundingClientRect().height,width:n.getBoundingClientRect().width}))`);
          assert.equal(sizes.length, 3); assert.ok(sizes.every(s=>s.height>=44&&s.width>=44));
          if (width === 320) await writeFile("/tmp/showpilot-settings-billing-320.png", Buffer.from((await page("Page.captureScreenshot", { format: "png" })).data,"base64"));
        }
      }
      assert.deepEqual(await evaluate("window.clarityErrors"), []);
      assert.equal(await evaluate("window.clarityPayments"), 0);
    }
    await navigate(orgId, "organization");
    await check(`!!document.querySelector('option[value="America/Toronto"]')`, "full timezone catalog");
    assert.equal(await evaluate(`document.querySelector('select[aria-label="Timezone"]').value`), "");
    await fillSearch("toronto");
    await check(`document.querySelector('select[aria-label="Timezone"]').options.length===2`, "filtered Toronto choice plus unset placeholder");
    assert.equal(await evaluate("window.clarityWrites"), 0);
    await select("America/Toronto");
    await check(`window.clarityWrites===1&&document.body.textContent.includes('General settings save automatically')`, "Toronto save acknowledged");
    await fillSearch("no such city");
    await check(`document.body.textContent.includes('No matching timezones')`, "empty search guidance");
    assert.equal(await evaluate(`document.querySelector('select[aria-label="Timezone"]').value`), "America/Toronto");
    assert.equal(await evaluate("window.clarityWrites"), 1);
    for (const width of [320,768,1440]) {
      await page("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await check(`document.documentElement.scrollWidth<=innerWidth+1`, "timezone width");
      const sizes = await evaluate(`[...document.querySelectorAll('input[type="search"],select[aria-label="Timezone"]')].map(n=>({height:n.getBoundingClientRect().height,width:n.getBoundingClientRect().width}))`);
      assert.equal(sizes.length, 2); assert.ok(sizes.every(s=>s.height>=44&&s.width>=44));
      if (width === 320) await writeFile("/tmp/showpilot-settings-timezone-320.png", Buffer.from((await page("Page.captureScreenshot", { format: "png" })).data,"base64"));
    }
    await navigate(orgId, "organization");
    await check(`document.querySelector('select[aria-label="Timezone"]')?.value==='America/Toronto'`, "saved timezone after reload");
    assert.deepEqual(await evaluate("window.clarityErrors"), []);
    assert.equal(await evaluate("window.clarityPayments"), 0);
  });
  await stopServer();
  assert.deepEqual(await queryFixture(`SELECT value FROM app_setting WHERE orgId='${orgId}' AND key='org-timezone'`), [{ value: "America/Toronto" }]);
  assert.deepEqual(await queryFixture("SELECT key FROM app_setting WHERE orgId='display-other'"), []);
  console.log(JSON.stringify({ passed: true, billingScenarios: 7, realTimezoneWriteAndReload: true, searchDoesNotWrite: true, widths: [320,768,1440], paymentCalls: 0 }));
}, { settingsBilling: true });
