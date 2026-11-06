// Real built Worker, D1, settings links and operator writes. Only disposable data.
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { withLocalSmokeFixture } from './local-smoke-fixture.mjs';
import { poll, withRealBrowser } from './real-browser-fixture.mjs';
const assets = resolve(import.meta.dirname, '../dist/server/assets');
let linkId;
for (const file of (await readdir(assets)).filter(file => file.endsWith('.js'))) {
  const source = await readFile(resolve(assets, file), 'utf8');
  linkId ??= source.match(/const createDisplayLink_createServerFn_handler = createServerRpc\(\{\s*id: "([^"]+)"/)?.[1];
}
assert.ok(linkId);
const capture = `window.outputErrors = []; addEventListener('error', e => window.outputErrors.push(e.message)); addEventListener('unhandledrejection', e => window.outputErrors.push(String(e.reason)));`;
await withLocalSmokeFixture(async ({ origin, orgId, browser, operatorCookie, operatorEmail, operatorPassword, queryFixture, stopServer, startServer }) => {
  const clickOperator = name => browser('find', 'role', 'button', 'click', '--name', name, '--exact');
  await browser('open', `${origin}/login`); await browser('fill', '#email', operatorEmail); await browser('fill', '#password', operatorPassword); await clickOperator('Sign in');
  await browser('wait', '--url', `**/${orgId}/**`);
  await browser('open', `${origin}/${orgId}/streaming/graphics`);
  await browser('wait', 'button[aria-label="Hide Fixture overlay title"]:not(:disabled)');
  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    await page('Page.enable');
    const script = await page('Page.addScriptToEvaluateOnNewDocument', { source: `${capture}
      window.holdLink = true; window.heldLinks = [];
      const original = window.fetch;
      window.fetch = (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (window.holdLink && url.includes('/_serverFn/${linkId}')) {
          const response = original(input, { ...init, signal: new AbortController().signal }).then(async response => new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers }));
          return new Promise(resolve => window.heldLinks.push(async () => resolve(await response)));
        }
        return original(input, init);
      };` });
    await page('Page.navigate', { url: `${origin}/${orgId}/settings?section=lowerthirds` });
    await poll(() => evaluate(`document.body?.textContent.includes('Could not create a display link')`), 'display-link creation times out', 20_000);
    assert.equal(await evaluate(`document.body.textContent.includes('Creating display link…')`), false);
    await evaluate('window.holdLink = false; Promise.all(window.heldLinks.splice(0).map(release => release())).then(() => true)');
    assert.equal(await evaluate(`!![...document.querySelectorAll('a')].find(node => node.textContent === 'Open overlay monitor')`), false, 'late link cannot replace failed creation');
    await evaluate(`([...document.querySelectorAll('button')].find(node => node.textContent === 'Create a fresh link')).click(); true`);
    const monitorUrl = await poll(() => evaluate(`([...document.querySelectorAll('a')].find(node => node.textContent === 'Open overlay monitor'))?.href`), 'Retry creates a monitor link');
    const cleanUrl = new URL(monitorUrl); cleanUrl.searchParams.delete('monitor');
    assert.equal(await evaluate(`!![...document.querySelectorAll('code')].find(node => node.textContent === ${JSON.stringify(cleanUrl.href)})`), true, 'copy field retains a clean broadcast URL');
    assert.deepEqual(await evaluate('window.outputErrors'), []);
    await page('Page.removeScriptToEvaluateOnNewDocument', { identifier: script.identifier });
    await page('Page.addScriptToEvaluateOnNewDocument', { source: capture });
    await page('Page.navigate', { url: monitorUrl });
    const graphic = `document.querySelector('[data-overlay-graphic="smoke-graphic"]')`;
    await poll(() => evaluate(`${graphic}?.textContent.includes('Fixture overlay title') && ${graphic}?.firstElementChild?.style.opacity === '1'`), 'published settings link renders the active graphic');
    await evaluate(`window.originalGraphic = ${graphic}; window.outputDocument = 'same'; window.remounted = false;
      new MutationObserver(() => { if (${graphic} !== window.originalGraphic) window.remounted = true; }).observe(document.querySelector('.overlay-container'), { childList: true, subtree: true });
      const original = window.fetch; window.holdNext = true; window.outputReads = 0; window.held = []; window.readSignals = [];
      window.fetch = (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes('/api/overlay/')) {
          window.outputReads++;
          if (window.holdNext) {
            window.holdNext = false; window.readSignals.push(init?.signal);
            const response = original(input, { ...init, signal: new AbortController().signal }).then(async response => new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers }));
            return new Promise(resolve => window.held.push(async () => resolve(await response)));
          }
        }
        return original(input, init);
      }; true`);
    await poll(() => evaluate('window.held.length === 1'), 'old overlay reply held');
    await clickOperator('Edit Fixture overlay title'); await browser('fill', '#graphic-title', 'New confirmed graphic'); await clickOperator('Update'); await clickOperator('Update graphic');
    await browser('wait', 'button[aria-label="Hide New confirmed graphic"]:not(:disabled)');
    await poll(() => evaluate(`!!document.querySelector('[aria-label="Overlay connection"] time')`), 'monitor shows the read deadline', 12_000);
    assert.equal(await evaluate('window.outputReads'), 1, 'no overlapping request while the old reply is stalled');
    assert.equal(await evaluate('window.readSignals[0].aborted'), true);
    await evaluate(`([...document.querySelectorAll('button')].find(node => node.textContent === 'Retry overlay')).click(); true`);
    await poll(() => evaluate(`${graphic}?.textContent.includes('New confirmed graphic')`), 'Retry reads the newer committed graphic');
    await evaluate('Promise.all(window.held.splice(0).map(release => release())).then(() => true)');
    assert.equal(await evaluate(`${graphic}?.textContent.includes('New confirmed graphic')`), true);
    assert.equal(await evaluate('window.remounted'), false);
    assert.equal(await evaluate(`${graphic}?.firstElementChild?.style.opacity`), '1');
    await stopServer();
    await poll(() => evaluate(`!!document.querySelector('[aria-label="Overlay connection"] time')`), 'real Worker outage is visible');
    assert.equal(await evaluate(`${graphic} === window.originalGraphic`), true);
    for (const [width, height] of [[320,480], [768,900], [1440,900]]) {
      await page('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      const bounds = await evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(node => node.textContent === 'Retry overlay'); const r = button.getBoundingClientRect(); return { left:r.left,right:r.right,height:r.height,top:r.top,bottom:r.bottom,reachable:button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),fits:document.documentElement.scrollWidth<=innerWidth }; })()`);
      assert.ok(bounds.left >= 0 && bounds.right <= width && bounds.height >= 44 && bounds.top >= 0 && bounds.bottom <= height && bounds.reachable && bounds.fits, JSON.stringify({ width, bounds }));
      const preview = await evaluate(`(() => { const r = document.querySelector('.overlay-container').getBoundingClientRect(); const header = document.querySelector('[aria-label="Overlay connection"]').getBoundingClientRect(); return { top:r.top,bottom:r.bottom,height:r.height,headerBottom:header.bottom }; })()`);
      assert.ok(preview.top >= preview.headerBottom && preview.bottom <= height && preview.height >= 180, JSON.stringify({width,preview}));
      if (width === 320) { const shot = await page('Page.captureScreenshot', { format: 'png' }); await writeFile('/tmp/showpilot-overlay-monitor-320.png', Buffer.from(shot.data, 'base64')); }
    }
    await startServer();
    await evaluate(`([...document.querySelectorAll('button')].find(node => node.textContent === 'Retry overlay'))?.click(); true`);
    await poll(() => evaluate(`document.querySelector('.overlay-container')?.dataset.connectionState === 'connected'`), 'output recovers without reloading');
    assert.equal(await evaluate('window.outputDocument'), 'same'); assert.equal(await evaluate('window.remounted'), false);
    assert.deepEqual(await evaluate('window.outputErrors'), []);
    await clickOperator('Hide New confirmed graphic'); await clickOperator('Hide graphic');
    await poll(() => evaluate(`!${graphic}`), 'confirmed Hide finishes its exit animation');
    assert.deepEqual(JSON.parse((await queryFixture(`SELECT value FROM app_setting WHERE orgId='${orgId}' AND key='active-graphics'`))[0].value), []);
    await clickOperator('Show New confirmed graphic'); await clickOperator('Show graphic');
    await page('Page.navigate', { url: cleanUrl.href });
    await poll(() => evaluate(`${graphic}?.textContent.includes('New confirmed graphic')`), 'clean broadcast link still works');
    await stopServer();
    await poll(() => evaluate(`document.querySelector('.overlay-container')?.dataset.connectionState === 'reconnecting'`), 'clean output detects loss');
    assert.equal(await evaluate(`!!document.querySelector('[aria-label="Overlay connection"]')`), false);
    assert.equal(await evaluate('document.body.textContent.includes("Keeping the last confirmed output")'), false);
    assert.equal(await evaluate('document.title.includes("reconnecting")'), true);
    assert.equal(await evaluate(`${graphic}?.textContent.includes('New confirmed graphic')`), true);
    await startServer();
    await poll(() => evaluate(`document.querySelector('.overlay-container')?.dataset.connectionState === 'connected'`), 'clean output automatically recovers');
    assert.deepEqual(await evaluate('window.outputErrors'), []);
  });
  console.log(JSON.stringify({ passed: true, settingsLinkTimeoutAndRetry: true, publishedMonitorReachable: true, singleInFlightRead: true, staleReplyIgnored: true, liveEditWithoutRemount: true, actualWorkerOutage: true, retainedOutput: true, monitorRetryReachable: [320,768,1440], hideFinishes: true, cleanOutputHasNoDiagnostics: true, reconnectWithoutReload: true }));
});
