// Real authenticated report exports, with withheld replies and browser downloads.
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { withLocalSmokeFixture } from './local-smoke-fixture.mjs';
import { poll, withRealBrowser } from './real-browser-fixture.mjs';
const ids = {};
const assets = resolve(import.meta.dirname, '../dist/server/assets');
for (const file of (await readdir(assets)).filter(f => f.endsWith('.js'))) {
  const source = await readFile(resolve(assets,file), 'utf8');
  for (const name of ['listRundownDates','exportShowReport'])
    ids[name] ??= source.match(new RegExp(`const ${name}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`))?.[1];
}
assert.ok(ids.listRundownDates && ids.exportShowReport);
await withLocalSmokeFixture(async ({ origin, orgId, date, operatorCookie, stopServer, queryFixture }) => {
  const directory = await mkdtemp(join(tmpdir(), 'showpilot-settings-exports-'));
  for (const [showId,title] of [['smoke-show','Morning-only segment'],['smoke-second-show','Evening-only segment']]) {
    const response = await fetch(`${origin}/api/rundown/${orgId}/command?showId=${showId}&serviceDate=${date}`, {method:'POST',headers:{Cookie:operatorCookie,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({action:'add-item',payload:{id:showId+'-item',title,type:'segment',duration:300000,notes:'',assignee:'',cue:'',hardStop:false}})});
    assert.equal(response.status,200);assert.equal((await response.json()).ok,true);
  }
  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    await page('Page.enable');
    await page('Page.setDownloadBehavior',{behavior:'allow',downloadPath:directory});
    await page('Emulation.setFocusEmulationEnabled', { enabled: true });
    await page('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.exportErrors=[];window.exportHeld=[];window.holdExportList=true;window.holdExportReport=false;window.exportCalls=[];window.exportDownloads=[];
      addEventListener('error',e=>window.exportErrors.push(e.message));
      addEventListener('unhandledrejection',e=>window.exportErrors.push(String(e.reason)));
      const ids=${JSON.stringify(ids)}, original=window.fetch;
      window.fetch=async(input,init)=>{
        const url=input instanceof Request?input.url:String(input);
        const kind=Object.keys(ids).find(name=>url.includes('/_serverFn/'+ids[name]));
        if(kind)window.exportCalls.push({kind,body:init?.body});
        const reply=await original(input,init);
        if((kind==='listRundownDates'&&window.holdExportList)||(kind==='exportShowReport'&&window.holdExportReport))return new Promise(resolve=>window.exportHeld.push(()=>resolve(reply)));
        return reply;
      };
      const create=URL.createObjectURL;
      URL.createObjectURL=blob=>{window.exportDownloads.push({blob});return create(blob)};
      const click=HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click=function(){if(this.download)window.exportDownloads.at(-1).name=this.download;return click.call(this)};
    `});
    const check = (expression,label) => poll(()=>evaluate(expression),label);
    const click = async name => {
      const box = await poll(()=>evaluate(`(async()=>{const n=[...document.querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(name)});if(!n)throw new Error('Missing '+${JSON.stringify(name)});n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect();const x=b.x+b.width/2,y=b.y+b.height/2;return n.contains(document.elementFromPoint(x,y))&&!n.disabled?{x,y}:null;})()`),'clickable '+name);
      await page('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...box});
      await page('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...box});
    };
    await page('Page.navigate',{url:`${origin}/${orgId}/settings?section=danger`});
    await check(`!!document.body&&[...document.querySelectorAll('h1')].some(n=>n.textContent==='Danger Zone')`, 'Danger Zone');
    await check(`Object.keys(document.querySelector('button')??{}).some(k=>k.startsWith('__reactProps'))`, 'hydration');
    await click('Export show data');
    await check(`window.exportHeld.length===1`, 'withheld show list');
    await check(`!!document.querySelector('[role="alert"]')&&[...document.querySelectorAll('button')].some(n=>n.textContent.trim()==='Retry loading shows')`, 'bounded show-list failure and retry');
    assert.equal(await evaluate(`document.body.textContent.includes('No saved shows')`),false);
    await evaluate(`window.holdExportList=false`);
    await click('Retry loading shows');
    await check(`document.querySelector('[role="dialog"] select')?.options.length===2`, 'two same-date shows');
    await evaluate(`(()=>{const n=document.querySelector('[role="dialog"] select');n.value='smoke-second-show';n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    const chooseFormat = value => evaluate(`document.querySelector('input[type="radio"][value="${value}"]').click()`);
    await chooseFormat('csv');
    await evaluate(`[...document.querySelectorAll('label')].find(n=>n.textContent.trim()==='Crew').click();window.holdExportReport=true`);
    await click('Download');
    await check(`window.exportHeld.length===2`, 'withheld report reply');
    await check(`[...document.querySelectorAll('button')].some(n=>n.textContent==='Retry download')`, 'bounded export failure');
    assert.equal(await evaluate(`document.querySelector('[role="dialog"] select').value`),'smoke-second-show');
    assert.equal(await evaluate(`document.querySelector('input[value="csv"]').checked`),true);
    assert.equal(await evaluate(`window.exportDownloads.length`),0);
    await evaluate(`window.holdExportReport=false`);
    await click('Retry download');
    await check(`window.exportDownloads.length===1&&!document.querySelector('[role="dialog"]')`, 'recovered export');
    await evaluate(`window.exportHeld.splice(0).forEach(release=>release())`);
    const csvName=`${orgId}-show-report-${date}-smoke-second-show.csv`;
    await poll(async()=> (await readdir(directory)).includes(csvName),'actual CSV download');
    const csv=await readFile(join(directory,csvName),'utf8');
    assert.match(csv,/Evening-only segment/);assert.doesNotMatch(csv,/Morning-only segment/);assert.doesNotMatch(csv,/crew/);

    // Escape cancels an in-flight export. A late reply must not download or close a newer dialog.
    await click('Export show data');
    await check(`!!document.querySelector('[role="dialog"] select')`,'reopened dialog');
    await evaluate(`window.holdExportReport=true`);
    await click('Download');
    await check(`window.exportHeld.length===1`,'cancelable report');
    await page('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await page('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await check(`!document.querySelector('[role="dialog"]')&&document.activeElement?.textContent.trim()==='Export show data'`,'Escape and focus return');
    await click('Export show data');
    await check(`!!document.querySelector('[role="dialog"] select')`,'new dialog after cancellation');
    await evaluate(`window.holdExportReport=false;window.exportHeld.splice(0).forEach(release=>release())`);
    await check(`window.exportDownloads.length===1&&!!document.querySelector('[role="dialog"]')`,'late reply ignored');

    for(const width of [320,768,1440]) {
      await page('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
      await check(`document.documentElement.scrollWidth<=innerWidth+1`,'export page width');
      await check(`document.querySelector('[role="dialog"]').getAnimations({subtree:true}).every(a=>a.playState==='finished')`,'dialog layout settled');
      const sizes=await evaluate(`[...document.querySelectorAll('[role="dialog"] button,[role="dialog"] select,[role="dialog"] label:has(input)')].map(n=>({label:n.getAttribute('aria-label')??n.textContent.trim(),w:n.getBoundingClientRect().width,h:n.getBoundingClientRect().height}))`);
      assert.ok(sizes.length>=14&&sizes.every(s=>s.h>=44&&s.w>=44),JSON.stringify({width,sizes}));
      assert.equal(await evaluate(`(()=>{const d=document.querySelector('[role="dialog"]');return d.scrollWidth<=d.clientWidth+1})()`),true);
      if(width===320)await writeFile('/tmp/showpilot-settings-export-320.png',Buffer.from((await page('Page.captureScreenshot',{format:'png'})).data,'base64'));
    }
    for(let i=0;i<18;i++) {
      await page('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
      await page('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
      assert.equal(await evaluate(`document.querySelector('[role="dialog"]').contains(document.activeElement)`),true);
    }
    await chooseFormat('json');await click('Download');
    const jsonName=`${orgId}-show-report-${date}-smoke-second-show.json`;
    await poll(async()=> (await readdir(directory)).includes(jsonName),'actual JSON download');
    const report=JSON.parse(await readFile(join(directory,jsonName),'utf8'));
    assert.equal(report.showId,'smoke-second-show');assert.equal(report.rundown.items.length,1);assert.equal(report.rundown.items[0].title,'Evening-only segment');assert.equal('crew' in report,false);
    await click('Export show data');await check(`!!document.querySelector('[role="dialog"] select')`,'Excel dialog');
    await chooseFormat('xlsx');await click('Download');
    const excelName=`${orgId}-show-report-${date}-smoke-second-show.xlsx`;
    await poll(async()=> (await readdir(directory)).includes(excelName),'actual Excel download');
    const xml=execFileSync('python3',['-c',"import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print('\\n'.join(z.read(n).decode() for n in z.namelist() if n.endswith('.xml')))",join(directory,excelName)],{encoding:'utf8'});
    assert.match(xml,/Evening-only segment/);assert.doesNotMatch(xml,/Morning-only segment/);assert.doesNotMatch(xml,/name="Crew"/);
    assert.equal(await evaluate(`window.exportDownloads.length`),3);
    await check(`!document.querySelector('[role="dialog"]')`, 'Excel completed');
    const section = async (label,title) => {
      await click(label);
      await check(`[...document.querySelectorAll('h1')].some(n=>n.textContent===${JSON.stringify(title)})`, label+' SPA navigation');
    };
    await section('Integrations','Integrations');
    const connectNames=await evaluate(`[...document.querySelectorAll('button')].filter(n=>n.textContent.trim()==='Connect').map(n=>n.getAttribute('aria-label'))`);
    assert.ok(connectNames.length>2);assert.equal(new Set(connectNames).size,connectNames.length);assert.ok(connectNames.every(n=>n?.startsWith('Connect ')&&n.length>8));
    await section('Production Defaults','Production Defaults');
    assert.equal(await evaluate(`document.body.textContent.includes('General settings save automatically')&&document.body.textContent.includes('Preview changes here, then apply them to your screens.')`),true);
    assert.equal(await evaluate(`[...document.querySelectorAll('button')].find(n=>n.textContent.trim()==='Apply to screens')?.disabled`),true);
    await section('API & Webhooks','API & Webhooks');
    assert.equal(await evaluate(`(()=>{const n=document.querySelector('input[aria-label="Webhook URL"]');return !!n&&[...n.parentElement.querySelectorAll('button')].some(b=>b.textContent==='Save credential')})()`),true);
    await section('Lower Thirds','Lower Thirds');
    await check(`document.body.textContent.includes('scan the QR code to open that display on another device')&&!![...document.querySelectorAll('a')].find(n=>n.textContent==='Open overlay monitor')`,'explained overlay and QR');
    assert.deepEqual(await evaluate(`window.exportErrors`),[]);
    console.log(JSON.stringify({ passed:true, boundedList:true, boundedExport:true, lateReplyIgnored:true, sameDateShowIdentity:true, formats:['json','csv','xlsx'], widths:[320,768,1440], keyboardFocus:true, directory }));
  });
  await stopServer();
  assert.equal((await queryFixture("SELECT id FROM rundown WHERE orgId='display-smoke'")).length,2);
  assert.deepEqual(await queryFixture("SELECT id FROM rundown_item WHERE orgId='display-other'"),[]);
}, {secondShow:true});
