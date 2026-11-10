// Built Worker, authenticated browser and real D1. Disposable fixture data only.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll } from "./real-browser-fixture.mjs";
await withLocalSmokeFixture(async ({ origin, orgId, browser, operatorEmail, operatorPassword, operatorCookie, queryFixture }) => {
  const endpoint = `${origin}/api/operational-errors/${orgId}`;
  const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
  const evaluate = async expression => (await browser("eval", expression)).result;
  const rows = () => queryFixture(`SELECT source,code,errorName,asset,line,column FROM operational_error WHERE orgId='${orgId}' ORDER BY createdAt`);
  const report = { code: "browser_error", errorName: "TypeError" };
  // Exercise rejected bodies on successive connections: no_bundle dev servers
  // omit Wrangler's body-draining middleware and can lose a later request.
  for (let attempt = 0; attempt < 100; attempt++) {
    for (const [name, headers, payload, expectedStatus] of [
      ["anonymous", { Origin: origin }, report, 401],
      ["cross-origin", { Cookie: operatorCookie, Origin: "https://other.test" }, report, 403],
      ["invalid-field", { Cookie: operatorCookie, Origin: origin }, { ...report, stack: "private-fixture" }, 400],
    ]) {
      const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(payload) });
      const body = await response.text();
      assert.equal(response.status, expectedStatus, `${name} attempt ${attempt}: ${body}`);
    }
  }
  await browser("open", `${origin}/login`); await browser("fill", "#email", operatorEmail); await browser("fill", "#password", operatorPassword);
  await click("Sign in"); await browser("wait", "--url", `**/${orgId}/**`);
  await browser("open", `${origin}/${orgId}/rundown`); await browser("wait", "text=Display test show");
  assert.deepEqual(await rows(), [], "The fixture app should not emit unexpected errors during startup");
  const emit = `window.dispatchEvent(new ErrorEvent('error', { error: new TypeError('private-fixture-secret'), message: 'private-fixture-secret', filename: location.origin + '/assets/rundown-fixture.js?token=private-fixture-secret', lineno: 8, colno: 12 })); true`;
  await evaluate(emit);
  await browser("wait", 'text=An unexpected error occurred.');
  await poll(async () => (await rows()).length === 1, "browser error saved in D1");
  const first = (await rows())[0];
  assert.deepEqual(first, { source: "browser", code: "browser_error", errorName: "TypeError", asset: "rundown-fixture.js", line: 8, column: 12 });
  assert.equal(await evaluate("document.body.innerText.includes('private-fixture-secret')"), false);
  assert.ok(await evaluate("document.querySelector('[role=alert] time')?.getAttribute('datetime')"));
  for (const width of [320, 1440]) {
    await browser("set", "viewport", String(width), "720");
    const bounds = await evaluate(`(() => { const alert = document.querySelector('[role=alert]'); const button = alert.querySelector('button'); const r = button.getBoundingClientRect(); return { fits: alert.scrollWidth <= alert.clientWidth + 1, width: r.width, height: r.height }; })()`);
    assert.ok(bounds.fits && bounds.width >= 44 && bounds.height >= 44, JSON.stringify(bounds));
  }
  await browser("screenshot", "/tmp/showpilot-operational-error-notice.png");
  await evaluate(emit); await click("Dismiss error");
  await evaluate("window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', { promise: Promise.resolve(), reason: new RangeError('private-fixture-rejection') })); true");
  await poll(async () => (await rows()).length === 2, "rejection saved without payload");
  const response = await fetch(endpoint, { headers: { Cookie: operatorCookie } });
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const data = await response.json(); assert.equal(data.errors.length, 2); assert.ok(data.errors.every(error => error.message && error.createdAt));
  assert.equal(JSON.stringify(data).includes("private-fixture"), false);
  console.log(JSON.stringify({ passed: true, actualD1Reports: 2, bodyBearingRejections: 300, boundedSafePayloads: true, duplicateSuppression: true, timestampedNotice: true, dismissAndNarrowLayout: true, authenticatedRead: true, anonymousAndCrossOriginDenied: true }));
});
