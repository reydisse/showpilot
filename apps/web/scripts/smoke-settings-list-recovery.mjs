// Real Settings reads/writes with delayed responses, using disposable accounts only.
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { withLocalSmokeFixture } from './local-smoke-fixture.mjs';
import { poll, withRealBrowser } from './real-browser-fixture.mjs';

const names = ['listCompanionTokens','createCompanionToken','revokeCompanionToken','getRecentWebhookEvents','getKioskTeams','listKioskTokens','createKioskToken','revokeKioskToken','getDutyRosterState'];
const ids = {};
const assets = resolve(import.meta.dirname,'../dist/server/assets');
for (const file of (await readdir(assets)).filter(file => file.endsWith('.js'))) {
  const source = await readFile(resolve(assets,file),'utf8');
  for (const name of names) ids[name] ??= source.match(new RegExp(`const ${name}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`))?.[1];
}
assert.ok(names.every(name => ids[name]), 'Resolve the real server functions from this build');

await withLocalSmokeFixture(async ({origin,orgId,operatorCookie,queryFixture,stopServer,startServer,serverState}) => {
  await withRealBrowser({origin,cookie:operatorCookie}, async ({page,evaluate}) => {
    await page('Page.enable');
    await page('Emulation.setFocusEmulationEnabled',{enabled:true});
    await page('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await page('Page.addScriptToEvaluateOnNewDocument',{source:`
      window.settingsErrors=[]; addEventListener('error',e=>window.settingsErrors.push(e.message)); addEventListener('unhandledrejection',e=>window.settingsErrors.push(String(e.reason)));
      window.settingsDocument=crypto.randomUUID(); window.readModes={listCompanionTokens:'hold'}; window.heldReads=[]; window.calls={};
      const ids=${JSON.stringify(ids)}; const original=window.fetch;
      window.fetch=(input,init)=>{
        const url=input instanceof Request?input.url:String(input);
        const name=Object.keys(ids).find(name=>url.includes('/_serverFn/'+ids[name]));
        if(name) window.calls[name]=(window.calls[name]??0)+1;
        if(name && (name.startsWith('get') || name.startsWith('list'))) {
          const signal=init?.signal;
          const response=original(input,{...init,signal:new AbortController().signal}).then(async response=>new Response(await response.arrayBuffer(),{status:response.status,headers:response.headers}));
          if(window.readModes[name]==='hold') return new Promise(resolve=>window.heldReads.push({name,signal,release:async()=>resolve(await response)}));
          return response;
        }
        return original(input,init);
      };`});
    const click = name => evaluate(`(() => {const button=[...document.querySelectorAll('button')].find(node=>(node.getAttribute('aria-label')===${JSON.stringify(name)} || node.textContent.trim()===${JSON.stringify(name)}) && node.getBoundingClientRect().width>0); if(!button || button.disabled) throw new Error('Unavailable button: '+${JSON.stringify(name)}); button.click(); return true;})()`);
    const fill = (selector,value) => evaluate(`(() => {const node=document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,${JSON.stringify(value)}); node.dispatchEvent(new Event('input',{bubbles:true})); node.dispatchEvent(new Event('change',{bubbles:true})); return true;})()`);
    const setMode = (name,mode) => evaluate(`window.readModes[${JSON.stringify(name)}]=${JSON.stringify(mode)}; true`);
    const release = name => evaluate(`Promise.all(window.heldReads.filter(read=>read.name===${JSON.stringify(name)}).map(read=>read.release())).then(()=>true)`);
    const failed = label => poll(()=>evaluate(`!!document.querySelector('[role="alert"][aria-label=${JSON.stringify(label)}] time') && !document.querySelector('button[aria-label=${JSON.stringify(label)}]')?.disabled`),label,12_000);
    let proxyRestarts = 0;
    const recovered = async label => {
      try { await poll(()=>evaluate(`!document.querySelector('[role="alert"][aria-label=${JSON.stringify(label)}]')`),`${label} recovers`); }
      catch(error) {
        const state=serverState();
        if ((state.exitCode===null && state.signalCode===null) || proxyRestarts>=1) {
          console.error(JSON.stringify(await evaluate(`({calls:window.calls,modes:window.readModes,visibility:document.visibilityState,errors:window.settingsErrors,reads:window.heldReads.map(read=>({name:read.name,aborted:read.signal?.aborted}))})`))); throw error;
        }
        // Wrangler's dev proxy can exit on Network connection lost. Only a
        // confirmed terminal process permits this one restart, never an app timeout.
        proxyRestarts++; console.log(JSON.stringify({fixtureProxyExited:state,label}));
        await startServer(); await click(label);
        await poll(()=>evaluate(`!document.querySelector('[role="alert"][aria-label=${JSON.stringify(label)}]')`),'read recovers after fixture proxy restart');
      }
    };
    const section = async name => { await click(name); await poll(()=>evaluate(`[...document.querySelectorAll('main h1')].some(node=>node.textContent.trim()===${JSON.stringify(name)})`),`${name} section`); };
    await page('Page.navigate',{url:`${origin}/${orgId}/settings?section=companion`});
    await failed('Retry Companion tokens');
    const documentId=await evaluate('window.settingsDocument');
    assert.equal(await evaluate(`document.querySelector('main').textContent.includes('No tokens yet') || document.querySelector('main').textContent.includes('Loading…')`),false);
    await setMode('listCompanionTokens','normal'); await release('listCompanionTokens');
    assert.equal(await evaluate(`!!document.querySelector('[role="alert"][aria-label="Retry Companion tokens"]')`),true,'late read cannot remove the error');
    await click('Retry Companion tokens'); await recovered('Retry Companion tokens');
    await poll(()=>evaluate(`document.querySelector('main').textContent.includes('No tokens yet')`),'confirmed empty list');

    // A real token is issued once. Losing the follow-up read must not lose its
    // one-time value or make read Retry issue another token.
    await setMode('listCompanionTokens','hold');
    await fill('input[aria-label="Token label"]','Fixture desk'); await click('Generate');
    await poll(()=>evaluate(`!!document.querySelector('textarea[aria-label="New token"]')`),'new token remains available');
    await failed('Retry Companion tokens');
    const issuedLength=await evaluate(`document.querySelector('textarea[aria-label="New token"]').value.length`);
    assert.ok(issuedLength>20);
    await setMode('listCompanionTokens','normal'); await click('Retry Companion tokens'); await recovered('Retry Companion tokens');
    assert.equal(await evaluate('window.calls.createCompanionToken'),1);
    assert.equal(await evaluate(`document.querySelector('textarea[aria-label="New token"]').value.length`),issuedLength);
    await click('Dismiss token');
    await setMode('listCompanionTokens','hold');
    await evaluate(`document.querySelector('button[title="Revoke token"]').click(); true`); await click('Revoke token');
    await failed('Retry Companion tokens');
    await setMode('listCompanionTokens','normal'); await click('Retry Companion tokens'); await recovered('Retry Companion tokens');
    await release('listCompanionTokens');
    assert.equal(await evaluate('window.calls.revokeCompanionToken'),1);
    assert.equal(await evaluate(`document.querySelector('main').textContent.includes('No tokens yet')`),true);

    await setMode('getRecentWebhookEvents','hold'); await section('API & Webhooks'); await failed('Retry webhook events');
    assert.equal(await evaluate(`document.querySelector('main').textContent.includes('Loading events...') || document.querySelector('main').textContent.includes('No recent events')`),false);
    await setMode('getRecentWebhookEvents','normal'); await click('Retry webhook events'); await recovered('Retry webhook events'); await release('getRecentWebhookEvents');
    await poll(()=>evaluate(`document.querySelector('main').textContent.includes('No recent events')`),'confirmed empty webhook history');

    await setMode('getKioskTeams','hold'); await section('Kiosk Displays'); await failed('Retry kiosk organization');
    assert.equal(await evaluate(`document.querySelector('main').textContent.includes('Loading kiosk organization') || document.querySelector('main').textContent.includes('No teams yet')`),false);
    // Tokens remain accessible when the unrelated org-chart read is unavailable.
    await setMode('listKioskTokens','hold'); await click('Access Tokens'); await failed('Retry kiosk tokens');
    assert.equal(await evaluate(`document.querySelector('main').textContent.includes('No tokens yet') || document.querySelector('main').textContent.includes('Loading…')`),false);
    for(const width of [320,768,1440]) {
      await page('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
      await poll(()=>evaluate(width<1024?`!!document.querySelector('button[aria-label="Open menu"]')`:`!document.querySelector('button[aria-label="Open menu"]')`),'responsive layout');
      await evaluate(`document.querySelector('button[aria-label="Retry kiosk tokens"]').scrollIntoView({block:'center'}); new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))`);
      const bounds=await evaluate(`(() => {const node=document.querySelector('button[aria-label="Retry kiosk tokens"]'); const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height,reachable:node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};})()`);
      assert.ok(bounds.left>=0 && bounds.right<=width && bounds.height>=44 && bounds.top>=0 && bounds.bottom<=900 && bounds.reachable,JSON.stringify({width,bounds}));
      if(width===320) {const shot=await page('Page.captureScreenshot',{format:'png'}); await writeFile('/tmp/showpilot-settings-list-error-320.png',Buffer.from(shot.data,'base64'));}
    }
    await setMode('listKioskTokens','normal'); await click('Retry kiosk tokens'); await recovered('Retry kiosk tokens'); await release('listKioskTokens');
    await click('Org Chart'); await setMode('getKioskTeams','normal'); await click('Retry kiosk organization'); await recovered('Retry kiosk organization'); await release('getKioskTeams');
    await poll(()=>evaluate(`document.querySelector('main').textContent.includes('No teams yet')`),'org read recovered');

    await click('On-Duty Roster');
    await poll(()=>evaluate(`document.querySelector('main').textContent.includes('No technical roster roles are defined yet.')`),'no roster roles');
    await click('Add default roles (TM, Audio, Cam 1/2, Pro, Stream)');
    await poll(()=>evaluate(`document.querySelectorAll('select[aria-label$=" assignment"]').length===7`),'default roles acknowledged');
    await setMode('getDutyRosterState','hold');
    await fill('input[aria-label="Roster week starting Sunday"]','2031-01-26');
    await failed('Retry roster week');
    assert.equal(await evaluate(`document.querySelector('main').textContent.includes('Loading roster week')`),false);
    assert.equal(await evaluate(`document.querySelectorAll('select[aria-label$=" assignment"]').length`),0,'unknown week cannot look unassigned');
    await setMode('getDutyRosterState','normal');
    await fill('input[aria-label="Roster week starting Sunday"]','2031-02-02');
    await poll(()=>evaluate(`document.querySelectorAll('select[aria-label$=" assignment"]').length>0 && !document.querySelector('[role="alert"][aria-label="Retry roster week"]')`),'another roster week loads');
    await release('getDutyRosterState');
    assert.equal(await evaluate(`document.querySelector('input[aria-label="Roster week starting Sunday"]').value`),'2031-02-02');
    await evaluate(`const node=document.querySelector('select[aria-label$=" assignment"]'); node.value='smoke-operator'; node.dispatchEvent(new Event('change',{bubbles:true})); true`);
    await setMode('getDutyRosterState','hold');
    await evaluate(`window.dispatchEvent(new Event('visibilitychange')); true`);
    await failed('Retry roster week');
    assert.equal(await evaluate(`document.querySelector('select[aria-label$=" assignment"]').value`),'smoke-operator');
    await setMode('getDutyRosterState','normal'); await click('Retry roster week'); await recovered('Retry roster week'); await release('getDutyRosterState');
    assert.equal(await evaluate(`document.querySelector('select[aria-label$=" assignment"]').value`),'smoke-operator','read Retry preserves the draft');
    assert.equal(await evaluate('window.settingsDocument'),documentId); assert.deepEqual(await evaluate('window.settingsErrors'),[]);
    console.log(JSON.stringify({fixtureProxyRestarts:proxyRestarts}));
  });
  // Inspect SQLite after the browser/server close, keeping the dev Worker and
  // the CLI from owning the same local database concurrently.
  await stopServer();
  const rows=await queryFixture(`SELECT id,revokedAt FROM companion_token WHERE orgId='${orgId}'`);
  assert.equal(rows.length,1); assert.ok(rows[0].revokedAt);
  console.log(JSON.stringify({passed:true,boundedReads:['Companion tokens','webhook events','kiosk organization','kiosk tokens','roster week'],noFalseEmptyStates:true,lateRepliesIgnored:true,issuedTokenRetained:true,createAndRevokeNotReplayed:true,rosterWeekIsolation:true,rosterDraftRetained:true,retryWidths:[320,768,1440],persistedTokenRevocation:true}));
});
