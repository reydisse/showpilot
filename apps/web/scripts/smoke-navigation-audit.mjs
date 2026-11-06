import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { withLocalSmokeFixture } from './local-smoke-fixture.mjs';
import { poll, withRealBrowser } from './real-browser-fixture.mjs';

await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie }) => {
  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    await page('Page.enable');
    await page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page('Page.navigate', { url: `${origin}/${orgId}/show` });
    const hydrated = selector => evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); return node && Object.keys(node).some(key => key.startsWith('__reactProps$') && typeof node[key]?.onClick === 'function'); })()`);
    await poll(() => hydrated(`aside a[href="/${orgId}/schedule"]`), 'sidebar hydration');
    await evaluate(`window.navigationDocument = 'same'; window.navigationErrors = []; addEventListener('error', e => window.navigationErrors.push(e.message)); addEventListener('unhandledrejection', e => window.navigationErrors.push(String(e.reason))); true`);
    const links = await evaluate(`[...document.querySelectorAll('aside a[title]')].filter(node => node.pathname.startsWith('/${orgId}/')).map(node => ({ path:node.pathname, label:node.title }))`);
    assert.equal(links.length, 21);
    const headings = { schedule:'Schedule', board:'ShowPilot', rundown:'Display test show', timecode:'SMPTE Timecode', songs:'Songs', team:'Team', 'production/cue-sheets':'Cue sheet', 'production/checklist':'Pre-Show Checklist', checkin:'Check-In', 'production/incidents':'Incident Log', 'production/assets':'Asset Inventory', 'streaming/health':'Stream', 'streaming/platforms':'Multi-Platform', 'streaming/graphics':'Lower Thirds', 'dashboard/prod-manager':'Production Manager', reports:'Reports & notes', 'dashboard/tech-manager':'Technical Control', 'dashboard/audio':'Audio', 'dashboard/devices':'Devices', show:'Show Flow' };
    for (const link of [...links.slice(1), links[0]]) {
      const selector = `aside a[href="${link.path}"]`;
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
      const expected = headings[link.path.slice(orgId.length + 2)];
      await poll(() => evaluate(`location.pathname === ${JSON.stringify(link.path)} && ${expected ? `[...document.querySelectorAll('h1')].some(node => node.textContent.trim() === ${JSON.stringify(expected)})` : `document.querySelector('main')?.textContent.includes('Production Chat')`}`), `${link.label} page renders`);
      assert.equal(await evaluate('window.navigationDocument'), 'same', `${link.label} reloaded`);
      if (link.path.endsWith('/schedule')) {
        assert.equal(await evaluate(`!!document.querySelector('button[aria-label="Next month"]') && !document.querySelector('.show-page-root') && !document.querySelector('#rundown-runsheet')`), true, 'Schedule renders its calendar instead of Show Flow');
      }
      if (link.path.endsWith('/rundown')) {
        assert.equal(await evaluate(`!!document.querySelector('#rundown-runsheet') && !document.querySelector('.show-page-root') && !document.querySelector('button[aria-label="Next month"]')`), true, 'Rundown renders its standalone editor');
      }
      if (link.path.endsWith('/show')) assert.equal(await evaluate(`!!document.querySelector('.show-page-root')`), true);
      console.log(JSON.stringify({ route: link.path, headings: await evaluate(`[...document.querySelectorAll('h1, h2')].map(node => node.textContent.trim())`) }));
      if (['board','checkin'].includes(link.path.split('/').at(-1))) {
        await evaluate('history.back(); true');
        await poll(() => hydrated('aside a[title="Schedule"]'), 'return from standalone view');
      }
    }
    // Entry through a real application Link, not Page.navigate.
    await evaluate(`document.querySelector('aside button[title="Account menu"]').click(); true`);
    await poll(() => hydrated(`a[href="/${orgId}/settings"]`), 'Settings link hydration');
    await evaluate(`document.querySelector('a[href="/${orgId}/settings"]').click(); true`);
    await poll(() => evaluate(`!!document.querySelector('nav[aria-label="Settings sections"]')`), 'Settings loaded');
    const sections = await evaluate(`[...document.querySelectorAll('nav[aria-label="Settings sections"] button')].map(node => node.textContent.trim())`);
    assert.equal(sections.length, 13);
    for (const section of sections) {
      await evaluate(`([...document.querySelectorAll('nav[aria-label="Settings sections"] button')].find(node => node.textContent.trim() === ${JSON.stringify(section)})).click(); true`);
      await poll(() => evaluate(`document.querySelector('nav[aria-label="Settings sections"] [aria-current="page"]')?.textContent.trim() === ${JSON.stringify(section)} && [...document.querySelectorAll('main h1')].some(node => node.textContent.trim() === ${JSON.stringify(section)})`), `${section} selected`);
      console.log(JSON.stringify({ section, headings: await evaluate(`[...document.querySelectorAll('h1')].map(node => node.textContent.trim())`) }));
      assert.equal(await evaluate('window.navigationDocument'), 'same');
    }
    assert.deepEqual(await evaluate('window.navigationErrors'), []);
    assert.equal(await evaluate(`!!document.querySelector('aside a[title="Schedule"]')`), true, 'Settings keeps the workspace sidebar available');
    const button = name => `[...document.querySelectorAll('button')].find(node => node.textContent.trim() === ${JSON.stringify(name)} && node.getBoundingClientRect().width > 0)`;
    const enterSettings = async () => {
      await evaluate(`document.querySelector('aside button[title="Account menu"]').click(); true`);
      await poll(() => hydrated(`a[href="/${orgId}/settings"]`), 'account Settings link');
      await evaluate(`document.querySelector('a[href="/${orgId}/settings"]').click(); true`);
      await poll(() => evaluate(`location.pathname === '/${orgId}/settings' && !!document.querySelector('main h1') && document.querySelector('main').textContent.includes('Workspace')`), 'Settings entered');
    };
    await evaluate(`document.querySelector('aside a[title="Chat"]').click(); true`);
    await poll(() => evaluate(`!!document.querySelector('select[aria-label="Switch chat room"]')`), 'Chat loaded');
    await evaluate(`const select = document.querySelector('select[aria-label="Switch chat room"]'); select.value = 'planning'; select.dispatchEvent(new Event('change', { bubbles:true })); true`);
    await poll(() => evaluate(`location.search.includes('room=planning') && document.querySelector('select[aria-label="Switch chat room"]').value === 'planning' && document.querySelector('main').textContent.includes('Seven-day planning history')`), 'Planning Room changes with the URL');
    const previous = await evaluate('location.pathname + location.search + location.hash');
    await enterSettings();
    await evaluate(`(${button('Integrations')}).click(); true`);
    await poll(() => evaluate(`location.search.includes('section=integrations') && [...document.querySelectorAll('main h1')].some(node => node.textContent === 'Integrations')`), 'second section');
    await evaluate(`(${button('Back to previous page')}).click(); true`);
    await poll(() => evaluate(`location.pathname + location.search + location.hash === ${JSON.stringify(previous)} && document.querySelector('select[aria-label="Switch chat room"]')?.value === 'planning'`), 'Back restores the page and its selected room');
    assert.equal(await evaluate('window.navigationDocument'), 'same');
    await enterSettings();
    for (const width of [1024, 768, 320]) {
      await page('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      if (width < 1024) await poll(() => evaluate(`!!document.querySelector('button[aria-label="Open menu"]')`), 'mobile navigation');
      for (const section of sections) {
        if (width >= 1024) {
          await evaluate(`(${button(section)}).click(); true`);
        } else {
          const trigger = await evaluate(`(() => { const node = document.querySelector('[aria-label="Settings section"]'); node.scrollIntoView({block:'center'}); const r=node.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
          await page('Input.dispatchMouseEvent', { type:'mousePressed',button:'left',clickCount:1,...trigger });
          await page('Input.dispatchMouseEvent', { type:'mouseReleased',button:'left',clickCount:1,...trigger });
          await poll(() => evaluate(`!!document.querySelector('[role="option"]')`), 'section options');
          await evaluate(`([...document.querySelectorAll('[role="option"]')].find(node => node.textContent.trim() === ${JSON.stringify(section)})).click(); true`);
        }
        await poll(() => evaluate(`[...document.querySelectorAll('main h1')].some(node => node.textContent.trim() === ${JSON.stringify(section)}) && !document.querySelector('[role="listbox"]')`), `${width}px ${section} renders`);
        assert.equal(await evaluate('window.navigationDocument'), 'same');
      }
      const bounds = await evaluate(`(() => { const node = ${button('Back to previous page')}; node.scrollIntoView({block:'center'}); const r=node.getBoundingClientRect(); return {height:r.height,left:r.left,right:r.right,reachable:node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),fits:document.documentElement.scrollWidth<=innerWidth}; })()`);
      assert.ok(bounds.height>=44 && bounds.left>=0 && bounds.right<=width && bounds.reachable && bounds.fits, JSON.stringify({width,bounds}));
      if (width === 320) {
        const screenshot = await page('Page.captureScreenshot', {format:'png'});
        await writeFile('/tmp/showpilot-settings-navigation-320.png',Buffer.from(screenshot.data,'base64'));
        await evaluate(`document.querySelector('button[aria-label="Open menu"]').click(); true`);
        await poll(() => evaluate(`!!document.querySelector('aside[aria-hidden="false"]')`), 'workspace drawer opens within Settings');
        await evaluate(`document.querySelector('aside[aria-hidden="false"] a[title="Schedule"]').click(); true`);
        await poll(() => evaluate(`location.pathname === '/${orgId}/schedule' && [...document.querySelectorAll('h1')].some(node => node.textContent === 'Schedule') && !document.querySelector('aside[aria-hidden="false"]')`), 'mobile sidebar leaves Settings and closes');
      }
    }
    assert.deepEqual(await evaluate('window.navigationErrors'), []);
    // Direct links have no preceding in-app page, so offer the explicit home fallback.
    await page('Page.navigate', {url:`${origin}/${orgId}/settings?section=organization`});
    await poll(() => evaluate(`!!(${button('Back to Show Flow')})`), 'direct Settings entry fallback');
    await poll(() => hydrated('main button'), 'direct Settings hydration');
    await evaluate(`window.navigationDocument = 'direct'; (${button('Back to Show Flow')}).click(); true`);
    await poll(() => evaluate(`location.pathname === '/${orgId}/show' && document.querySelector('main h1')?.textContent === 'Show Flow'`), 'fallback renders Show Flow');
    assert.equal(await evaluate('window.navigationDocument'), 'direct');
    console.log(JSON.stringify({ passed:true, routes:links.length, settingsSections:sections.length, widths:[1440,1024,768,320], settingsSidebar:true, backPreservesRoom:true, directEntryFallback:true }));
  });
});
