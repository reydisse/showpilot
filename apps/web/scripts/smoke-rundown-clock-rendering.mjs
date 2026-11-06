// Real built route, authenticated relay, and disposable data. Samples React's installed
// row handler identities: the route creates them on each render even when the DOM is unchanged.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
await withLocalSmokeFixture(async ({origin,orgId,date,browser,operatorCookie,operatorEmail,operatorPassword}) => {
  const evaluate=async expression=>(await browser("eval",expression)).result;
  const click=name=>browser("find","role","button","click","--name",name,"--exact");
  const command=async(action,payload)=>{
    const response=await fetch(`${origin}/api/rundown/${orgId}/command?showId=smoke-show&serviceDate=${date}`,{method:"POST",headers:{Cookie:operatorCookie,Origin:origin,"Content-Type":"application/json"},body:JSON.stringify({action,payload})});
    assert.equal(response.status,200); assert.equal((await response.json()).ok,true);
  };
  for(let n=0;n<10;n++) await command("add-item",{id:`clock-${n}`,title:`Clock fixture ${n}`,type:"segment",duration:130000,notes:"",assignee:"",cue:"",hardStop:false});
  await browser("open",`${origin}/login`); await browser("fill","#email",operatorEmail); await browser("fill","#password",operatorPassword);
  await click("Sign in"); await browser("wait","--url",`**/${orgId}/**`);
  await browser("open",`${origin}/${orgId}/rundown?show=smoke-show&date=${date}`);
  await browser("wait",'[data-rundown-item-id="clock-9"]');
  await command("timer-start",{itemId:"clock-0"});
  await browser("wait",'#rundown-item-progress'); await browser("wait","1500");
  await evaluate(`(() => {
    const row=document.querySelector('[data-rundown-item-id="clock-9"]');
    const key=Object.keys(row).find(key=>key.startsWith('__reactProps$'));
    if(!key||typeof row[key]?.onDragOver!=='function') throw new Error('React row-handler probe unavailable');
    let previous=row[key].onDragOver;
    window.__clockRenders={changes:0,samples:0,clockTexts:[]};
    window.__clockRenderInterval=setInterval(()=>{
      const handler=row[key].onDragOver;
      if(handler!==previous){window.__clockRenders.changes++;previous=handler;}
      window.__clockRenders.samples++;
      window.__clockRenders.clockTexts.push(document.querySelector('.rundown-panel-left p.text-6xl')?.textContent);
    },10);
    return true;
  })()`);
  await browser("wait","2500");
  const probe=await evaluate(`(() => {clearInterval(window.__clockRenderInterval);return window.__clockRenders;})()`);
  assert.ok(probe.samples>=100,JSON.stringify(probe));
  assert.ok(new Set(probe.clockTexts).size>=2,"Clock must advance while measuring row stability");
  console.log(JSON.stringify({routeRendersIn2500ms:probe.changes,clockValues:[...new Set(probe.clockTexts)],samples:probe.samples}));
  assert.equal(probe.changes,0,"Clock ticks must not rebuild rundown row handlers");
  await command("timer-adjust",{deltaMs:-20000});
  await browser("wait",'#rundown-progress-fill[data-tone="warning"]');
  await command("timer-adjust",{deltaMs:-130000});
  await browser("wait",'#rundown-progress-fill[data-tone="overtime"]');
  await browser("wait",'#rundown-item-progress[data-tone="overtime"]');
  assert.ok((await evaluate(`document.querySelector('[data-rundown-clock]').textContent`)).startsWith("-"));
  assert.ok(await evaluate(`document.querySelector('.rundown-row-offset').className.includes('text-red-400')`));
  await command("timer-pause"); await browser("wait","200");
  const paused=await evaluate(`({clock:document.querySelector('[data-rundown-clock]').textContent,width:document.querySelector('#rundown-progress-fill').style.width})`);
  await browser("wait","1200");
  assert.deepEqual(await evaluate(`({clock:document.querySelector('[data-rundown-clock]').textContent,width:document.querySelector('#rundown-progress-fill').style.width})`),paused);
  await command("timer-next"); await browser("wait",'[data-rundown-item-id="clock-1"] #rundown-item-progress');
  await browser("wait","500");
  assert.ok(await evaluate(`parseFloat(document.querySelector('#rundown-progress-fill').style.width)<5`));
  assert.equal(await evaluate(`document.querySelector('#rundown-progress-fill').dataset.tone`),"normal");
  for(const [width,height] of [[320,480],[768,900],[1440,900]]){
    await browser("set","viewport",String(width),String(height));
    assert.ok(await evaluate(`document.querySelector('.rundown-page').scrollWidth<=document.querySelector('.rundown-page').clientWidth+1`));
  }
  console.log(JSON.stringify({passed:true,routeRendersIn2500ms:probe.changes,warningAndOvertime:true,pausedClockAndProgressHold:true,nextItemResetsProgress:true}));
});
