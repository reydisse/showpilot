import assert from 'node:assert/strict';
import { withLocalSmokeFixture } from './local-smoke-fixture.mjs';

await withLocalSmokeFixture(async ({ origin, orgId, browser, operatorEmail, operatorPassword, queryFixture }) => {
  const evaluate = async expression => (await browser('eval', expression)).result;
  const click = name => browser('find', 'role', 'button', 'click', '--name', name, '--exact');
  await browser('open', `${origin}/login`);
  await browser('fill', '#email', operatorEmail); await browser('fill', '#password', operatorPassword); await click('Sign in');
  await browser('wait', '--url', `**/${orgId}/**`);
  await browser('open', `${origin}/${orgId}/dashboard/devices`);
  for (const name of ['Alpha fixture', 'Bravo fixture']) {
    await browser('click', 'button:text-is("Add Device") >> nth=0');
    await browser('select', '#device-adapter', 'atem');
    await browser('fill', '#device-name', name);
    await browser('fill', '#device-field-host', '192.0.2.10');
    await browser('uncheck', 'form input[type="checkbox"]');
    await browser('click', 'form button[type="submit"]');
    await browser('wait', '--fn', '!document.querySelector("#device-name")');
  }
  const devices = await queryFixture(`SELECT id,name FROM device WHERE orgId='${orgId}' ORDER BY name`);
  const bravo = devices.find(device => device.name === 'Bravo fixture');
  assert.ok(bravo);
  await browser('open', `${origin}/${orgId}/dashboard/devices/${bravo.id}`);
  await browser('wait', 'h1');
  const headings = await evaluate('[...document.querySelectorAll("h1")].map(node => node.textContent.trim())');
  assert.deepEqual(headings, ['Bravo fixture'], 'detail URL must render its requested device instead of the parent library');
  assert.equal(await evaluate('document.body.textContent.includes("Configuration & device details")'), false, 'library controls must not mount beside detail controls');
  await browser('wait', 'a[aria-label="Back to devices"]');
  await evaluate('window.navigationDocument = "same-document"');
  for (const [width, height] of [[320, 480], [768, 900], [1440, 900]]) {
    await browser('set', 'viewport', String(width), String(height));
    const bounds = await evaluate(`(() => { const link = document.querySelector('a[aria-label="Back to devices"]'); link.scrollIntoView({ block: 'center' }); const r = link.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, height: r.height, reachable: link.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)), pageWidth: document.documentElement.scrollWidth }; })()`);
    assert.ok(bounds.left >= 0 && bounds.right <= width && bounds.width >= 44 && bounds.height >= 44 && bounds.reachable && bounds.pageWidth <= width, JSON.stringify(bounds));
    if (width === 320) await browser('screenshot', '/tmp/showpilot-device-detail-320.png');
  }
  await browser('click', 'a[aria-label="Back to devices"]');
  await browser('wait', 'text=Configuration & device details');
  assert.equal(await evaluate('document.querySelector("h2").textContent.trim()'), 'Bravo fixture', 'Back retains the requested device selection');
  assert.equal(await evaluate('window.navigationDocument'), 'same-document');
  await browser('click', 'a:text-is("Open device controls")');
  await browser('wait', '--fn', 'document.querySelector("h1")?.textContent.trim() === "Bravo fixture"');
  assert.equal(await evaluate('window.navigationDocument'), 'same-document');
  await browser('back');
  await browser('wait', 'text=Configuration & device details');
  assert.equal(await evaluate('document.querySelector("h2").textContent.trim()'), 'Bravo fixture');
  // The list URL owns selection, so both browser history and an explicit Back
  // link restore the right controls. A stale selection never opens another device.
  await browser('open', `${origin}/${orgId}/dashboard/devices?device=missing`);
  await browser('wait', 'text=This device is no longer available.');
  assert.equal(await evaluate('document.querySelector("h2")'), null);
  await browser('open', `${origin}/${orgId}/dashboard/devices/missing`);
  await browser('wait', 'text=Device unavailable');
  assert.equal(await evaluate('document.querySelector("h1").textContent.trim()'), 'Device unavailable');
  await browser('click', 'a:text-is("Back to devices")');
  await browser('wait', 'text=Configuration & device details');

  const before = await queryFixture(`SELECT value FROM app_setting WHERE orgId='${orgId}' AND key='active-graphics'`);
  await browser('open', `${origin}/${orgId}/streaming/graphics/overlay`);
  await browser('wait', '--url', `**/overlay/${orgId}`);
  await browser('wait', '.overlay-container');
  await browser('wait', 'text=Fixture overlay title');
  assert.equal(await evaluate('document.body.textContent.includes("Creating display link")'), false, 'the graphics library must not render over the output');
  assert.deepEqual(await queryFixture(`SELECT value FROM app_setting WHERE orgId='${orgId}' AND key='active-graphics'`), before);
  assert.deepEqual((await browser('errors')).errors, []);
  // These are disposable accounts in the fixture's isolated browser session.
  await browser('cookies', 'clear');
  await browser('open', `${origin}/${orgId}/streaming/graphics/overlay`);
  await browser('wait', '--url', '**/login');
  assert.equal(await evaluate('document.body.textContent.includes("Fixture overlay title")'), false);
  await browser('fill', '#email', 'second@display-smoke.invalid');
  await browser('fill', '#password', operatorPassword); await click('Sign in');
  await browser('wait', '--url', `**/${orgId}/**`);
  await browser('open', `${origin}/${orgId}/dashboard/devices/${bravo.id}`);
  await browser('wait', '--url', `**/${orgId}/board`);
  assert.equal(await evaluate('document.body.textContent.includes("Bravo fixture")'), false);
  console.log(JSON.stringify({ passed: true, directDetailRendersRequestedDevice: true, parentLibraryUnmounted: true, sameDocumentNavigation: true, historyAndBackRestoreSelection: true, notFoundRecovery: true, viewports: [320, 768, 1440], legacyOverlayUsesProtectedRenderer: true, programUnchanged: true, anonymousDenied: true, devicePermissionEnforced: true }));
}, { secondOperator: true, secondOperatorMember: true });
