// Damaged rows exist only in this disposable local D1. Real browser, Worker and authentication.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
await withLocalSmokeFixture(async ({origin,orgId,browser,operatorEmail,operatorPassword,queryFixture,repairGraphicSceneFixtures}) => {
  const evaluate=async expression=>(await browser("eval",expression)).result;
  const click=name=>browser("find","role","button","click","--name",name,"--exact");
  const confirm=name=>browser("click",`[role="dialog"] button:text-is(${JSON.stringify(name)})`);
  const active=()=>queryFixture(`SELECT value FROM app_setting WHERE orgId='${orgId}' AND key='active-graphics'`);
  const primary=()=>evaluate(`document.querySelector('input[aria-label="Primary text"]').value`);
  await browser("open",`${origin}/login`); await browser("fill","#email",operatorEmail); await browser("fill","#password",operatorPassword);
  await click("Sign in"); await browser("wait","--url",`**/${orgId}/**`);
  await browser("open",`${origin}/${orgId}/streaming/lt-preview`);
  await browser("wait",'[aria-label="Refresh saved scenes"] time');
  assert.equal(await evaluate(`document.querySelector('button[aria-label="Load scene Damaged layers"]').disabled`),true);
  assert.equal(await evaluate(`document.querySelector('button[aria-label="Load scene Unreadable scene"]').disabled`),true);
  const initialProgram=await active();
  await click("Custom"); await browser("fill",'input[aria-label="Primary text"]',"Keep my draft");
  await browser("fill",'input[aria-label="Scene name"]',"Keep my name");
  await click("Load scene Future template"); await confirm("Load scene");
  await browser("wait",'[aria-label="Refresh scene library"] time');
  assert.equal(await primary(),"Keep my draft");
  assert.equal(await evaluate(`document.querySelector('input[aria-label="Scene name"]').value`),"Keep my name");
  assert.deepEqual(await active(),initialProgram);
  await click("Delete scene Mismatched ID"); await confirm("Cancel");
  assert.equal((await queryFixture(`SELECT id FROM app_setting WHERE orgId='${orgId}' AND key='graphic-scene:mismatch'`)).length,1);
  await click("Delete scene Mismatched ID"); await confirm("Delete scene");
  await browser("wait","--fn",`!document.querySelector('button[aria-label="Delete scene Mismatched ID"]')`);
  assert.equal((await queryFixture(`SELECT id FROM app_setting WHERE orgId='${orgId}' AND key='graphic-scene:healthy'`)).length,1);
  for (const [width,height] of [[320,480],[768,900],[1440,900]]) {
    await browser("set","viewport",String(width),String(height));
    await browser("scrollintoview",'button[aria-label="Refresh saved scenes"]');
    assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),true);
    assert.equal(await evaluate(`(() => {const b=document.querySelector('button[aria-label="Refresh saved scenes"]');const r=b.getBoundingClientRect();return r.height>=44&&r.left>=0&&r.right<=innerWidth&&document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('button')===b;})()`),true);
    if(width===320) await browser("screenshot","/tmp/showpilot-saved-scene-320.png");
  }
  await repairGraphicSceneFixtures(); await click("Refresh saved scenes");
  await browser("wait",'button[aria-label="Load scene Repaired scene"]:not(:disabled)');
  await browser("wait","--fn",`!document.querySelector('[role="alert"][aria-label="Refresh saved scenes"]')`);
  assert.equal(await primary(),"Keep my draft","Refresh never loads a scene or discards the draft automatically");
  await click("Load scene Future template"); await confirm("Load scene");
  await browser("wait",'button[aria-label="Remove layer Saved first"]');
  assert.equal(await evaluate(`!!document.querySelector('[role="alert"][aria-label="Refresh scene library"]')`),false);
  // A legacy saved draft key plus a new draft must remain two distinct layers.
  await browser("fill",'input[aria-label="Primary text"]',"Second new draft");
  await click("Draft hidden");
  await click("Update scene");
  await browser("wait","--fn",`document.body.textContent.includes('Scene save confirmed')`);
  const row=(await queryFixture(`SELECT value FROM app_setting WHERE orgId='${orgId}' AND key='graphic-scene:unsupported'`))[0];
  const layers=JSON.parse(row.value).items;
  assert.deepEqual(layers.map(layer=>layer.title),["Saved first","Second new draft"]);
  assert.equal(new Set(layers.map(layer=>layer.key)).size,2);
  assert.deepEqual(await active(),initialProgram,"All read/preview/library operations preserve Program");
  console.log(JSON.stringify({passed:true,damagedRowsVisible:true,atomicPreviewRestore:true,readOnlyRepairRetry:true,safeStoredKeyDelete:true,uniqueNewDraftKeys:true,programUnchanged:true,narrowRecoveryControls:true}));
},{damagedGraphicScenes:true});
