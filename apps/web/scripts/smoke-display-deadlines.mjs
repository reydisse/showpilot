// Built Worker and real display passes. Network faults delay real responses;
// all accounts, browser profiles and content are disposable local fixtures.
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { withLocalSmokeFixture } from './local-smoke-fixture.mjs';
import { poll, withRealBrowser } from './real-browser-fixture.mjs';

const assets = resolve(import.meta.dirname, '../dist/server/assets');
let accessId;
for (const file of (await readdir(assets)).filter(file => file.endsWith('.js'))) {
  const source = await readFile(resolve(assets, file), 'utf8');
  accessId ??= source.match(/const ensureDisplaySession_createServerFn_handler = createServerRpc\(\{\s*id: "([^"]+)"/)?.[1];
}
assert.ok(accessId, 'Resolve the actual display-session endpoint in this build');
const interception = `
  window.displayErrors = []; window.heldAccess = []; window.accessSignals = []; window.overlayReads = 0;
  addEventListener('error', event => window.displayErrors.push(event.message));
  addEventListener('unhandledrejection', event => window.displayErrors.push(String(event.reason)));
  const originalFetch = window.fetch;
  window.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('/api/overlay/')) window.overlayReads++;
    if (window.holdAccess && url.includes('/_serverFn/${accessId}')) {
      window.accessSignals.push(init?.signal ?? (input instanceof Request ? input.signal : null));
      const response = originalFetch(input, { ...init, signal: new AbortController().signal }).then(async response =>
        new Response(await response.arrayBuffer(), { status: response.status, statusText: response.statusText, headers: response.headers }));
      return new Promise(resolve => window.heldAccess.push(async () => resolve(await response)));
    }
    return originalFetch(input, init);
  };
`;
const hasGraphic = `document.body?.textContent.includes('Fixture overlay title') === true`;

await withLocalSmokeFixture(async ({ origin, orgId, pass, operatorCookie }) => {
  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    await page('Page.enable');
    await page('Page.addScriptToEvaluateOnNewDocument', { source: `${interception}\nwindow.holdAccess = true;` });
    await page('Page.navigate', { url: `${origin}/overlay/${orgId}` });
    await poll(() => evaluate('window.heldAccess?.length === 1'), 'initial display access held');
    await poll(() => evaluate(`!!document.querySelector('[role="alert"]') && !!document.querySelector('time')`), 'stalled access ends with timestamped recovery', 12_000);
    assert.equal(await evaluate(hasGraphic), false);
    assert.equal(await evaluate('window.overlayReads'), 0, 'private display requests cannot start before access confirmation');
    assert.equal(await evaluate('window.accessSignals[0].aborted'), true);
    await page('Emulation.setDeviceMetricsOverride', { width: 320, height: 480, deviceScaleFactor: 1, mobile: false });
    const bounds = await evaluate(`(() => { const button = document.querySelector('button'); const r = button.getBoundingClientRect(); return { left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height,reachable:button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),fits:document.documentElement.scrollWidth<=innerWidth }; })()`);
    assert.ok(bounds.left >= 0 && bounds.right <= 320 && bounds.top >= 0 && bounds.bottom <= 480 && bounds.height >= 44 && bounds.reachable && bounds.fits, JSON.stringify(bounds));
    const screenshot = await page('Page.captureScreenshot', { format: 'png' });
    await writeFile('/tmp/showpilot-display-access-timeout-320.png', Buffer.from(screenshot.data, 'base64'));
    await evaluate('window.holdAccess = false; Promise.all(window.heldAccess.splice(0).map(release => release())).then(() => true)');
    assert.equal(await evaluate(hasGraphic), false, 'late authorization must not dismiss timeout');
    assert.equal(await evaluate('window.overlayReads'), 0);
    await evaluate(`window.displayDocument = 'same'; document.querySelector('button').click(); true`);
    await poll(() => evaluate(hasGraphic), 'Retry restores the actual protected output');
    assert.equal(await evaluate('window.displayDocument'), 'same');
    assert.deepEqual(await evaluate('window.displayErrors'), []);
  });

  // A shared pass has no member session with which to extend its lifetime.
  await withRealBrowser({ origin, cookie: 'fixture-browser=anonymous' }, async ({ page, evaluate }) => {
    await page('Page.enable');
    await page('Page.addScriptToEvaluateOnNewDocument', { source: interception });
    const token = pass('overlay', orgId, false, 35);
    const expiresAt = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp * 1000;
    await page('Page.navigate', { url: `${origin}/overlay/${orgId}?displayPass=${token}` });
    await poll(() => evaluate(hasGraphic), 'shared display pass authorizes fixture output');
    assert.equal(await evaluate('location.search.includes("displayPass")'), false);
    await evaluate('window.holdAccess = true; true');
    await poll(() => evaluate('window.heldAccess.length === 1'), 'renewal response held', 35_000);
    assert.equal(await evaluate(hasGraphic), true, 'valid pass keeps output visible while renewing');
    await poll(async () => !(await evaluate(hasGraphic)), 'output hidden at exact pass expiry', 10_000);
    const hiddenAt = await evaluate('Date.now()');
    assert.ok(hiddenAt >= expiresAt && hiddenAt < expiresAt + 2_000, JSON.stringify({ expiresAt, hiddenAt }));
    await evaluate('Promise.all(window.heldAccess.splice(0).map(release => release())).then(() => true)');
    await poll(() => evaluate(`document.querySelector('[role="alert"]')?.textContent.includes('valid link')`), 'expired renewal response rejected');
    assert.equal(await evaluate(hasGraphic), false);
    assert.deepEqual(await evaluate('window.displayErrors'), []);
  });
  console.log(JSON.stringify({ passed: true, initialDeadline: true, noPrivateReadsBeforeAccess: true, lateAuthorizationIgnored: true, retryWithoutReload: true, retryReachableAt320: true, realSharedPassExpiresOnTime: true, stalledRenewalCannotExtendAccess: true, expiredResponseRejected: true }));
});
