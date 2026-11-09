// Real built RPC routing and protected display reads, with disposable data only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { withLocalSmokeFixture } from './local-smoke-fixture.mjs';

const web = createRequire(new URL('../package.json', import.meta.url));
const router = createRequire(web.resolve('@tanstack/react-router'));
const core = createRequire(router.resolve('@tanstack/router-core'));
const { toJSONAsync } = core('seroval');
const assets = resolve(import.meta.dirname, '../dist/server/assets');
for (const file of (await readdir(assets)).filter(file => file.endsWith('.js'))) {
  assert.equal((await readFile(resolve(assets, file), 'utf8')).includes('getActiveGraphicBySlug'), false, `The unprotected server function must not be registered in ${file}`);
}

await withLocalSmokeFixture(async ({ origin, orgId, pass, operatorCookie }) => {
  const payload = JSON.stringify(await toJSONAsync({ data: { orgSlug: orgId } }));
  // This is the function ID used by the vulnerable build, not a guessed URL.
  const removed = `${origin}/_serverFn/ee345cfc7e44336e19ea998a4f9d0caaace83dea26e9f00c5396ef9e16db9cf8?${new URLSearchParams({ payload })}`;
  for (const cookie of [undefined, operatorCookie]) {
    const headers = { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'x-tsr-serverFn': 'true', Accept: 'application/json' };
    if (cookie) headers.Cookie = cookie;
    const response = await fetch(removed, { headers });
    assert.ok(response.status >= 400, `Removed function returned ${response.status}`);
    assert.equal((await response.text()).includes('Fixture overlay title'), false);
  }
  for (const token of [undefined, pass('timer'), pass('overlay', 'display-other'), pass('overlay', orgId, true)]) {
    const response = await fetch(`${origin}/api/overlay/${orgId}`, { headers: token ? { 'x-showpilot-display-pass': token } : {} });
    assert.equal(response.status, 401);
    assert.equal((await response.text()).includes('Fixture overlay title'), false);
  }
  const authorized = await fetch(`${origin}/api/overlay/${orgId}`, { headers: { 'x-showpilot-display-pass': pass('overlay') } });
  assert.equal(authorized.status, 200);
  assert.ok((await authorized.text()).includes('Fixture overlay title'));
  console.log(JSON.stringify({ passed: true, removedRpcUnavailable: true, anonymousDenied: true, wrongSurfaceDenied: true, wrongOrganizationDenied: true, expiredPassDenied: true, validOverlayPassWorks: true }));
});
