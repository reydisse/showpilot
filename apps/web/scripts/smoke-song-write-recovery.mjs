// Real D1 commits with lost replies, same-request Retry and post-save refresh recovery.
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";
const assets = resolve(import.meta.dirname, "../dist/server/assets");
const ids = {};
for (const name of (await readdir(assets)).filter(name => name.endsWith(".js"))) {
  const source = await readFile(resolve(assets, name), "utf8");
  for (const fn of ["createSong", "listSongs", "saveSongMetadata", "saveSongSection", "saveSongDraft", "reorderSongSections", "deleteSongSection", "deleteSong"]) ids[fn] ??= source.match(new RegExp(`const ${fn}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`))?.[1];
}
assert.ok(ids.createSong); assert.ok(ids.listSongs);
await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, stopServer, queryFixture }) => {
  let creationRequests;
  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    await page("Emulation.setFocusEmulationEnabled", { enabled: true });
    await page("Page.enable");
    await page("Page.addScriptToEvaluateOnNewDocument", { source: `window.songErrors=[];window.songRequests=[];window.songHold=null;window.songReplies=[];
      addEventListener('error',e=>window.songErrors.push(e.message));addEventListener('unhandledrejection',e=>window.songErrors.push(String(e.reason)));
      const original=window.fetch;window.fetch=(input,options)=>{const url=input instanceof Request?input.url:String(input);const kind=Object.entries(${JSON.stringify(ids)}).find(([kind,id])=>url.includes(id))?.[0];if(!kind)return original(input,options);window.songRequests.push({kind,body:options?.body});const held=window.songHold===kind;const reply=original(input,options);return held?reply.then(async r=>{const body=await r.text();return new Promise(resolve=>window.songReplies.push({kind,status:r.status,release:()=>resolve(new Response(body,{status:r.status,headers:r.headers}))}));}):reply;};` });
    const check = (code, label) => poll(() => evaluate(code),label).catch(async error=>{
      console.log(JSON.stringify({label,body:await evaluate("document.body?.innerText"),errors:await evaluate("window.songErrors")}));
      await writeFile("/tmp/showpilot-song-recovery-failure.png",Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));throw error;
    });
    const button = name => `[...(document.querySelector('[role=dialog]')??document).querySelectorAll('button,a')].find(n=>(n.textContent.trim()===${JSON.stringify(name)}||n.getAttribute('aria-label')===${JSON.stringify(name)})&&n.getBoundingClientRect().height>0&&!n.disabled)`;
    const field = label => `[...document.querySelectorAll('label')].find(n=>[...n.childNodes].filter(c=>c.nodeType===Node.TEXT_NODE).map(c=>c.textContent).join('').trim()===${JSON.stringify(label)})?.querySelector('input,textarea')`;
    const click = async name => {
      const p=await check(`(async()=>{const n=${button(name)};if(!n||!Object.keys(n).some(k=>k.startsWith('__reactProps')))return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`,name);
      await page("Input.dispatchMouseEvent",{type:"mousePressed",...p,button:"left",clickCount:1});
      await page("Input.dispatchMouseEvent",{type:"mouseReleased",...p,button:"left",clickCount:1});
    };
    const fill = async (expression,value) => {
      await check(`!!(${expression})&&Object.keys(${expression}).some(k=>k.startsWith('__reactProps'))`,"hydrated field");
      await evaluate(`(()=>{const n=${expression};Object.getOwnPropertyDescriptor(n instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    };
    await page("Emulation.setDeviceMetricsOverride", { width:1440,height:1000,deviceScaleFactor:1,mobile:false });
    await page("Page.navigate", { url:`${origin}/${orgId}/songs` });
    await check("document.body?.innerText?.includes('Build your first lyrics cue map')", "empty library");
    await click("Create manually");
    await fill(field("Title"), "Recovered creation");
    await fill(field("Section 1 lyrics"), "First line\nSecond line");
    await evaluate("window.songHold='createSong'");
    await click("Create song");
    await check("window.songReplies.some(r=>r.kind==='createSong'&&r.status===200)", "creation committed before timeout");
    await check("document.body?.innerText?.includes('Creation is unconfirmed')", "creation timeout and recovery");
    for(const [width,height] of [[320,568],[768,1024],[1440,1000]]) {
      await page("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false});
      await check(`(async()=>{const n=${button("Retry creation")};if(!n)return false;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const r=n.getBoundingClientRect();return r.height>=44&&r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight&&n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()`, `Retry creation geometry ${width}`);
      if(width===320) await writeFile("/tmp/showpilot-song-recovery-320.png", Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));
    }
    await click("Close"); await click("Create manually");
    await check("document.body?.innerText?.includes('Creation is unconfirmed')", "reopening retains recovery");
    await evaluate("window.songHold=null"); await click("Retry creation");
    await check("document.querySelector('main h1')?.textContent==='Recovered creation'&&!document.querySelector('[role=dialog]')", "recovered song opened");
    const firstRequests = await evaluate("window.songRequests.filter(r=>r.kind==='createSong')");
    assert.equal(firstRequests.length,2); assert.equal(firstRequests[0].body,firstRequests[1].body,"retry preserves exact request body");
    await evaluate("window.songReplies.filter(r=>r.kind==='createSong').forEach(r=>r.release())");
    const recover = async (kind, action, retry, confirmation) => {
      const before = await evaluate(`window.songReplies.filter(r=>r.kind===${JSON.stringify(kind)}).length`);
      await evaluate(`window.songHold=${JSON.stringify(kind)}`);
      await click(action);
      if(confirmation) await click(confirmation);
      await check(`window.songReplies.filter(r=>r.kind===${JSON.stringify(kind)}&&r.status===200).length>${before}`, `${action} actually committed`);
      await check(`!!(${button(retry)})`, `${action} exposes Retry`);
      await evaluate("window.songHold=null"); await click(retry);
      await check(`![...document.querySelectorAll('[role=alert]')].some(n=>n.textContent.includes('Result unconfirmed'))`, `${action} recovery completes`);
      await evaluate(`window.songReplies.filter(r=>r.kind===${JSON.stringify(kind)}).forEach(r=>r.release())`);
      const attempts = await evaluate(`window.songRequests.filter(r=>r.kind===${JSON.stringify(kind)}).slice(-2)`);
      assert.equal(attempts.length,2); assert.equal(attempts[0].body,attempts[1].body,`${action} retries the exact request`);
      console.log(JSON.stringify({recovered:action}));
    };
    await fill(field("Title"), "Recovered saved title");
    await fill("document.querySelector('main textarea')", "Unsaved lyric draft\nKeep this line");
    await recover("saveSongMetadata", "Save song details", "Retry save song details");
    assert.equal(await evaluate("document.querySelector('main textarea').value"), "Unsaved lyric draft\nKeep this line");
    await fill(field("Title"), "");await click("Save song details");
    await check(`!!(${button("Retry save song details")})`, "validation failure retains recovery");
    await click("Keep drafts and edit");await click("Keep drafts and edit");
    await check(`!(${field("Title")}).readOnly&&!document.querySelector('[role=dialog]')`, "stored version reviewed before editing resumes");
    assert.equal(await evaluate(`(${field("Title")}).value`), "", "review preserves the rejected draft");
    assert.equal(await evaluate("document.querySelector('main textarea').value"), "Unsaved lyric draft\nKeep this line");
    await fill(field("Title"), "Recovered saved title");
    await recover("saveSongSection", "Section", "Retry add section");
    await check("document.querySelectorAll('main textarea').length===2", "section added exactly once");
    await fill("document.querySelector('main textarea')", "Saved revised\nSecond line");
    await recover("saveSongSection", "Save section", "Retry save section");
    await recover("reorderSongSections", "Move section down", "Retry reorder sections");
    await check("document.querySelector('main textarea').value===''", "new section moved to first position");
    await fill(field("Title"), "Saved full draft"); await click("Cue");
    await recover("saveSongDraft", "Save all changes", "Retry save all changes");
    await recover("deleteSongSection", "Delete Section 2", "Retry delete section", "Delete section");
    await check("document.querySelectorAll('main textarea').length===1", "confirmed section deletion recovered");
    await click("Back to songs");
    await check("document.querySelector('main h1')?.textContent==='Songs'&&document.body.innerText.includes('Saved full draft')", "library sees newly created song");
    await click("New song"); await fill(field("Title"), "Saved before refresh");
    await fill(field("Section 1 lyrics"), "Retained text");
    await evaluate("window.songHold='listSongs'"); await click("Create song");
    await check("window.songReplies.some(r=>r.kind==='listSongs'&&r.status===200)", "post-save refresh reply held");
    await check("document.body?.innerText?.includes('The song was created, but its page could not be opened')", "post-save timeout is honest");
    await evaluate("window.songHold=null"); await click("Retry opening song");
    // A cancelled router invalidation may be coalesced with the pending one.
    // Release the original read; only the active retry may then navigate.
    await evaluate("window.songReplies.filter(r=>r.kind==='listSongs').forEach(r=>r.release())");
    await check("document.querySelector('main h1')?.textContent==='Saved before refresh'&&!document.querySelector('[role=dialog]')", "post-save recovery opens existing song");
    await click("Delete song");
    await recover("deleteSong", "Delete song", "Retry delete");
    await check("document.querySelector('main h1')?.textContent==='Songs'&&!document.body.innerText.includes('Saved before refresh')", "deleted song removed from library");
    creationRequests = await evaluate("window.songRequests.filter(r=>r.kind==='createSong')");
    assert.equal(creationRequests.length,3,"opening retry sends no duplicate create");
    assert.deepEqual(await evaluate("window.songErrors"), []);
  });
  await stopServer();
  const songs = await queryFixture(`SELECT id,title FROM song WHERE orgId='${orgId}' ORDER BY title`);
  const receipts = await queryFixture(`SELECT requestId,kind FROM song_write_receipt WHERE orgId='${orgId}' AND kind='create'`);
  const sections = await queryFixture(`SELECT lyrics FROM song_section WHERE orgId='${orgId}' ORDER BY lyrics`);
  assert.equal(songs.length,1); assert.equal(songs[0].title,"Saved full draft"); assert.equal(receipts.length,2);
  assert.deepEqual(sections.map(s=>s.lyrics), ["Saved revised\nSecond line"]);
  const writes=await queryFixture(`SELECT kind,count(*) AS n FROM song_write_receipt WHERE orgId='${orgId}' GROUP BY kind ORDER BY kind`);
  assert.deepEqual(Object.fromEntries(writes.map(r=>[r.kind,r.n])),{create:2,delete:1,"delete-section":1,draft:1,metadata:1,reorder:1,section:2});
  assert.equal((await queryFixture(`SELECT id FROM song_cue_map WHERE orgId='${orgId}'`)).length,1);
  assert.equal((await queryFixture(`SELECT id FROM song_cue WHERE orgId='${orgId}'`)).length,0);
  console.log(JSON.stringify({ok:true,creationAttempts:creationRequests.length,songs:songs.length,receipts:receipts.length,lyricLineBreaks:true,viewportWidths:[320,768,1440],browserErrors:0}));
});
