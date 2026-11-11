// Compiled app, real authentication and D1. Outbound email stays in the fixture.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { withLocalSmokeFixture } from './local-smoke-fixture.mjs';
import { poll, withRealBrowser } from './real-browser-fixture.mjs';
const require = createRequire(new URL('../package.json', import.meta.url));
const router = createRequire(require.resolve('@tanstack/react-router'));
const core = createRequire(router.resolve('@tanstack/router-core'));
const { toJSONAsync, fromJSON, fromCrossJSON } = core('seroval');
const { defaultSerovalPlugins } = router('@tanstack/router-core');
const ids = {}, names = ['getScheduleAssignment', 'changeScheduleAssignment'];
const assets = resolve(import.meta.dirname, '../dist/server/assets');
for (const file of (await readdir(assets)).filter(file => file.endsWith('.js'))) {
  const source = await readFile(resolve(assets, file), 'utf8');
  for (const name of names) ids[name] ??= source.match(new RegExp(`const ${name}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`))?.[1];
}
assert.ok(names.every(name => ids[name]));
await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, queryFixture, capturedEmails }) => {
  async function rpc(name, data) {
    const payload = JSON.stringify(await toJSONAsync({ data: { orgId, ...data } }));
    const url = `${origin}/_serverFn/${ids[name]}`;
    const headers = { Cookie: operatorCookie, Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'x-tsr-serverFn': 'true', 'Content-Type': 'application/json' };
    const response = await fetch(name === 'getScheduleAssignment' ? `${url}?payload=${encodeURIComponent(payload)}` : url,
      name === 'getScheduleAssignment' ? { headers } : { method: 'POST', headers, body: payload });
    assert.equal(response.status, 200);
    const reply = fromCrossJSON(await response.json(), { refs: new Map(), plugins: defaultSerovalPlugins });
    assert.equal(reply.error, undefined); assert.equal(reply instanceof Error, false); return reply.result;
  }
  const actor = await rpc('getScheduleAssignment', { id: 'assignment-accept' });
  async function edit(snapshot, notes) {
    return rpc('changeScheduleAssignment', { userId: actor.userId, requestId: crypto.randomUUID(), operation: {
      kind: 'edit', id: snapshot.id, expectedRevision: snapshot.revision, fields: {
        showId: snapshot.showId, serviceDate: snapshot.serviceDate, role: snapshot.role, department: snapshot.department,
        crewMemberId: snapshot.crewMemberId, callTime: snapshot.callTime, timeZone: 'UTC', notes,
      },
    } });
  }
  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    await page('Page.enable'); await page('Emulation.setFocusEmulationEnabled', { enabled: true });
    await page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.assignmentCalls=[];window.assignmentHeld=[];window.assignmentErrors=[];window.assignmentMode='hold';window.assignmentDocument='same';
      addEventListener('error',e=>assignmentErrors.push(e.message));addEventListener('unhandledrejection',e=>assignmentErrors.push(String(e.reason)));
      const original=fetch;window.fetch=async(input,options)=>{
        const url=input instanceof Request?input.url:String(input);if(!url.includes('/_serverFn/${ids.changeScheduleAssignment}'))return original(input,options);
        assignmentCalls.push(options.body);
        if(assignmentMode==='fail-camera'&&options.body.includes('Fixture Camera'))throw new TypeError('Fixture transport offline');
        const hold=assignmentMode==='hold';const response=await original(input,hold?{...options,signal:new AbortController().signal}:options);
        if(!hold)return response;const bytes=await response.arrayBuffer();return new Promise(resolve=>assignmentHeld.push(()=>resolve(new Response(bytes,{status:response.status,headers:response.headers}))));
      };` });
    const check = (expression, description) => poll(() => evaluate(expression), description).catch(async error => {
      console.log(JSON.stringify({ description, body: await evaluate('document.body.innerText'), errors: await evaluate('assignmentErrors') })); throw error;
    });
    const button = name => `[...(document.querySelector('[role=dialog]')??document).querySelectorAll('button')].find(b=>(b.textContent.trim()===${JSON.stringify(name)}||b.getAttribute('aria-label')===${JSON.stringify(name)})&&!b.disabled&&b.getBoundingClientRect().width>0)`;
    const field = label => `[...document.querySelectorAll('[role=dialog] label')].find(n=>n.querySelector('span')?.textContent===${JSON.stringify(label)})?.querySelector('input,select,textarea')`;
    const click = async expression => {
      const point = await check(`(async()=>{const n=${expression};if(!n||!Object.keys(n).some(k=>k.startsWith('__reactProps')))return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`, 'reachable '+expression);
      for (const type of ['mousePressed','mouseReleased']) await page('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
    };
    const fill = async (label, value) => {
      await check(`!!(${field(label)})`, 'field '+label);
      await evaluate(`(()=>{const n=${field(label)};Object.getOwnPropertyDescriptor(Object.getPrototypeOf(n),'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
      await check(`(${field(label)}).value===${JSON.stringify(value)}`, 'retained '+label);
    };
    const calls = async () => (await evaluate('assignmentCalls')).map(body => fromJSON(JSON.parse(body)).data);
    await page('Page.navigate', { url: `${origin}/${orgId}/schedule?date=2099-01-01&show=assignment-show&month=2099-01` });
    await click(button('Add position'));
    await fill('Position', 'Recovery position'); await fill('Manager note', 'Retained draft');
    const crewId = await evaluate(`(${field('Roster contact')}).options[1].value`);
    await fill('Roster contact', crewId); await click(button('Add position'));
    await check('assignmentHeld.length===1', 'save committed with reply held');
    const created = await queryFixture("SELECT id FROM service_assignment WHERE orgId='display-smoke' AND role='Recovery position'");
    assert.equal(created.length, 1); const id = created[0].id;
    assert.equal((await capturedEmails()).length, 1);
    await click(button('Close assignment'));
    await click(`document.querySelector('a[href="/${orgId}/songs"]')`);
    await check("location.pathname.endsWith('/songs')", 'navigation away'); await evaluate('history.back()');
    await check("location.pathname.endsWith('/schedule')", 'return to schedule'); await click(button('Add position'));
    await check(`!!${button('Retry unconfirmed saves or invitations')}`, 'save deadline across navigation');
    assert.equal(await evaluate(`(${field('Manager note')}).value`), 'Retained draft');
    await evaluate("assignmentMode='pass';assignmentHeld.splice(0).forEach(release=>release());true");
    await click(button('Retry unconfirmed saves or invitations'));
    await check("document.querySelector('[role=dialog]').textContent.includes('Assignment saved.')", 'recovered save');
    const initialCalls = await calls(); assert.deepEqual(initialCalls[1], initialCalls[0]);
    assert.equal((await capturedEmails()).length, 1);
    assert.equal((await queryFixture("SELECT id FROM service_assignment WHERE orgId='display-smoke' AND role='Recovery position'")).length, 1);
    await click(button('Close assignment')); await click(button('Edit Recovery position'));
    await fill('Manager note', 'My reviewed draft');
    const before = await rpc('getScheduleAssignment', { id });
    assert.equal((await edit(before.snapshot, 'Newer remote note')).outcome, 'applied');
    await click(button('Save assignment'));
    await check("document.querySelector('[role=dialog]').textContent.includes('Newer remote note')", 'stale edit conflict visible');
    assert.equal(await evaluate(`(${field('Manager note')}).value`), 'My reviewed draft');
    for (const [width,height] of [[320,480],[768,1024],[1440,1000]]) {
      await page('Emulation.setDeviceMetricsOverride', { width,height,deviceScaleFactor:1,mobile:false });
      const layout = await check(`(async()=>{await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const n=${button('Review latest details')};if(!n)return null;n.scrollIntoView({block:'center'});const b=n.getBoundingClientRect(),d=document.querySelector('[role=dialog]').getBoundingClientRect();if(b.top<0||b.bottom>innerHeight||d.left<0||d.right>innerWidth||d.bottom>innerHeight)return null;return {height:b.height,dialogWidth:d.width}})()`, 'reachable review at '+width);
      assert.ok(layout.height>=44);
      await writeFile(`/tmp/showpilot-assignment-${width}.png`, Buffer.from((await page('Page.captureScreenshot',{format:'png'})).data,'base64'));
    }
    await click(button('Review latest details')); await click(button('Save assignment'));
    await check("document.querySelector('[role=dialog]').textContent.includes('Assignment saved.')", 'explicit reviewed save');
    assert.equal((await rpc('getScheduleAssignment',{id})).snapshot.notes, 'My reviewed draft');
    await click(button('Close assignment')); await click(button('Remove Recovery position'));
    await check(`!!${button('Remove assignment')}`, 'review deletion');
    const beforeDelete = await rpc('getScheduleAssignment',{id}); await edit(beforeDelete.snapshot, 'Changed before removal');
    await click(button('Remove assignment'));
    await check("document.querySelector('[role=dialog]').textContent.includes('Changed before removal')", 'stale deletion refused');
    assert.ok((await rpc('getScheduleAssignment',{id})).snapshot);
    await click(button('Review latest details')); await click(button('Remove assignment'));
    await check("!document.querySelector('[role=dialog]')", 'deleted row disappears after refresh');
    assert.equal((await rpc('getScheduleAssignment',{id})).snapshot,null);
    await click(button('Build a team')); await fill('Team or category name','Recovery team');
    await fill('Position 1','Fixture Audio'); await click(button('Add another person')); await fill('Position 2','Fixture Camera');
    await evaluate("assignmentMode='fail-camera'"); await click(button('Add team & send invitations'));
    await check("document.querySelector('[role=dialog]').textContent.includes('Save not confirmed')", 'partial team failure visible');
    const partial = await calls();
    await evaluate("assignmentMode='pass'"); await click(button('Retry unconfirmed saves or invitations'));
    await check("!!"+button('Add more positions'), 'remaining team position saved');
    const final = await calls(); assert.equal(final.length,partial.length+1); assert.deepEqual(final.at(-1),partial.at(-1));
    const team = await queryFixture("SELECT role FROM service_assignment WHERE orgId='display-smoke' AND department='Recovery team' ORDER BY role");
    assert.deepEqual(team.map(row=>row.role),['Fixture Audio','Fixture Camera']);
    assert.equal((await capturedEmails()).length,1);
    assert.equal(await evaluate('assignmentDocument'),'same'); assert.deepEqual(await evaluate('assignmentErrors'),[]);
    console.log(JSON.stringify({ createRecoveredWithoutDuplicate:true, invitationNotRepeated:true, draftSurvivesNavigation:true, staleEditReviewed:true, staleDeleteReviewed:true, partialTeamRetry:true, viewports:[320,768,1440], capturedEmails:1, errors:[] }));
  });
}, { personalAssignments:true,captureEmail:true });
