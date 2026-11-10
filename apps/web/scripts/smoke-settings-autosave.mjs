// Built-app recovery rehearsal using disposable D1, real authentication and Chrome.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { withLocalSmokeFixture } from './local-smoke-fixture.mjs';
import { poll, withRealBrowser } from './real-browser-fixture.mjs';
const web=createRequire(new URL('../package.json',import.meta.url));
const router=createRequire(web.resolve('@tanstack/react-router'));
const core=createRequire(router.resolve('@tanstack/router-core'));
const {toJSONAsync,fromJSON,fromCrossJSON}=core('seroval');
const {defaultSerovalPlugins}=router('@tanstack/router-core');
const names=['updateOrgSetting','getManageableOrgSettings','testProPresenterConnection'];
const ids={};const assets=resolve(import.meta.dirname,'../dist/server/assets');
for(const file of(await readdir(assets)).filter(file=>file.endsWith('.js'))){
  const source=await readFile(resolve(assets,file),'utf8');
  for(const name of names)ids[name]??=source.match(new RegExp(`const ${name}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`))?.[1];
}
assert.ok(names.every(name=>ids[name]),'Resolve this build’s Settings functions');
const expectedRequests=new Set();
await withLocalSmokeFixture(async({origin,orgId,operatorCookie,operatorPassword,stopServer,queryFixture,serverState})=>{
  async function rpc(data,cookie=operatorCookie){
    expectedRequests.add(data.requestId);
    const body=JSON.stringify(await toJSONAsync({data:{orgId,...data}}));
    const response=await fetch(`${origin}/_serverFn/${ids.updateOrgSetting}`,{method:'POST',headers:{Cookie:cookie,Origin:origin,'Sec-Fetch-Site':'same-origin','x-tsr-serverFn':'true','Content-Type':'application/json'},body});
    assert.equal(response.status,200);
    const reply=fromCrossJSON(await response.json(),{refs:new Map(),plugins:defaultSerovalPlugins});
    assert.equal(reply.error,undefined);assert.ok(reply.result);return reply.result;
  }
  const write=(key,value,expectedValue,cookie)=>rpc({key,value,expectedValue,requestId:crypto.randomUUID()},cookie);
  await write('org-timezone','America/New_York',null);
  const login=await fetch(`${origin}/api/auth/sign-in/email`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email:'second@display-smoke.invalid',password:operatorPassword})});
  assert.equal(login.status,200);await login.arrayBuffer();const secondCookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
  const concurrent=await Promise.all([write('default-timer-mode','countdown',null),write('default-timer-mode','countup',null,secondCookie)]);
  assert.deepEqual(concurrent.map(reply=>reply.outcome).sort(),['applied','conflict']);
  await withRealBrowser({origin,cookie:operatorCookie},async({page,evaluate})=>{
    await page('Page.enable');
    await page('Emulation.setTimezoneOverride',{timezoneId:'America/Toronto'});
    await page('Emulation.setLocaleOverride',{locale:'en-GB'});
    await page('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await page('Page.addScriptToEvaluateOnNewDocument',{source:`
      window.settingsDocument=crypto.randomUUID();window.settingsErrors=[];window.settingsModes={};window.settingsWrites=[];window.settingsHeld=[];window.settingsCalls={};
      addEventListener('error',event=>window.settingsErrors.push(event.message));addEventListener('unhandledrejection',event=>window.settingsErrors.push(String(event.reason)));
      const ids=${JSON.stringify(ids)};const original=window.fetch;
      window.fetch=(input,init)=>{
        const url=input instanceof Request?input.url:String(input);const name=Object.keys(ids).find(name=>url.includes('/_serverFn/'+ids[name]));
        if(!name)return original(input,init);
        window.settingsCalls[name]=(window.settingsCalls[name]??0)+1;
        if(name==='updateOrgSetting')window.settingsWrites.push(init.body);
        const mode=window.settingsModes[name];
        if(mode==='reject-once'){delete window.settingsModes[name];return Promise.reject(new Error('Fixture connection failed'));}
        const response=original(input,{...init,signal:new AbortController().signal}).then(async response=>new Response(await response.arrayBuffer(),{status:response.status,headers:response.headers}));
        if(mode==='hold')return new Promise(resolve=>window.settingsHeld.push({signal:init?.signal,release:async()=>resolve(await response)}));
        return response;
      };`});
    const check=async(expression,label,timeout)=>{
      try{return await poll(()=>evaluate(expression),label,timeout);}catch(error){
        console.log(JSON.stringify({failed:label,server:serverState(),ui:await evaluate(`({url:location.href,calls:window.settingsCalls,errors:window.settingsErrors,alerts:[...document.querySelectorAll('[role="alert"]')].map(node=>node.textContent),headings:[...document.querySelectorAll('h1,h2')].map(node=>node.textContent)})`)}));throw error;
      }
    };
    const mode=value=>evaluate(`window.settingsModes.updateOrgSetting=${JSON.stringify(value)};true`);
    // SSR controls can be visible before React attaches their event handlers.
    const click=async(name,scope='document')=>{
      let point;await poll(async()=>{
        point=await evaluate(`(async()=>{const root=${scope};const node=[...root.querySelectorAll('button,a,label')].find(el=>(el.getAttribute('aria-label')===${JSON.stringify(name)}||el.textContent.trim()===${JSON.stringify(name)})&&el.getBoundingClientRect().width>0&&!el.disabled&&el.closest('[role="dialog"]')?.dataset.state!=='closed');if(!node||!Object.keys(node).some(key=>key.startsWith('__reactProps')))return null;node.scrollIntoView({block:'center'});await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));const r=node.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return node.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`);return !!point;
      },`reachable ${name}`);
      await page('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await page('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
    };
    const select=(label,value)=>evaluate(`(()=>{const node=document.querySelector('select[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');if(!node)throw new Error('Missing select');node.value=${JSON.stringify(value)};node.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
    const fill=(label,value)=>evaluate(`(()=>{const node=document.querySelector('input[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');if(!node)throw new Error('Missing input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
    const saved=()=>check(`document.body.textContent.includes('General settings save automatically')&&!document.querySelector('button[aria-label^="Retry "]')`,'all Settings writes confirmed');
    await page('Page.navigate',{url:`${origin}/${orgId}/settings?section=organization`});
    await check(`document.querySelector('select[aria-label="Timezone"]')?.value==='America/New_York'`,'initial timezone');
    // Verify navigation after the click helper observes an attached React handler.
    await click('Production Defaults');await check(`!!document.querySelector('select[aria-label="Clock format"]')`,'production settings');
    await click('Organization');await check(`!!document.querySelector('select[aria-label="Timezone"]')`,'organization settings');
    const documentId=await evaluate('window.settingsDocument');
    await mode('hold');await select('Timezone','Europe/London');
    await check(`!!document.querySelector('button[aria-label="Retry Timezone"]')`,'timeout recovery',14_000);
    assert.equal(await evaluate(`document.querySelector('select[aria-label="Timezone"]').value`),'America/New_York');
    assert.equal(await evaluate('window.settingsHeld[0].signal.aborted'),true);
    for(const width of [320,768,1440]){
      await page('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
      await check(`document.documentElement.scrollWidth<=innerWidth+1`,'no horizontal overflow');
      await click('Retry Timezone');
      // Each retry still holds the same committed receipt and reaches a bounded error.
      await check(`!!document.querySelector('button[aria-label="Retry Timezone"]')`,'retry remains bounded',14_000);
      const geometry=await evaluate(`(()=>{const node=document.querySelector('button[aria-label="Retry Timezone"]');const r=node.getBoundingClientRect();return {height:r.height,width:r.width};})()`);
      assert.ok(geometry.height>=44&&geometry.width>=44);
      if(width===320)await writeFile('/tmp/showpilot-settings-recovery-320.png',Buffer.from((await page('Page.captureScreenshot',{format:'png'})).data,'base64'));
    }
    await mode('normal');await click('Production Defaults');await check(`!!document.querySelector('select[aria-label="Clock format"]')`,'production after failure');
    await select('Clock format','24hr');await check(`document.querySelector('select[aria-label="Clock format"]')?.value==='24hr'&&window.settingsWrites.length>=5`,'independent field');
    assert.equal(await evaluate(`!!document.querySelector('button[aria-label="Retry Timezone"]')`),true,'Other saves must not hide this error');
    await click('Organization');await check(`!!document.querySelector('select[aria-label="Timezone"]')`,'return to failed field');
    const before=await evaluate('window.settingsWrites.length');await select('Timezone','America/Chicago');
    assert.equal(await evaluate('window.settingsWrites.length'),before,'Newer edit waits for the uncertain request');
    await click('Retry Timezone');await saved();
    assert.equal(await evaluate(`document.querySelector('select[aria-label="Timezone"]').value`),'America/Chicago');
    await evaluate('Promise.all(window.settingsHeld.map(item=>item.release())).then(()=>true)');
    assert.equal(await evaluate(`document.querySelector('select[aria-label="Timezone"]').value`),'America/Chicago');
    console.log('Bounded saves, independent errors, exact Retry and newer edit passed');
    await write('org-timezone','America/Denver','America/Chicago',secondCookie);
    await select('Timezone','America/New_York');await check(`document.body.textContent.includes('This setting changed elsewhere')`,'conflict');
    await click('Use saved value');await saved();
    assert.equal(await evaluate(`document.querySelector('select[aria-label="Timezone"]').value`),'America/Denver');
    await write('org-timezone','Europe/London','America/Denver',secondCookie);
    await select('Timezone','America/New_York');await check(`document.body.textContent.includes('This setting changed elsewhere')`,'second conflict');
    await click('Apply my edit');await saved();
    assert.equal(await evaluate(`document.querySelector('select[aria-label="Timezone"]').value`),'America/New_York');
    console.log('Two-operator conflict review passed');
    await click('Integrations');await check(`!![...document.querySelectorAll('h3')].find(node=>node.textContent==='ProPresenter')`,'integrations');
    const card=`[...document.querySelectorAll('h3')].find(node=>node.textContent==='ProPresenter').parentElement.parentElement.parentElement.parentElement`;
    await click('Connect',card);await check(`!!document.querySelector('input[aria-label="ProPresenter host"]')`,'ProPresenter editor');await saved();
    await fill('ProPresenter host','venue.local');await mode('reject-once');await click('Apply & test',card);
    await check(`!!document.querySelector('button[aria-label="Retry ProPresenter host"]')`,'host save error');
    await check(`document.body.textContent.includes('Settings were not confirmed')`,'test blocked by save failure');
    assert.equal(await evaluate('window.settingsCalls.testProPresenterConnection??0'),0);
    await click('Retry ProPresenter host');await saved();
    await fill('ProPresenter host','unsent.local');await click(await evaluate(`([...document.querySelectorAll('button')].find(node=>node.textContent.trim().startsWith('Back to ')&&node.getBoundingClientRect().width>0)).textContent.trim()`));
    await check(`!![...document.querySelectorAll('[role="dialog"]')].find(node=>node.textContent.includes('Leave Settings?'))`,'leave guard');
    await click('Stay');assert.equal(await evaluate(`document.querySelector('input[aria-label="ProPresenter host"]').value`),'unsent.local');
    // Commit the preserved draft by blurring before changing sections.
    await evaluate(`document.querySelector('input[aria-label="ProPresenter host"]').focus();true`);
    await click('Production Defaults');await saved();
    await check(`!![...document.querySelectorAll('label')].find(node=>node.textContent.trim()==='Show upcoming lyric')`,'confidence editor');
    await click('Show upcoming lyric');await mode('hold');await click('Apply to screens');
    await fill('Current text color','#123456');
    await check(`!!document.querySelector('button[aria-label="Retry Confidence layout"]')`,'layout recovery',14_000);
    await click('Organization');await check(`document.body.textContent.includes('Leave Settings?')`,'preview navigation guard');await click('Stay');
    await mode('normal');await click('Retry Confidence layout');
    await check(`!![...document.querySelectorAll('button')].find(node=>node.textContent.trim()==='Apply to screens'&&!node.disabled)`,'newer preview remains unapplied');
    assert.equal(await evaluate(`document.querySelector('input[aria-label="Current text color"]').value`),'#123456');
    await click('Apply to screens');await check(`document.body.textContent.includes('Applied. Open screens will update')`,'newer preview confirmed');
    await evaluate('Promise.all(window.settingsHeld.map(item=>item.release())).then(()=>true)');
    const writes=await evaluate('window.settingsWrites');
    const inputs=writes.map(body=>fromJSON(JSON.parse(body)).data);
    const timezone=inputs.filter(input=>input.key==='org-timezone');
    assert.ok(timezone.slice(0,5).every(input=>input.requestId===timezone[0].requestId),'Timeout retries keep one request ID');
    inputs.forEach(input=>expectedRequests.add(input.requestId));
    assert.equal(await evaluate('window.settingsDocument'),documentId,'Same-document navigation throughout recovery');
    assert.deepEqual(await evaluate('window.settingsErrors'),[]);
    console.log(JSON.stringify({browserPassed:true,viewports:[320,768,1440],proPresenterTestBlocked:true,confidenceDraftPreserved:true,writeAttempts:inputs.length,uniqueRequests:expectedRequests.size}));
  });
  await stopServer();
  const rows=await queryFixture(`SELECT key,value FROM app_setting WHERE orgId='${orgId}'`);
  const state=Object.fromEntries(rows.map(row=>[row.key,row.value]));
  assert.equal(state['org-timezone'],'America/New_York');assert.equal(state['clock-format'],'24hr');assert.equal(state['propresenter-host'],'unsent.local');
  const layout=JSON.parse(state['default-confidence-layout']);assert.equal(layout.lyrics.showNext,false);assert.equal(layout.lyrics.color,'#123456');
  const receipts=rows.filter(row=>row.key.startsWith('setting-write:'));
  assert.deepEqual(receipts.map(row=>row.key.slice('setting-write:'.length)).sort(),[...expectedRequests].sort());
  assert.ok(receipts.some(row=>JSON.parse(row.value).outcome==='conflict'));
  console.log(JSON.stringify({databasePassed:true,receipts:receipts.length,finalSettingsCorrect:true}));
},{paidPlan:true,secondOperator:true});
