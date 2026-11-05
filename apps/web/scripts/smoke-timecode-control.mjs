// Built application, two real operator tabs and a separate HTTP login session.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";

await withLocalSmokeFixture(async ({ origin, orgId, browser, operatorCookie, operatorEmail, operatorPassword }) => {
  const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
  const state = async () => (await fetch(`${origin}/api/timecode/${orgId}/state?showId=smoke-show`, { headers: { Cookie: operatorCookie } })).json();
  await browser("open", `${origin}/login`);
  await browser("fill", "#email", operatorEmail);
  await browser("fill", "#password", operatorPassword);
  await click("Sign in");
  await browser("wait", "--url", `**/${orgId}/**`);
  await browser("open", `${origin}/${orgId}/timecode`);
  await click("Take control");
  await browser("wait", "text=You control this show's timecode.");

  const unauthorized = await fetch(`${origin}/api/timecode/${orgId}/command?showId=smoke-show`, { method: "POST",
    headers: { Cookie: operatorCookie, Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "set-triggers-enabled", payload: { enabled: false } }) });
  assert.equal(unauthorized.status, 409, "A separate login session cannot borrow browser ownership");
  await browser("tab", "new", `${origin}/${orgId}/timecode`);
  await browser("wait", "text=Another operator controls this show's timecode.");
  await browser("fill", 'input[placeholder="00:05:00:00"]', "00:01:00:00");
  await browser("fill", 'input[placeholder^="e.g."]', "Draft kept while another tab controls");
  await click("Add Event");
  await browser("wait", "text=Another operator controls timecode. Ask them to release control first.");
  assert.equal((await browser("get", "value", 'input[placeholder^="e.g."]')).value, "Draft kept while another tab controls");
  assert.equal((await state()).triggersEnabled, true);
  await click("Disable automation");
  assert.equal((await state()).triggersEnabled, true);

  await browser("tab", "0");
  await click("Start Internal Generator");
  await browser("wait", "text=Stop Generator");
  assert.equal((await browser("eval", "[...document.querySelectorAll('button')].find(button => button.textContent === 'Release control').disabled")).result, true);
  await click("Stop Generator");
  await browser("wait", "text=Resume Internal Generator");
  await click("Release control");
  await browser("wait", "text=Timecode controls are available.");
  await browser("tab", "1");
  await click("Take control");
  await browser("wait", "text=You control this show's timecode.");
  await click("Add Event");
  await browser("wait", "text=Draft kept while another tab controls");
  const events = await (await fetch(`${origin}/api/timecode/${orgId}/events?showId=smoke-show`, { headers: { Cookie: operatorCookie } })).json();
  assert.equal(events.length, 1);
  assert.equal(events[0].label, "Draft kept while another tab controls");
  await browser("tab", "close");
  await browser("tab", "0");
  await browser("wait", "text=Timecode controls are available.");
  await click("Take control");
  await browser("wait", "text=You control this show's timecode.");
  console.log(JSON.stringify({ login: "passed", separateHttpSessionRejected: "passed", competingTabRejected: "passed", draftPreserved: "passed", localSourceReleaseGuard: "passed", explicitHandover: "passed", disconnectReleasesControl: "passed" }, null, 2));
});
