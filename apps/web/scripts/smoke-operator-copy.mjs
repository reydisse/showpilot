// Review operator copy in the compiled app, including accessible names and
// actual pointer/keyboard interaction. Only disposable local org data is used.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { withLocalSmokeFixture } from './local-smoke-fixture.mjs';
import { poll, withRealBrowser } from './real-browser-fixture.mjs';

await withLocalSmokeFixture(async ({ origin, orgId, date, operatorCookie }) => {
  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    await page('Page.enable');
    await page('Page.bringToFront');
    await page('Emulation.setFocusEmulationEnabled', { enabled: true });
    await page('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.copyErrors=[];
      addEventListener('error',event=>window.copyErrors.push(event.message));
      addEventListener('unhandledrejection',event=>window.copyErrors.push(String(event.reason)));
    ` });
    const check = async (expression, label) => {
      try { return await poll(() => evaluate(expression), label); }
      catch (error) {
        console.log(JSON.stringify({failed:label,ui:await evaluate(`({url:location.pathname,focus:document.activeElement?.outerHTML.slice(0,500),text:document.body.innerText,errors:window.copyErrors})`)}));
        throw error;
      }
    };
    const button = name => `[...document.querySelectorAll('button')].find(n=>(n.textContent.trim()===${JSON.stringify(name)}||n.getAttribute('aria-label')===${JSON.stringify(name)})&&n.getBoundingClientRect().width>0)`;
    const width = async value => {
      await page('Emulation.setDeviceMetricsOverride', { width: value, height: 900, deviceScaleFactor: 1, mobile: false });
    };
    const navigate = async (path, heading) => {
      await page('Page.navigate', { url: `${origin}/${orgId}/${path}` });
      await check(heading ? `[...document.querySelectorAll('h1')].some(n=>n.textContent.trim()===${JSON.stringify(heading)})` : `document.querySelector('select[aria-label="Switch chat room"]')?.value==='planning'`, `${path} rendered`);
      await check(`Object.keys(document.querySelector('aside a')??{}).some(k=>k.startsWith('__reactProps'))||Object.keys(document.querySelector('button[aria-label="Open menu"]')??{}).some(k=>k.startsWith('__reactProps'))`, 'hydrated operator UI');
      console.log(JSON.stringify({ path, rendered: true }));
    };
    const click = async expression => {
      let point;
      await poll(async () => {
        point = await evaluate(`(async()=>{const n=${expression};if(!n||n.disabled)return null;n.scrollIntoView({block:'center',inline:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`);
        return point;
      }, 'pointer target reachable');
      await page('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount:1,...point});
      await page('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount:1,...point});
    };
    const key = async (key, code = key) => {
      await page('Input.dispatchKeyEvent', {type:'keyDown',key,code});
      await page('Input.dispatchKeyEvent', {type:'keyUp',key,code});
    };
    const screenshot = async name => writeFile(`/tmp/showpilot-copy-${name}.png`, Buffer.from((await page('Page.captureScreenshot',{format:'png'})).data,'base64'));
    const noErrors = async () => assert.deepEqual(await evaluate('window.copyErrors'), []);

    await width(1440);
    await navigate('show', 'Show Flow');
    await check(`!!(${button('Layout: Default')})`, 'layout has an explicit purpose');
    const owner = await evaluate(`(()=>{const n=[...document.querySelectorAll('aside p')].find(n=>n.textContent==='Owner');return {color:getComputedStyle(n).color,theme:getComputedStyle(n).getPropertyValue('--board-text').trim()};})()`);
    assert.notEqual(owner.color, 'rgb(220, 38, 38)', 'Owner must not use error red');
    assert.equal(await evaluate(`document.querySelector('.show-page-header').textContent.includes('Native')`), false);
    for (const viewport of [1440,768]) {
      await width(viewport);
      await click(button('Layout: Default'));
      await check(`document.querySelectorAll('[role="menuitemradio"]').length===4`, 'four explained panel layouts');
      const menu = await evaluate(`(()=>{const n=document.querySelector('[role="menu"]'),b=n.getBoundingClientRect();return {left:b.left,right:b.right,text:n.textContent,heights:[...n.querySelectorAll('[role="menuitemradio"]')].map(n=>n.getBoundingClientRect().height)};})()`);
      assert.ok(menu.left>=0&&menu.right<=viewport&&menu.heights.every(h=>h>=44), JSON.stringify(menu));
      assert.match(menu.text, /More space for the timer/);
      await key('Escape');
      await check(`!document.querySelector('[role="menu"]')`, 'Escape closes layout menu');
    }
    // Select and persist a layout with the keyboard, using the real menu.
    await evaluate(`(${button('Layout: Default')}).focus();true`);
    await key('ArrowDown');
    await check(`document.activeElement?.getAttribute('role')==='menuitemradio'`, 'keyboard enters layout choices');
    await key('Home');
    await check(`document.activeElement?.textContent.includes('Timer, chat and rundown together')`, 'Home focuses first layout');
    await key('ArrowDown');
    await check(`document.activeElement?.textContent.includes('More space for the timer')`, 'ArrowDown focuses timer layout');
    await key('Enter');
    await check(`!!(${button('Layout: Timer focus')})&&localStorage.getItem('show-page-layout-preset')==='show-focus'`, 'keyboard selection retains existing stored layout ID');
    await navigate('show', 'Show Flow');
    await check(`!!(${button('Layout: Timer focus')})`, 'layout restored after reload');
    await screenshot('layout-768');
    await noErrors();

    await width(1440);
    await navigate('reports', 'Reports & notes');
    await check(`document.body.textContent.includes('1 report')&&document.querySelector('th:nth-child(3)')?.textContent==='Elapsed time'`, 'report count and duration label');
    const expectedDate = new Date(`${date}T12:00:00`).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
    assert.equal(await evaluate(`document.querySelector('tbody td')?.textContent.trim()`), expectedDate);
    await click(`document.querySelector('tbody button[aria-label^="Open report:"]')`);
    await check(`!!(${button('Production Manager note')})&&!!(${button('Technical Manager note')})`, 'manager names spelled out');
    for (const viewport of [1440,768,320]) {
      await width(viewport);
      for (const name of ['Technical Manager note','Production Manager note']) {
        await click(button(name));
        await check(`(${button(name)}).getAttribute('aria-pressed')==='true'`, 'selected note role announced');
        const bounds = await evaluate(`(()=>{const n=${button(name)},b=n.getBoundingClientRect();return {height:b.height,left:b.left,right:b.right,wraps:n.scrollWidth<=n.clientWidth};})()`);
        assert.ok(bounds.height>=44&&bounds.left>=0&&bounds.right<=viewport&&bounds.wraps, JSON.stringify(bounds));
      }
      if (viewport===320) await screenshot('manager-notes-320');
    }
    await noErrors();

    await width(1440);
    const command = async (action,payload) => {
      const response = await fetch(`${origin}/api/rundown/${orgId}/command?showId=smoke-show&serviceDate=${date}`, {
        method:'POST', headers:{Cookie:operatorCookie,Origin:origin,'Content-Type':'application/json'},
        body:JSON.stringify({action,payload}),
      });
      assert.equal(response.status,200);
      assert.equal((await response.json()).ok,true);
    };
    await command('update-meta',{scheduledStartTime:new Date(Date.now()-2*60*60*1000).toISOString()});
    await command('add-item',{id:'copy-timing-item',title:'Timing label rehearsal',type:'segment',duration:180000,notes:'',assignee:'',cue:'',hardStop:false});
    await command('timer-start',{itemId:'copy-timing-item'});
    await command('timer-stop');
    await navigate('dashboard/prod-manager', 'Production Manager');
    await check(`document.body.textContent.includes('Debrief')&&document.body.textContent.includes('Planned duration')&&document.body.textContent.includes('Elapsed time')&&document.body.textContent.includes('Over / under')`, 'debrief timing labels explain their values');
    for (const viewport of [1440,1024,768,320]) {
      await width(viewport);
      await click(button('Choose show'));
      await check(`!!document.querySelector('[role="menuitem"]')`, 'show menu opened');
      await check(`getComputedStyle(document.querySelector('[role="menu"]')).opacity==='1'`, 'show menu opening animation completed');
      const bounds = await evaluate(`(()=>{const n=document.querySelector('[role="menu"]'),b=n.getBoundingClientRect(),item=n.querySelector('[role="menuitem"]'),r=item.getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,reachable:item.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};})()`);
      assert.ok(bounds.left>=0&&bounds.right<=viewport&&bounds.top>=0&&bounds.bottom<=900&&bounds.reachable, JSON.stringify(bounds));
      if (viewport===320) await screenshot('show-menu-320');
      await key('Escape');
      await check(`!document.querySelector('[role="menu"]')`, 'show menu closed');
    }
    await noErrors();

    await width(1440);
    await navigate('streaming/health', 'Stream');
    assert.match(await evaluate('document.body.textContent'), /Go to Multi-Platform to/);
    await noErrors();
    await navigate('streaming/platforms', 'Multi-Platform');
    assert.match(await evaluate('document.body.textContent'), /0 destinations/);
    await noErrors();
    await navigate('settings?section=integrations', 'Integrations');
    assert.match(await evaluate('document.body.textContent'), /External gateway:\s+None/);
    await noErrors();
    await navigate('settings?section=production', 'Production Defaults');
    const ax = await page('Accessibility.getFullAXTree');
    const spins = ax.nodes.filter(n=>!n.ignored&&n.role?.value==='spinbutton').map(n=>n.name?.value);
    assert.ok(spins.length>=2&&spins.every(name=>typeof name==='string'&&/[A-Za-z]/.test(name)), JSON.stringify(spins));
    await noErrors();
    await navigate('chat?room=planning');
    assert.doesNotMatch(await evaluate('document.body.innerText'), /\b7 DAYS\b/);
    await noErrors();
    console.log(JSON.stringify({passed:true,widths:[1440,1024,768,320],layoutKeyboardAndPersistence:true,managerLabelsAndTargets:true,showMenuNotClipped:true,reportDate:expectedDate,spacing:true,spinbuttonNames:spins,ownerColor:owner.color}));
  });
});
