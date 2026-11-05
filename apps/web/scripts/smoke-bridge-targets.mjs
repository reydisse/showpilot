// Rehearse destination approval management in the built app with disposable local data.
// Enforcement through live Bridge dispatch is covered separately.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
await withLocalSmokeFixture(async ({ origin, orgId, browser, operatorEmail, operatorPassword, queryFixture }) => {
  const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
  await browser("open", `${origin}/login`);
  await browser("fill", "#email", operatorEmail);
  await browser("fill", "#password", operatorPassword);
  await click("Sign in");
  await browser("wait", "--url", `**/${orgId}/**`);
  await browser("open", `${origin}/${orgId}/settings?section=integrations`);
  await browser("wait", "text=Approved Bridge destinations");
  await browser("find", "label", "Destination name", "fill", "Fixture OBS");
  await browser("find", "label", "Host or IP address", "fill", "VENUE.LOCAL.");
  await browser("find", "label", "Port", "fill", "4455");
  await click("Approve destination");
  await browser("wait", "text=venue.local:4455 · OBS");
  const targets = async () => queryFixture("SELECT label,host,port,protocol,approvedByUserId FROM bridge_target_allowlist WHERE orgId='display-smoke'");
  assert.deepEqual(await targets(), [{ label: "Fixture OBS", host: "venue.local", port: 4455, protocol: "obs", approvedByUserId: "smoke-operator" }]);
  await browser("open", `${origin}/${orgId}/settings?section=api`);
  await browser("wait", "text=venue.local:4455 · OBS");
  for (const width of [320, 768, 2560]) {
    await browser("set", "viewport", String(width), "900");
    const layout = (await browser("eval", `(() => {
      const section = [...document.querySelectorAll('section')].find(el => el.querySelector('h3')?.textContent === 'Approved Bridge destinations');
      const bounds = section.getBoundingClientRect();
      return { width: innerWidth, left: bounds.left, right: bounds.right, scroll: section.scrollWidth, client: section.clientWidth,
        controls: [...section.querySelectorAll('input,select,button')].map(el => ({ height: el.getBoundingClientRect().height, width: el.getBoundingClientRect().width })) };
    })()`)).result;
    assert.ok(layout.scroll <= layout.client + 1, `Approval panel overflows at ${width}px`);
    assert.ok(layout.left >= -1 && layout.right <= width + 1, `Approval panel outside viewport at ${width}px`);
    assert.ok(layout.controls.every(control => control.height >= 44 && control.width > 0), `Unreachable controls at ${width}px`);
  }
  await click("Remove approval for Fixture OBS");
  await browser("wait", '[role="dialog"]');
  await click("Cancel");
  assert.equal((await targets()).length, 1);
  await click("Remove approval for Fixture OBS");
  await browser("click", '[role="dialog"] button:text-is("Remove approval")');
  await browser("wait", "text=No Bridge destinations approved yet.");
  assert.deepEqual(await targets(), []);
  const audit = await queryFixture("SELECT action,actorUserId,host,port,protocol FROM bridge_target_audit WHERE orgId='display-smoke' ORDER BY createdAt");
  assert.deepEqual(audit, ["approved", "removed"].map(action => ({ action, actorUserId: "smoke-operator", host: "venue.local", port: 4455, protocol: "obs" })));
  console.log(JSON.stringify({ login: "passed", canonicalApproval: "passed", crossSettingsVisibility: "passed", responsiveWidths: [320, 768, 2560], cancel: "passed", confirmedRemoval: "passed", actorAudit: "passed" }, null, 2));
});
