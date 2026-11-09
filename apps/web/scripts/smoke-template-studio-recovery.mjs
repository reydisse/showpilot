// Real login/Worker/D1; no production data or physical outputs.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll } from "./real-browser-fixture.mjs";
await withLocalSmokeFixture(async ({origin,orgId,browser,operatorEmail,operatorPassword,queryFixture,stopServer,startServer}) => {
  const evaluate = async expression => (await browser("eval", expression)).result;
  const click = name => browser("find","role","button","click","--name",name,"--exact");
  const confirm = name => browser("click", `[role="dialog"] button:text-is(${JSON.stringify(name)})`);
  const scenes = async () => (await queryFixture(`SELECT value FROM app_setting WHERE orgId='${orgId}' AND key LIKE 'graphic-scene:%'`)).map(row=>JSON.parse(row.value));
  const active = async () => JSON.parse((await queryFixture(`SELECT value FROM app_setting WHERE orgId='${orgId}' AND key='active-graphics'`))[0]?.value ?? '[]');
  await browser("open",`${origin}/login`); await browser("fill","#email",operatorEmail); await browser("fill","#password",operatorPassword);
  await click("Sign in"); await browser("wait","--url",`**/${orgId}/**`);
  await browser("open",`${origin}/${orgId}/streaming/lt-preview`);
  await browser("wait",'button:text-is("Take Live"):not(:disabled)');
  await evaluate(`(() => {
    const original=window.fetch; window.__studioPosts=[]; window.__loseStudioReply=false;
    window.fetch=async (input,init) => {
      const post=init?.method==='POST'; if(post) window.__studioPosts.push(init.body);
      const response=await original(input,init);
      if(post && window.__loseStudioReply && response.ok) { window.__loseStudioReply=false; await response.text(); throw new TypeError('Fixture lost Studio acknowledgement after commit'); }
      return response;
    }; return true;
  })()`);
  const beforeCancel=(await evaluate("window.__studioPosts")).length;
  await click("Take Live"); await confirm("Cancel");
  await click("Clear program graphics"); await confirm("Cancel");
  assert.equal((await evaluate("window.__studioPosts")).length,beforeCancel);
  const initialProgram=await active();
  await click("Custom"); await browser("fill",'input[aria-label="Primary text"]',"Studio original");
  await browser("fill",'input[aria-label="Scene name"]',"Recovery scene");
  await evaluate("window.__loseStudioReply=true"); await click("Save scene");
  await browser("wait",'[aria-label="Scene library confirmation"] time');
  assert.equal((await scenes()).length,1);
  const firstPost=(await evaluate("window.__studioPosts")).at(-1);
  await click("Retry scene change"); await browser("wait",'button[aria-label="Load scene Recovery scene"]');
  assert.equal((await evaluate("window.__studioPosts")).at(-1),firstPost);
  assert.equal((await scenes()).length,1);
  await browser("fill",'input[aria-label="Primary text"]',"Studio updated");
  await evaluate("window.__loseStudioReply=true"); await click("Update scene");
  await browser("wait",'[aria-label="Scene library confirmation"] time');
  assert.equal((await scenes())[0].items[0].title,"Studio updated");
  await browser("fill",'input[aria-label="Primary text"]',"Unsent draft");
  await click("Retry scene change"); await browser("wait","--fn","!document.querySelector('[aria-label=\"Scene library confirmation\"]')");
  assert.equal((await scenes())[0].items[0].title,"Studio updated","Retry must retain captured content rather than the current draft");
  await click("Load scene Recovery scene"); await confirm("Cancel");
  assert.equal(await evaluate("document.querySelector('input[aria-label=\"Primary text\"]').value"),"Unsent draft");
  await click("Delete scene Recovery scene"); await confirm("Cancel"); assert.equal((await scenes()).length,1);
  await click("Delete scene Recovery scene"); await evaluate("window.__loseStudioReply=true"); await confirm("Delete scene");
  await browser("wait",'[aria-label="Scene library confirmation"] time'); assert.equal((await scenes()).length,0);
  await click("Retry scene change"); await browser("wait","--fn","!document.querySelector('button[aria-label=\"Load scene Recovery scene\"]')");
  assert.deepEqual(await active(),initialProgram,"Saving/deleting scenes must not change Program");
  // Preview layer deletion has its own confirmation and never changes Program.
  await browser("fill",'input[aria-label="Primary text"]',"Removable layer"); await click("Add lower third");
  await browser("fill",'input[aria-label="Primary text"]',"New Program title");
  await click("Remove layer Removable layer"); await confirm("Cancel");
  assert.equal(await evaluate("!!document.querySelector('button[aria-label=\"Remove layer Removable layer\"]')"),true);
  await click("Remove layer Removable layer"); await confirm("Remove layer");
  await browser("wait","--fn","!document.querySelector('button[aria-label=\"Remove layer Removable layer\"]')");
  assert.deepEqual(await active(),initialProgram);
  // Take Live commits, but its reply is lost. Recovery reads; it never republishes.
  const beforePublish=(await evaluate("window.__studioPosts")).length;
  await click("Take Live"); await evaluate("window.__loseStudioReply=true"); await confirm("Take live");
  await browser("wait",'[aria-label="Program confirmation"] time');
  await browser("wait",'button:text-is("Take Live"):not(:disabled)');
  const published=await active(); assert.equal(published.length,1); assert.notDeepEqual(published,initialProgram);
  assert.equal((await queryFixture(`SELECT title FROM graphic_template WHERE orgId='${orgId}' AND id='${published[0]}'`))[0].title,"New Program title");
  await browser("wait","2500"); assert.equal((await evaluate("window.__studioPosts")).length,beforePublish+1);
  await stopServer(); await browser("wait",'[aria-label="Refresh Program"] time');
  assert.equal(await evaluate("document.body.textContent.includes('Last confirmed Program: 1 layer')"),true);
  for(const [width,height] of [[320,480],[768,900],[1440,900]]) {
    await browser("set","viewport",String(width),String(height));
    await browser("scrollintoview",'button:text-is("Clear program graphics")');
    const bounds=await evaluate(`(() => { const el=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Clear program graphics'); const r=el.getBoundingClientRect(); return {left:r.left,right:r.right,height:r.height,top:r.top,bottom:r.bottom,hitElement:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.outerHTML.slice(0,250),disabled:el.disabled,hit:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('button')===el}; })()`);
    if(width===320) await browser("screenshot","/tmp/showpilot-studio-outage-diagnostic.png");
    assert.ok(bounds.left>=0 && bounds.right<=width && bounds.height>=44 && !bounds.disabled && bounds.hit,JSON.stringify(bounds));
    assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth"),true);
    if(width===320) {
      await browser("screenshot","/tmp/showpilot-studio-outage-320.png");
      await click("Controls"); await browser("wait",'[role="dialog"] input[aria-label="Background opacity"]');
      const controls=await evaluate(`(() => { const dialog=document.querySelector('[role="dialog"]'); const r=dialog.getBoundingClientRect(); return {fits:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&dialog.scrollWidth<=dialog.clientWidth,targets:[...dialog.querySelectorAll('button,input')].every(el=>(el.type==='color'?el.closest('label'):el).getBoundingClientRect().height>=44),named:[...dialog.querySelectorAll('input')].every(el=>el.getAttribute('aria-label'))}; })()`);
      assert.ok(controls.fits&&controls.targets&&controls.named,JSON.stringify(controls));
      await browser("screenshot","/tmp/showpilot-studio-inspector-320.png");
      await click("Close style controls");
    }
  }
  await startServer(); await evaluate("document.querySelector('button[aria-label=\"Refresh Program\"]')?.click()");
  await browser("wait",'button:text-is("Take Live"):not(:disabled)');
  await click("Clear program graphics"); await evaluate("window.__loseStudioReply=true"); await confirm("Clear program graphics");
  await browser("wait",'[aria-label="Program confirmation"] time');
  await poll(async ()=>(await active()).length===0,"Program cleared");
  await browser("wait","--fn","document.body.textContent.includes('Program: 0 layers')");
  assert.equal(await evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Clear program graphics'&&!b.disabled)"),true);
  console.log(JSON.stringify({passed:true,sceneCreateUpdateDeleteRetry:true,originalPayloadRetained:true,previewAndSceneChangesKeepProgram:true,cancelDoesNotWrite:true,lostPublicationReconcilesWithoutReplay:true,realOutageRecovery:true,clearRemainsReachable:true,fits320x480:true,inspectorTargetsAndLabels:true}));
});
