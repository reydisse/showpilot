import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";

const audit = process.argv.includes("--audit");
const findings = {};
await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, stopServer, queryFixture }) => {
  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    await page("Emulation.setFocusEmulationEnabled", { enabled:true });
    await page("Page.enable");
    await page("Page.addScriptToEvaluateOnNewDocument", { source:`window.songErrors=[];addEventListener('error',e=>window.songErrors.push(e.message));addEventListener('unhandledrejection',e=>window.songErrors.push(String(e.reason)));` });
    const check = (code, label) => poll(() => evaluate(code),label).catch(async error=>{
      console.log(JSON.stringify({label,body:await evaluate("document.body?.innerText"),errors:await evaluate("window.songErrors")}));
      await writeFile("/tmp/showpilot-song-studio-failure.png",Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));throw error;
    });
    const button = name => `[...document.querySelectorAll('button,a')].find(n=>(n.textContent.trim()===${JSON.stringify(name)}||n.getAttribute('aria-label')===${JSON.stringify(name)})&&n.getBoundingClientRect().height>0&&!n.disabled)`;
    const field = label => `[...document.querySelectorAll('label')].find(n=>[...n.childNodes].filter(c=>c.nodeType===Node.TEXT_NODE).map(c=>c.textContent).join('').trim()===${JSON.stringify(label)})?.querySelector('input,textarea')`;
    const click = async name => {
      const p=await check(`(async()=>{const n=${button(name)};if(!n)return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`,name);
      await page("Input.dispatchMouseEvent",{type:"mousePressed",...p,button:"left",clickCount:1});
      await page("Input.dispatchMouseEvent",{type:"mouseReleased",...p,button:"left",clickCount:1});
    };
    const fill = async (expression,value) => {
      await check(`!!(${expression})&&Object.keys(${expression}).some(k=>k.startsWith('__reactProps'))`,"hydrated field");
      await evaluate(`(()=>{const n=${expression};Object.getOwnPropertyDescriptor(n instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    };
    await page("Emulation.setDeviceMetricsOverride",{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await page("Page.navigate",{url:`${origin}/${orgId}/songs`});
    await check("document.body?.innerText?.includes('Build your first lyrics cue map')","empty library");
    findings.singleEmptyAction = await evaluate(`[...document.querySelectorAll('main button')].filter(n=>n.textContent.trim()==='Import from ProPresenter').length===1`);
    await click("Create manually"); await fill(field("Title"),"Studio fixture");
    // Real keyboard Enter, rather than assigning a multiline string, proves
    // that application shortcuts allow the browser to insert the line break.
    await evaluate(`(${field("Section 1 lyrics")}).focus()`);
    await page("Input.insertText",{text:"First fixture line"});
    await page("Input.dispatchKeyEvent",{type:"keyDown",key:"Enter",code:"Enter",text:"\r",windowsVirtualKeyCode:13});
    await page("Input.dispatchKeyEvent",{type:"keyUp",key:"Enter",code:"Enter",windowsVirtualKeyCode:13});
    await page("Input.insertText",{text:"Second fixture line"});
    findings.enterPreservesLines = await evaluate(`(${field("Section 1 lyrics")}).value==='First fixture line\\nSecond fixture line'`);
    await click("Add section"); await fill(field("Section 2 name"),"Chorus");
    await fill(field("Section 2 lyrics"),"Chorus first\nChorus second");
    await click("Create song");
    await check(`location.pathname.startsWith('/${orgId}/songs/')&&document.querySelector('main h1')?.textContent==='Studio fixture'`,"created song navigates");
    findings.creationCloses = await evaluate("!document.querySelector('[role=dialog]')&&!document.body?.innerText?.includes('Creating…')");
    findings.cleanSaveHonest = await evaluate("document.body?.innerText?.includes('All changes saved')&&![...document.querySelectorAll('button')].some(n=>n.textContent.includes('Save all changes'))");
    findings.savedEntryLines = await evaluate("[...document.querySelectorAll('textarea')].some(n=>n.value==='First fixture line\\nSecond fixture line')");
    findings.reorderTargets = await evaluate("[...document.querySelectorAll('button[aria-label^=\"Move section\"]')].every(n=>n.getBoundingClientRect().height>=44&&n.getBoundingClientRect().width>=44)");
    await click("Cue");
    for(const [width,height] of [[320,780],[768,1024],[1440,1000]]) {
      await page("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false});
      await check(`(async()=>{const n=${button("Move section down")};n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect();return b.height>=44&&b.width>=44&&b.left>=0&&b.right<=innerWidth&&n.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))&&document.documentElement.scrollWidth<=innerWidth+1&&[...document.querySelectorAll('main input,main textarea,main select,main button')].filter(e=>e.getBoundingClientRect().width>0).every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1;});})()`,`section move target ${width}`);
      if(width===320) await writeFile("/tmp/showpilot-song-studio-320.png",Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));
    }
    await click("Remove cue");
    await click("Move section down");
    await check("document.querySelector('textarea')?.value==='Chorus first\\nChorus second'","section order changes");
    // An empty local first section must not leave the preview as a black rectangle.
    await fill("document.querySelector('textarea')","");
    findings.emptyPreviewExplained = await evaluate("!![...document.querySelectorAll('aside p')].find(n=>/Add lyrics|No lyrics|Lyrics will appear/i.test(n.textContent))");
    await fill("document.querySelector('textarea')","Chorus first\nChorus second");
    console.log(JSON.stringify({stage:"studio",findings}));
    await check("document.body?.innerText.includes('All changes saved')&&!document.body?.innerText.includes('Unsaved changes')","restored draft is clean");
    await click("Back to songs");
    await check("document.querySelector('main h1')?.textContent==='Songs'||!!document.querySelector('[role=dialog]')","navigation outcome");
    if(await evaluate("!!document.querySelector('[role=dialog]')")) { findings.restoredDraftLeavesCleanly=false; await click("Discard and leave"); }
    else findings.restoredDraftLeavesCleanly=true;
    await check("document.querySelector('main h1')?.textContent==='Songs'","library return");
    await fill("document.querySelector('input[placeholder=\"Search title, artist, or CCLI\"]')","No-such-fixture");
    findings.emptySearchExplained = await evaluate("/No songs match|No matching songs/.test(document.querySelector('main').innerText)");
    if(!audit) {
      await click("Clear search");
      await check("document.querySelector('main').innerText.includes('Studio fixture')","clear search restores songs");
    }
    assert.deepEqual(await evaluate("window.songErrors"),[]);
  });
  await stopServer();
  const sections=await queryFixture("SELECT label,lyrics,sortOrder FROM song_section WHERE orgId='display-smoke' ORDER BY sortOrder");
  findings.persistedLines = sections.some(s=>s.lyrics==='First fixture line\nSecond fixture line');
  findings.persistedOrder = sections[0]?.label==='Chorus';
  console.log(JSON.stringify({findings,sections},null,2));
  if(!audit) for(const [name,passed] of Object.entries(findings)) assert.equal(passed,true,name);
});
