// Production build, real Worker/D1/auth, and response faults in disposable Chrome.
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { withLocalSmokeFixture } from './local-smoke-fixture.mjs';
import { poll, withRealBrowser } from './real-browser-fixture.mjs';

const assets = resolve(import.meta.dirname, '../dist/server/assets');
let settingsId;
for (const file of (await readdir(assets)).filter(file => file.startsWith('settings-') && file.endsWith('.js'))) {
  const source = await readFile(resolve(assets, file), 'utf8');
  settingsId ??= source.match(/const getOrgSettings_createServerFn_handler = createServerRpc\(\{\s*id: "([^"]+)"/)?.[1];
}
assert.ok(settingsId, 'Resolve the real settings endpoint from this build');
const captureErrors = `window.routeErrors = [];
  addEventListener('error', event => window.routeErrors.push(event.message));
  addEventListener('unhandledrejection', event => window.routeErrors.push(String(event.reason)));`;

await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie }) => {
  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    const click = text => evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(node => node.textContent.trim() === ${JSON.stringify(text)}); if (!button || button.disabled) throw new Error('Button unavailable'); button.click(); return true; })()`);
    const navigate = path => evaluate(`(() => { const link = document.querySelector('a[href="/${orgId}/${path}"]'); if (!link) throw new Error('Navigation link unavailable'); link.click(); return true; })()`);
    const errorReady = () => poll(() => evaluate(`!!document.querySelector('.route-recovery time') && [...document.querySelectorAll('button')].some(node => node.textContent.trim() === 'Try again' && !node.disabled)`), 'bounded route error and Retry', 20_000);
    const release = () => evaluate(`window.holdSettings = false; Promise.all(window.heldReads.splice(0).map(read => read.release())).then(() => true)`);
    await page('Page.enable');
    await page('Page.addScriptToEvaluateOnNewDocument', { source: captureErrors });
    await page('Page.navigate', { url: `${origin}/${orgId}/rundown` });
    await poll(() => evaluate(`(() => { const link = document.querySelector('a[href="/${orgId}/timecode"]'); const key = link && Object.keys(link).find(key => key.startsWith('__reactProps$')); return !!document.querySelector('.rundown-page') && typeof link?.[key]?.onClick === 'function'; })()`), 'authenticated initial route hydrated');
    assert.deepEqual(await evaluate('window.routeErrors'), [], 'capture initial hydration errors');
    await evaluate(`(() => {
      window.routeDocument = 'same-document';
      const original = window.fetch; window.heldReads = []; window.readSignals = [];
      window.fetch = (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (window.holdSettings && url.includes('/_serverFn/${settingsId}')) {
          const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
          window.readSignals.push(signal);
          // Buffer a real response with independent transport cancellation, so
          // releasing it later exercises the app's stale-result handling.
          const response = original(input, { ...init, signal: new AbortController().signal }).then(async response =>
            new Response(await response.arrayBuffer(), { status: response.status, statusText: response.statusText, headers: response.headers }));
          return new Promise(resolve => window.heldReads.push({ release: async () => resolve(await response) }));
        }
        return original(input, init);
      }; return true;
    })()`);
    for (const path of ['timecode', 'board']) {
      await evaluate('window.holdSettings = true; window.readSignals = []');
      await navigate(path);
      await poll(() => evaluate('window.heldReads.length > 0'), `${path} first-load settings held`);
      await errorReady();
      assert.equal(await evaluate('window.readSignals.some(signal => signal?.aborted)'), true);
      assert.equal(await evaluate('window.routeDocument'), 'same-document');
      if (path === 'timecode') {
        await page('Emulation.setDeviceMetricsOverride', { width: 320, height: 480, deviceScaleFactor: 1, mobile: false });
        await poll(() => evaluate(`!!document.querySelector('button[aria-label="Open menu"]')`), 'mobile layout committed');
        // CDP acknowledges the viewport change before responsive layout and hit
        // testing settle. Measure after paint, then allow scrolling to settle.
        const bounds = await evaluate(`(async () => {
          const painted = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          await painted();
          const button = [...document.querySelectorAll('button')].find(node => node.textContent.trim() === 'Try again');
          button.scrollIntoView({ block: 'center', behavior: 'instant' });
          await painted();
          const r = button.getBoundingClientRect();
          const x = r.x + r.width/2, y = r.y + r.height/2;
          return { left: r.left, right: r.right, height: r.height, x, y, reachable: button.contains(document.elementFromPoint(x, y)) };
        })()`);
        assert.ok(bounds.left >= 0 && bounds.right <= 320 && bounds.height >= 44 && bounds.reachable, JSON.stringify(bounds));
        const screenshot = await page('Page.captureScreenshot', { format: 'png' });
        await writeFile('/tmp/showpilot-route-timeout-320.png', Buffer.from(screenshot.data, 'base64'));
        // Use a real pointer at the small viewport, not DOM click(), which can
        // activate an obscured control. Retry must finish with the read stuck.
        await page('Input.dispatchMouseEvent', { type: 'mousePressed', x: bounds.x, y: bounds.y, button: 'left', clickCount: 1 });
        await page('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bounds.x, y: bounds.y, button: 'left', clickCount: 1 });
        await poll(() => evaluate('window.heldReads.length >= 2'), 'second attempt held');
        await errorReady();
        // The phone Retry coordinates land on Crew status after widening. Park
        // the pointer first so intent preloading cannot bypass the next fault.
        await page('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
        await page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await poll(() => evaluate(`!document.querySelector('button[aria-label="Open menu"]')`), 'desktop layout committed');
      }
      await release();
      assert.equal(await evaluate(`!!document.querySelector('.route-recovery')`), true, 'late response must not dismiss the failed route');
      await click('Try again');
      await poll(() => evaluate(path === 'timecode'
        ? `!![...document.querySelectorAll('h1')].find(node => node.textContent.trim() === 'SMPTE Timecode')`
        : `!!document.querySelector('button[aria-label="Enter fullscreen"]')`), `${path} recovers without reload`);
      console.log(`${path}: timeout, late response and retry passed`);
      if (path === 'board') {
        await navigate('show');
        await poll(() => evaluate(`!!document.querySelector('a[href="/${orgId}/rundown"]')`), 'workspace navigation restored');
      }
    }
    await evaluate('window.holdSettings = true');
    await navigate('chat');
    await poll(() => evaluate('window.heldReads.length > 0'), 'pending chat navigation');
    await navigate('rundown');
    await poll(() => evaluate(`!!document.querySelector('.rundown-page')`), 'navigate away while chat is loading');
    await release();
    assert.equal(await evaluate('location.pathname'), `/${orgId}/rundown`);
    assert.equal(await evaluate(`!!document.querySelector('.rundown-page')`), true);
    assert.equal(await evaluate('window.routeDocument'), 'same-document');
    assert.deepEqual(await evaluate('window.routeErrors'), []);
    console.log('Cancelled navigation ignores late chat response; no page errors');
  });

  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    await page('Page.enable');
    await page('Page.addScriptToEvaluateOnNewDocument', { source: captureErrors });
    await page('Page.navigate', { url: `${origin}/${orgId}/rundown` });
    await poll(() => evaluate(`(() => { const link = document.querySelector('a[href="/${orgId}/board"]'); const key = link && Object.keys(link).find(key => key.startsWith('__reactProps$')); return !!document.querySelector('.rundown-page') && typeof link?.[key]?.onClick === 'function'; })()`), 'fresh browser initial route hydrated');
    assert.deepEqual(await evaluate('window.routeErrors'), [], 'capture initial hydration errors');
    // Leave matching Chrome requests paused until Fetch.disable. No fake page
    // module or error response: this is a real page download that never finishes.
    await page('Fetch.enable', { patterns: [{ urlPattern: '*/assets/board-*.js', requestStage: 'Request' }] });
    await evaluate(`document.querySelector('a[href="/${orgId}/board"]').click(); true`);
    await poll(() => evaluate(`!!document.querySelector('.route-recovery time')`), 'stalled page download shows recovery', 20_000);
    assert.equal(await evaluate('location.pathname'), `/${orgId}/board`);
    await page('Fetch.disable');
    await evaluate(`document.querySelector('.route-recovery button').click(); true`);
    await poll(() => evaluate(`!!document.querySelector('button[aria-label="Enter fullscreen"]')`), 'page download recovers on Retry');
    assert.deepEqual(await evaluate('window.routeErrors'), []);
    console.log('Real paused page download times out and recovers on Retry');
  });
  console.log(JSON.stringify({ passed: true, firstLoad: ['board', 'timecode'], lateResponsesIgnored: true, repeatedTimeoutRetry: true, cancelledNavigation: true, realChunkTimeout: true, retryReachableAt320: true }));
});
