// Production build + disposable D1/relay. No production data or external outputs.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll } from "./real-browser-fixture.mjs";
await withLocalSmokeFixture(async ({origin,orgId,date,browser,operatorCookie,operatorEmail,operatorPassword,queryFixture})=>{
  const evaluate=async expression=>(await browser("eval",expression)).result;
  const click=name=>browser("find","role","button","click","--name",name,"--exact");
  const endpoint=`${origin}/api/rundown/${orgId}`,query=`showId=smoke-show&serviceDate=${date}`;
  const command=async(action,payload)=>{const response=await fetch(`${endpoint}/command?${query}`,{method:"POST",headers:{Cookie:operatorCookie,Origin:origin,"Content-Type":"application/json"},body:JSON.stringify({action,payload})});assert.equal(response.status,200);assert.equal((await response.json()).ok,true);};
  const state=async()=>(await fetch(`${endpoint}/state?${query}`,{headers:{Cookie:operatorCookie}})).json();
  const items=Array.from({length:180},(_,index)=>({id:`long-${index}`,title:`Long show ${index}${index%12===0?' with a variable height title '.repeat(8):''}`,type:index%20===0?"header":"segment",duration:index%20===0?0:300000,notes:index%9===0?"Wrapping note ".repeat(30):"",assignee:"Fixture",cue:"",status:"upcoming",sortOrder:index,hardStop:false}));
  await command("seed",{items,force:true});
  await browser("open",`${origin}/login`); await browser("fill","#email",operatorEmail); await browser("fill","#password",operatorPassword);
  await click("Sign in"); await browser("wait","--url",`**/${orgId}/**`);
  await browser("open",`${origin}/${orgId}/rundown?show=smoke-show&date=${date}`);
  await browser("wait",'[data-rundown-item-id="long-1"]');
  await browser("wait","--fn",`document.querySelector('[data-virtualized="true"]')?.children.length>0`);
  const rowCount=()=>evaluate(`document.querySelectorAll('[data-rundown-item-id]').length`);
  const scrollRundown=async(where)=>evaluate(`(() => {const section=document.querySelector('#rundown-runsheet');const scroller=getComputedStyle(section).overflowY==='visible'?document.querySelector('.rundown-columns'):section;scroller.scrollTop=${where==='end'?'scroller.scrollHeight':'0'};return true;})()`);
  assert.ok(await rowCount()<55);
  await browser("focus",'[data-rundown-item-id="long-1"] button[title="Move down"]');
  await scrollRundown("end"); await browser("wait",'[data-rundown-item-id="long-179"]');
  assert.equal(await evaluate(`document.activeElement.closest('[data-rundown-item-id]')?.dataset.rundownItemId`),"long-1");
  assert.ok(await rowCount()<55,"Pinned focus must not mount all rows between it and the viewport");
  await browser("press","Enter");
  await poll(async()=>(await state()).items[2].id==='long-1',"focused keyboard reorder remains persisted");
  // Native drag events cross a range change without losing the source element.
  await scrollRundown("start"); await browser("wait",'[data-rundown-item-id="long-2"]');
  await evaluate(`(() => {window.__virtualDrag=new DataTransfer();document.querySelector('[data-rundown-item-id="long-2"] button[draggable]').dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:window.__virtualDrag}));return true;})()`);
  await scrollRundown("end"); await browser("wait",'[data-rundown-item-id="long-179"]');
  assert.ok(await evaluate(`!!document.querySelector('[data-rundown-item-id="long-2"]')`));
  await evaluate(`(() => {const row=document.querySelector('[data-rundown-item-id="long-179"]');for(const type of ['dragover','drop']) row.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:window.__virtualDrag}));return true;})()`);
  await poll(async()=>(await state()).items.at(-1).id==='long-2',"drag across virtual range persists");
  for(const [width,height] of [[320,480],[768,900],[1440,900]]){
    await browser("set","viewport",String(width),String(height));
    await scrollRundown("start"); await browser("wait",'[data-rundown-item-id="long-0"]');
    await scrollRundown("end"); await browser("wait",'[data-rundown-item-id="long-2"]');
    await browser("wait","200");
    const size=await evaluate(`(() => {const page=document.querySelector('.rundown-page');const rows=[...document.querySelectorAll('[data-rundown-item-id]')];return {count:rows.length,fits:page.scrollWidth<=page.clientWidth+1,heights:rows.map(r=>r.getBoundingClientRect().height)};})()`);
    assert.ok(size.count<55&&size.fits&&size.heights.every(h=>h>0),JSON.stringify(size));
  }
  await browser("set","viewport","1440","900");
  await browser("open",`${origin}/${orgId}/production/cue-sheets?show=smoke-show&date=${date}`);
  await browser("wait",'[data-cue-row-id="long-1"] textarea >> nth=0');
  const waitLastCue=async(label)=>{
    try { await browser("wait",'[data-cue-row-id="long-2"]'); }
    catch(error) {
      console.error(JSON.stringify({label,pageErrors:await browser("errors"),diagnostic:await evaluate(`(() => {const table=document.querySelector('table'),s=table.parentElement;return {scrollTop:s.scrollTop,height:s.clientHeight,total:s.scrollHeight,width:s.clientWidth,tableHeight:table.getBoundingClientRect().height,active:document.activeElement.closest('[data-cue-row-id]')?.dataset.cueRowId,rows:[...document.querySelectorAll('[data-cue-row-id]')].map(r=>({id:r.dataset.cueRowId,top:r.getBoundingClientRect().top,height:r.getBoundingClientRect().height})),spacers:[...document.querySelectorAll('[data-virtual-spacer]')].map(r=>r.getBoundingClientRect().height)};})()`)}));
      await browser("screenshot","/tmp/showpilot-virtual-cues-failure.png");throw error;
    }
  };
  const scrollCue=async(where)=>evaluate(`(() => {const scroller=document.querySelector('table').parentElement;scroller.scrollTop=${where==='end'?'scroller.scrollHeight':'0'};return true;})()`);
  assert.ok(await evaluate(`document.querySelectorAll('[data-cue-row-id]').length<65`));
  const note='Unsaved virtual note '+ 'long wrapped text '.repeat(40);
  await browser("fill",'[data-cue-row-id="long-1"] textarea >> nth=0',note);
  await evaluate(`window.__focusedCue=document.activeElement;true`);
  await scrollCue("end"); await waitLastCue("cue-end-1");
  assert.deepEqual(await evaluate(`({same:document.activeElement===window.__focusedCue,value:window.__focusedCue.value,connected:window.__focusedCue.isConnected})`),{same:true,value:note,connected:true});
  assert.ok(await evaluate(`document.querySelectorAll('[data-cue-row-id]').length<65`));
  await browser("press","Enter");
  await poll(async()=>(await queryFixture(`SELECT text FROM cue_note WHERE orgId='${orgId}' AND itemId='long-1'`)).some(row=>row.text===note),"focused draft commits after virtual scroll");
  await scrollCue("start"); await browser("wait",'[data-cue-row-id="long-1"] textarea >> nth=0');
  assert.equal(await evaluate(`document.querySelector('[data-cue-row-id="long-1"] textarea').value`),note);
  for(let step=0;step<100;step++) {
    if(await evaluate(`!!document.querySelector('[data-cue-row-id="long-19"]')`)) break;
    await evaluate(`document.querySelector('table').parentElement.scrollTop+=300;true`);
    await browser("wait","80");
  }
  await evaluate(`(() => {const fields=document.querySelectorAll('[data-cue-row-id="long-19"] textarea');if(!fields.length) throw new Error('Could not find keyboard fixture row');fields[fields.length-1].focus();return true;})()`);
  await scrollCue("end"); await waitLastCue("cue-end-2");
  await browser("press","Tab");
  assert.equal(await evaluate(`document.activeElement.closest('[data-cue-row-id]')?.dataset.cueRowId`),"long-21","Tab must pass section headings to the next editable row");
  // Changing dimensions remeasures wrapping while preserving scroll access to the last row.
  for(const [width,height] of [[320,480],[768,900],[1440,900]]){
    await browser("set","viewport",String(width),String(height));
    await browser("wait","--fn",`document.querySelector('table').parentElement.clientHeight>=80`);
    await scrollCue("end"); await waitLastCue("cue-end-3");
    await evaluate(`const s=document.querySelector('table').parentElement;s.scrollLeft=s.scrollWidth;true`);
    assert.ok(await evaluate(`(() => {const fields=document.querySelectorAll('[data-cue-row-id="long-2"] textarea');const field=fields[fields.length-1];const r=field.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth+1&&document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===field;})()`),"Department note must remain reachable after horizontal scrolling");
    assert.ok(await evaluate(`document.querySelectorAll('[data-cue-row-id]').length<65`));
    assert.equal(await evaluate(`document.querySelector('table').getAttribute('aria-rowcount')`),"181");
    await browser("screenshot",`/tmp/showpilot-virtual-cues-${width}.png`);
  }
  console.log(JSON.stringify({pageErrors:await browser("errors")}));
  assert.equal(await evaluate(`document.body.textContent.includes("An unexpected error occurred.")`),false,"Resizing must not produce an unhandled browser error");
  console.log(JSON.stringify({passed:true,totalRows:180,boundedRundownAndCueDOM:true,keyboardReorder:true,dragAcrossVirtualRange:true,focusedDraftSurvivesScroll:true,draftPersisted:true,tabAcrossSection:true,threeWidths:true}));
});
