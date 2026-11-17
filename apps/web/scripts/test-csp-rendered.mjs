import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { withLocalSmokeFixture } from './local-smoke-fixture.mjs';
await withLocalSmokeFixture(async ({ origin }) => {
  const nonces = [];
  for (let i = 0; i < 2; i++) {
    const response = await fetch(`${origin}/login`, { headers: { 'x-showpilot-csp-nonce': 'attacker' } });
    assert.equal(response.status, 200);
    const csp = response.headers.get('content-security-policy');
    const nonce = csp.match(/'nonce-([^']+)'/)[1];
    assert.notEqual(nonce, 'attacker');
    nonces.push(nonce);
    let count = 0;
    for (const [, attrs, body] of (await response.text()).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (/\bsrc\s*=/.test(attrs)) continue;
      count++;
      const hash = createHash('sha256').update(body).digest('base64');
      assert.ok(attrs.includes(`nonce="${nonce}"`) || csp.includes(`'sha256-${hash}'`), `Uncovered script: ${attrs} ${body.slice(0, 100)}`);
    }
    assert.ok(count > 1);
  }
  assert.notEqual(...nonces);
  console.log('Rendered CSP coverage: 2 real Worker login requests passed');
});
