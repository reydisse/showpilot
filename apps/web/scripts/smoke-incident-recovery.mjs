// Real authentication, D1 and browser. Only disposable fixture data is written.
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { withLocalSmokeFixture } from './local-smoke-fixture.mjs';
import { poll, withRealBrowser } from './real-browser-fixture.mjs';

const names = ['getIncidentSnapshot', 'mutateIncident'];
const ids = {};
const assets = resolve(import.meta.dirname, '../dist/server/assets');
for (const file of (await readdir(assets)).filter(file => file.endsWith('.js'))) {
  const source = await readFile(resolve(assets, file), 'utf8');
  for (const name of names) ids[name] ??= source.match(new RegExp(`const ${name}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`))?.[1];
}
assert.ok(names.every(name => ids[name]), 'Resolve incident RPCs from the tested build');
await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, stopServer, serverState, queryFixture }) => {
  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    await page('Page.enable');
    await page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.incidentDocument=crypto.randomUUID();window.incidentErrors=[];
      addEventListener('error',event=>window.incidentErrors.push(event.message));addEventListener('unhandledrejection',event=>window.incidentErrors.push(String(event.reason)));
      const ids=${JSON.stringify(ids)};window.incidentModes={};window.incidentCalls={};window.incidentHeld=[];window.incidentWrites=[];
      const original=window.fetch;window.incidentOriginal=original;
      window.fetch=(input,init)=>{
        const url=input instanceof Request?input.url:String(input);const name=Object.keys(ids).find(name=>url.includes('/_serverFn/'+ids[name]));
        if(!name)return original(input,init);
        window.incidentCalls[name]=(window.incidentCalls[name]??0)+1;
        if(name==='mutateIncident')window.incidentWrites.push({input,init});
        // Buffer the actual committed response on an independent transport. The
        // application's cancellation must not interrupt Wrangler's response stream.
        const response=original(input,{...init,signal:new AbortController().signal}).then(async response=>new Response(await response.arrayBuffer(),{status:response.status,headers:response.headers}));
        if(window.incidentModes[name]==='hold')return new Promise(resolve=>window.incidentHeld.push({name,release:async()=>resolve(await response)}));
        return response;
      };` });
    const observe = async (check, label, timeout) => {
      try { return await poll(check, label, timeout); }
      catch (error) {
        console.log(JSON.stringify({ observation: label, server: serverState(), ui: await evaluate(`({calls:window.incidentCalls,errors:window.incidentErrors,text:document.body.innerText.slice(-5000)})`) }));
        throw error;
      }
    };
    const clickSelector = async selector => {
      let point;
      await observe(async () => {
        point = await evaluate(`(async()=>{
          const dialog=[...document.querySelectorAll('[role="dialog"][data-state="open"]')].at(-1);
          const node=[...(dialog??document).querySelectorAll(${JSON.stringify(selector)})].find(node=>node.getBoundingClientRect().width>0&&!node.disabled&&node.closest('[role="dialog"]')?.dataset.state!=='closed');
          if(!node)return null;node.scrollIntoView({block:'center'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
          const r=node.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return node.contains(document.elementFromPoint(x,y))?{x,y}:null;
        })()`);
        return !!point;
      }, `reachable ${selector}`);
      await page('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await page('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    };
    const click = async name => {
      await evaluate(`for(const node of document.querySelectorAll('button')){if(node.getAttribute('aria-label')===${JSON.stringify(name)}||node.textContent.trim()===${JSON.stringify(name)})node.dataset.incidentClick=${JSON.stringify(name)};}true`);
      await clickSelector(`button[data-incident-click=${JSON.stringify(name)}]`);
    };
    const fill = async (selector, value) => {
      await observe(() => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), `mounted ${selector}`);
      return evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});const proto=input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
    };
    const mode = (name, value) => evaluate(`window.incidentModes[${JSON.stringify(name)}]=${JSON.stringify(value)};true`);
    const release = name => evaluate(`Promise.all(window.incidentHeld.filter(item=>item.name===${JSON.stringify(name)}).map(item=>item.release())).then(()=>true)`);
    const failed = label => observe(() => evaluate(`!![...document.querySelectorAll('[role="alert"]')].find(node=>node.getAttribute('aria-label')===${JSON.stringify(label)}&&node.querySelector('time')&&node.getBoundingClientRect().width>0)`), label, 14_000);
    const ready = () => observe(() => evaluate(`!!document.querySelector('button[aria-label^="Delete incident:"]')&&!document.querySelector('button[aria-label^="Delete incident:"]').disabled`), 'confirmed incident');
    const noForm = () => observe(() => evaluate(`!document.querySelector('[role="dialog"][data-state="open"]')`), 'report closes after acknowledgement');
    const retryWrite = async index => {
      await mode('mutateIncident', 'normal');
      await click('Retry incident save');
      await observe(() => evaluate(`window.incidentWrites.length>${index + 1}&&!document.querySelector('button[aria-label="Retry incident save"]')`), 'retry acknowledged');
      assert.equal(await evaluate(`window.incidentWrites[${index}].init.body===window.incidentWrites[${index + 1}].init.body`), true, 'Retry must reuse the exact operation and request ID');
      await release('mutateIncident');
    };
    const replay = index => evaluate(`(async()=>{const saved=window.incidentWrites[${index}];const response=await window.incidentOriginal(saved.input,{...saved.init,signal:new AbortController().signal});const body=await response.text();return response.ok&&body.includes('applied');})()`);
    await page('Page.navigate', { url: `${origin}/${orgId}/production/incidents` });
    await observe(() => evaluate(`window.incidentCalls.getIncidentSnapshot>=1&&document.body.textContent.includes('No incidents for this date')`), 'hydrated incident page');
    const documentId = await evaluate('window.incidentDocument');
    await click('Report');
    await fill('#incident-description', 'Fixture camera signal lost');
    await mode('mutateIncident', 'hold');await click('Submit report');await failed('Retry incident save');
    assert.equal(await evaluate(`document.querySelector('#incident-description').value`), 'Fixture camera signal lost');
    await release('mutateIncident');
    assert.equal(await evaluate(`!!document.querySelector('button[aria-label="Retry incident save"]')`), true, 'Late response cannot confirm a timed-out attempt');
    // Retry acknowledges the committed report even when the subsequent read fails.
    await mode('getIncidentSnapshot', 'hold');await retryWrite(0);await noForm();await failed('Retry incidents');
    assert.equal(await evaluate(`document.body.textContent.includes('Change saved.')`), true);
    await mode('getIncidentSnapshot', 'normal');await click('Retry incidents');await ready();await release('getIncidentSnapshot');
    assert.equal(await evaluate('window.incidentWrites.length'), 2, 'Read Retry never repeats the report');
    console.log('Report response loss, exact retry and independent read recovery passed');

    await clickSelector('button[aria-controls^="discussion-"]');
    await observe(() => evaluate(`!!document.querySelector('textarea[aria-label^="Update for"]')`), 'discussion opens');
    await fill('textarea[aria-label^="Update for"]', 'First confirmed update');
    await mode('mutateIncident', 'hold');await click('Post comment');await failed('Retry incident save');
    await fill('textarea[aria-label^="Update for"]', 'Newer local draft');
    await retryWrite(2);await ready();
    assert.equal(await evaluate(`document.querySelector('textarea[aria-label^="Update for"]').value`), 'Newer local draft');
    await fill('textarea[aria-label^="Update for"]', '');
    assert.equal(await evaluate(`[...document.querySelectorAll('p')].filter(node=>node.textContent==='First confirmed update').length`), 1);
    console.log('Comment saved once and newer draft retained');

    await click('Add reaction');await mode('mutateIncident', 'hold');await click('React 👍');await failed('Retry incident save');await retryWrite(4);await ready();
    assert.equal(await evaluate(`document.querySelector('button[aria-label="React 👍"]').getAttribute('aria-pressed')`), 'true');
    await mode('mutateIncident', 'hold');await click('React 👍');await failed('Retry incident save');await retryWrite(6);await ready();
    assert.equal(await evaluate(`!!document.querySelector('button[aria-label="React 👍"]')`), false);
    assert.equal(await replay(4), true, 'Replayed add keeps its acknowledgement after removal');
    console.log('Lost reaction add/remove responses retried without inversion');

    // Keep a reaction for deletion cleanup, and measure the real controls.
    await click('Add reaction');await click('React 👍');await ready();
    for (const width of [320, 768, 1440]) {
      await page('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await observe(() => evaluate(width < 1024 ? `!!document.querySelector('button[aria-label="Open menu"]')` : `!document.querySelector('button[aria-label="Open menu"]')`), 'responsive incident layout');
      for (const selector of ['button[aria-label^="Delete incident:"]', 'button[aria-label="Post comment"]', 'button[aria-label="Add reaction"]', 'button[aria-label="React 👍"]', 'textarea[aria-label^="Update for"]']) {
        const bounds = await evaluate(`(async()=>{const node=document.querySelector(${JSON.stringify(selector)});node.scrollIntoView({block:'center'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const r=node.getBoundingClientRect();return {left:r.left,right:r.right,height:r.height,hit:node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};})()`);
        assert.ok(bounds.left >= 0 && bounds.right <= width && bounds.height >= 44 && bounds.hit, JSON.stringify({ width, selector, bounds }));
      }
      await click('Add reaction');
      const picker = await evaluate(`(()=>{const node=document.querySelector('input[aria-label="Type or paste any emoji"]'),r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};})()`);
      assert.ok(picker.left >= 0 && picker.right <= width && picker.top >= 0 && picker.bottom <= 900, JSON.stringify({ width, picker }));
      if (width === 320) { const shot = await page('Page.captureScreenshot', { format: 'png' });await writeFile('/tmp/showpilot-incidents-discussion-320.png', Buffer.from(shot.data, 'base64')); }
      await click('Add reaction');
    }
    // Draft navigation requires a decision and Stay keeps the draft.
    await fill('textarea[aria-label^="Update for"]', 'Unsaved discussion draft');
    await evaluate(`document.querySelector('a[href="/${orgId}/production/checklist"]').click();true`);
    await observe(() => evaluate(`document.querySelector('[role="dialog"][data-state="open"]')?.textContent.includes('Leave these incidents?')`), 'draft navigation warning');await click('Stay');
    assert.equal(await evaluate(`document.querySelector('textarea[aria-label^="Update for"]').value`), 'Unsaved discussion draft');await fill('textarea[aria-label^="Update for"]', '');
    const beforeCancel = await evaluate('window.incidentWrites.length');await click('Delete incident: Fixture camera signal lost');await click('Cancel');
    assert.equal(await evaluate('window.incidentWrites.length'), beforeCancel);
    await mode('mutateIncident', 'hold');await click('Delete incident: Fixture camera signal lost');await click('Delete');await failed('Retry incident save');await retryWrite(9);
    await observe(() => evaluate(`!document.querySelector('button[aria-label^="Delete incident:"]')&&document.body.textContent.includes('No incidents for this date')`), 'incident and discussion deleted');
    assert.equal(await replay(0), true, 'Old report is acknowledged without recreating it');
    // Retain one report to check both persisted rows and show isolation.
    await click('Report');await fill('#incident-description', 'Retained fixture report');await click('Submit report');await noForm();await ready();
    await mode('getIncidentSnapshot', 'hold');await click('Choose show');
    await observe(() => evaluate(`!![...document.querySelectorAll('[role="menuitem"]')].find(node=>node.textContent.includes('Evening test show'))`), 'show menu');
    await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(node=>node.textContent.includes('Evening test show')).click();true`);
    await failed('Retry incidents');assert.equal(await evaluate(`document.body.textContent.includes('Retained fixture report')||document.body.textContent.includes('No incidents for this date')||document.body.textContent.includes('Loading incidents for')`), false);
    for (const [width, height] of [[320, 900], [320, 480], [768, 900], [1440, 900]]) {
      await page('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await observe(() => evaluate(width < 1024 ? `!!document.querySelector('button[aria-label="Open menu"]')` : `!document.querySelector('button[aria-label="Open menu"]')`), 'responsive retry layout');
      await click('Report');
      await observe(() => evaluate(`!!document.querySelector('#incident-description')&&[...document.querySelectorAll('[role="dialog"][data-state="open"]')].every(node=>node.getAnimations().every(animation=>animation.playState!=='running'))`), 'report form with read failure after opening animation');
      for (const selector of ['#incident-description', '#incident-category', '#incident-severity', '#incident-reporter', '[role="dialog"] button[aria-label="Retry incidents"]']) {
        const bounds = await evaluate(`(async()=>{const node=document.querySelector(${JSON.stringify(selector)});node.scrollIntoView({block:'center'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const r=node.getBoundingClientRect();return {left:r.left,right:r.right,height:r.height,hit:node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};})()`);
        assert.ok(bounds.left >= 0 && bounds.right <= width && bounds.height >= 44 && bounds.hit, JSON.stringify({ width, selector, bounds }));
      }
      if (width === 320) { const shot = await page('Page.captureScreenshot', { format: 'png' });await writeFile(`/tmp/showpilot-incidents-recovery-320-${height}.png`, Buffer.from(shot.data, 'base64')); }
      await click('Cancel');await noForm();
    }
    await mode('getIncidentSnapshot', 'normal');await click('Retry incidents');
    await observe(() => evaluate(`document.body.textContent.includes('No incidents for this date')&&!document.querySelector('button[aria-label="Retry incidents"]')`), 'confirmed empty other show');await release('getIncidentSnapshot');
    assert.equal(await evaluate('window.incidentDocument'), documentId);
    assert.deepEqual(await evaluate('window.incidentErrors'), []);
    // Mobile reports can exist on a date with no show. Preserve discussion and
    // deletion through the real history link, without allowing a new show report.
    await page('Page.navigate', { url: `${origin}/${orgId}/production/incidents?date=2000-01-01&incident=smoke-date-incident` });
    await observe(() => evaluate(`window.incidentCalls.getIncidentSnapshot>=1&&!!document.querySelector('button[aria-label="Delete incident: Date-only fixture incident"]')&&!document.querySelector('button[aria-label="Delete incident: Date-only fixture incident"]').disabled`), 'date-only incident remains manageable');
    assert.equal(await evaluate(`[...document.querySelectorAll('button')].some(node=>node.textContent.trim()==='Report')`), false);
    await fill('textarea[aria-label="Update for Date-only fixture incident"]', 'Date-only follow-up');await click('Post comment');await ready();
    await click('Add reaction');await click('React 👍');await ready();
    await click('Delete incident: Date-only fixture incident');await click('Delete');
    await observe(() => evaluate(`!document.querySelector('button[aria-label^="Delete incident:"]')&&document.body.textContent.includes('No incidents for this date')`), 'date-only incident deleted');
    assert.deepEqual(await evaluate('window.incidentErrors'), []);
    console.log(JSON.stringify({ passed: true, lostResponses: ['report', 'comment', 'reaction-add', 'reaction-remove', 'delete'], exactRetries: true, readRetryDoesNotWrite: true, noReload: true, showIsolation: true, widths: [320, 768, 1440] }));
  });
  await stopServer();
  const reports = await queryFixture(`SELECT description,showId FROM incident WHERE orgId='${orgId}'`);
  assert.deepEqual(reports, [{ description: 'Retained fixture report', showId: 'smoke-show' }]);
  assert.deepEqual(await queryFixture(`SELECT id FROM incident_comment WHERE orgId='${orgId}'`), []);
  assert.deepEqual(await queryFixture(`SELECT id FROM content_reaction WHERE orgId='${orgId}'`), []);
  const receipts = await queryFixture(`SELECT key FROM app_setting WHERE orgId='${orgId}' AND key LIKE 'incident-write:%'`);
  assert.equal(receipts.length, 10);
  const notifications = await queryFixture(`SELECT type,userId,COUNT(*) AS count FROM notification WHERE orgId='${orgId}' GROUP BY type,userId ORDER BY type`);
  assert.deepEqual(notifications, [{ type: 'incident-comment', userId: 'smoke-second-operator', count: 2 }, { type: 'incident-created', userId: 'smoke-second-operator', count: 2 }]);
  console.log(JSON.stringify({ persistedReports: reports.length, receipts: receipts.length, backgroundNotifications: notifications, deletedDiscussionAndReactions: true }));
}, { secondShow: true, secondOperator: true, dateOnlyIncident: true });
