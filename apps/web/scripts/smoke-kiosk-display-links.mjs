// Actual Settings-generated links opened without an operator session.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";

await withLocalSmokeFixture(async ({ origin, orgId, browser, operatorEmail, operatorPassword, queryFixture }) => {
  const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
  const evaluate = async source => (await browser("eval", source)).result;
  await browser("open", `${origin}/login`);
  await browser("fill", "#email", operatorEmail);
  await browser("fill", "#password", operatorPassword);
  await click("Sign in");
  await browser("wait", "--url", `**/${orgId}/**`);
  await browser("open", `${origin}/${orgId}/settings?section=kiosk`);
  await click("Access Tokens");
  const issued = [];
  for (const purpose of ["timer", "overlay"]) {
    await browser("select", 'label:has-text("Token purpose") select', purpose);
    await browser("fill", '[aria-label="Token label"]', `Fixture ${purpose}`);
    await click("Generate");
    await browser("wait", "text=Open display to check");
    const url = await evaluate('[...document.querySelectorAll("a")].find(link=>link.textContent.trim()==="Open display to check").href');
    const token = await evaluate(`document.querySelector('textarea[aria-label="New token"]').value`);
    assert.equal(new URL(url).pathname, `/${purpose}/${orgId}`);
    assert.equal(new URL(url).searchParams.get("kioskToken"), token);
    assert.equal(await evaluate(`document.querySelector('textarea[aria-label="New display link"]').value`), url);
    for (const [width,height] of [[320,480],[768,900],[1440,900]]) {
      await browser("set", "viewport", String(width), String(height));
      await browser("scrollintoview", 'a:text-is("Open display to check")');
      const layout = await evaluate(`(() => {
        const section=document.querySelector('[aria-label="New access token"]');
        return {fits:section.scrollWidth<=section.clientWidth+1&&document.documentElement.scrollWidth<=innerWidth,
          targets:[...section.querySelectorAll('button,a')].map(el=>{const r=el.getBoundingClientRect();return {height:r.height,width:r.width,left:r.left,right:r.right};})};
      })()`);
      assert.ok(layout.fits,JSON.stringify(layout));
      assert.ok(layout.targets.every(t=>t.height>=44&&t.width>=44&&t.left>=0&&t.right<=width),JSON.stringify(layout));
      if(width===320)await browser("screenshot",`/tmp/showpilot-kiosk-${purpose}-link-320.png`);
    }
    await withRealBrowser({origin},async({page,evaluate:display})=>{
      await page("Page.navigate",{url});
      await poll(()=>display(`document.body?.textContent.includes(${JSON.stringify(purpose==="timer"?"Fixture private stage message":"Fixture overlay title")})`),`${purpose} anonymous output`);
      assert.equal(await display("new URL(location.href).searchParams.has('kioskToken')"),false);
      assert.equal(await display("location.pathname"),`/${purpose}/${orgId}`);
      assert.equal(await display("document.cookie.includes('sp_display_')"),false);
    });
    issued.push({purpose,token,url});
    await click("Dismiss token");
    assert.equal(await evaluate(`!!document.querySelector('textarea[aria-label="New display link"]')`),false);
    assert.equal(await evaluate(`document.body.textContent.includes(${JSON.stringify(token)})`),false);
    await browser("reload");
    await click("Access Tokens");
    await browser("wait",`text=Fixture ${purpose}`);
    assert.equal(await evaluate(`!!document.querySelector('textarea[aria-label="New token"]')`),false);
  }
  await browser("find","role","button","click","--name","Revoke Fixture timer","--exact");
  await click("Revoke token");
  await browser("wait","--fn","!document.querySelector('[role=dialog]')");
  const timer = issued.find(item=>item.purpose==="timer");
  await withRealBrowser({origin},async({page,evaluate:display})=>{
    await page("Page.navigate",{url:timer.url});
    await poll(()=>display("document.body?.textContent.includes('This display needs a valid link')"),"revoked kiosk link denied");
    assert.equal(await display("document.body.textContent.includes('Fixture private stage message')"),false);
  });
  const rows = await queryFixture("SELECT view,token,revokedAt FROM kiosk_token WHERE orgId='display-smoke' ORDER BY view");
  assert.equal(rows.length,2);
  for(const row of rows) {
    assert.ok(!issued.some(item=>item.token===row.token),"Plaintext token must not be stored");
    assert.equal(Boolean(row.revokedAt),row.view==="timer");
  }
  console.log(JSON.stringify({passed:true,settingsLinks:["timer","overlay"],anonymousOutput:true,tokenRemovedFromUrl:true,dismissAndReloadHideSecrets:true,revokedLinkDenied:true,viewports:[320,768,1440],tokens:rows.length}));
}, {paidPlan:true});
