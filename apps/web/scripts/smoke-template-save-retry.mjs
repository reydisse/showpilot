// Built UI and Worker, real auth and D1. Lose only a successful fixture response.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll } from "./real-browser-fixture.mjs";
await withLocalSmokeFixture(async ({ origin, orgId, date, browser, operatorCookie, operatorEmail, operatorPassword, queryFixture }) => {
  const evaluate = async expression => (await browser("eval", expression)).result;
  const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
  const add = async (id, title) => {
    const response = await fetch(`${origin}/api/rundown/${orgId}/command?showId=smoke-show&serviceDate=${date}`, { method: "POST", headers: { Cookie: operatorCookie, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ action: "add-item", payload: { id, title, type: "segment", duration: 300000, notes: "", assignee: "", cue: "", hardStop: false } }) });
    assert.equal(response.status, 200); assert.equal((await response.json()).ok, true);
  };
  const rows = () => queryFixture(`SELECT key,value FROM app_setting WHERE orgId='${orgId}' AND (key LIKE 'rundown-saved:%' OR key LIKE 'rundown-template-save:%') ORDER BY key`);
  await add("original", "Snapshot item");
  await browser("open", `${origin}/login`); await browser("fill", "#email", operatorEmail); await browser("fill", "#password", operatorPassword);
  await click("Sign in"); await browser("wait", "--url", `**/${orgId}/**`);
  await browser("open", `${origin}/${orgId}/rundown`); await browser("wait", '[data-rundown-item-id="original"]');
  await evaluate(`(() => {
    const original = window.fetch.bind(window); window.__templateSaveBodies = []; let lose = true;
    window.fetch = async (input, init) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      const saving = body.includes('Smoke saved template');
      if (saving) { window.__templateSaveBodies.push(body); window.__templateSaveRequest = { url: typeof input === 'string' ? input : input.url, headers: [...new Headers(init?.headers)] }; }
      const response = await original(input, init);
      if (saving && lose && response.ok) { lose = false; await response.text(); throw new TypeError('Fixture lost response after commit'); }
      return response;
    }; return true;
  })()`);
  await click("Rundown actions"); await browser("find", "role", "menuitem", "click", "--name", "Save as template", "--exact");
  await browser("fill", "#template-name", "Smoke saved template"); await click("Save");
  await browser("wait", "text=Template save could not be confirmed.");
  await poll(async () => (await rows()).length === 2, "template and receipt committed before response loss");
  const originalRows = await rows();
  const template = JSON.parse(originalRows.find(row => row.key.startsWith("rundown-saved:")).value);
  assert.equal(template.items.length, 1); assert.equal(template.items[0].title, "Snapshot item");
  assert.ok(await evaluate("document.querySelector('[role=dialog] [role=alert] time')?.dateTime"));
  await browser("set", "viewport", "320", "480");
  await browser("scrollintoview", 'button:text-is("Retry save")');
  const layout = await evaluate(`(() => { const modal = document.querySelector('[role=dialog]'); const retry = [...modal.querySelectorAll('button')].find(button => button.textContent === 'Retry save'); const r = retry.getBoundingClientRect(); return { fits: modal.scrollWidth <= modal.clientWidth + 1, width: r.width, height: r.height, locked: [...modal.querySelectorAll('input')].every(input => input.disabled) }; })()`);
  assert.ok(layout.fits && layout.width >= 44 && layout.height >= 44 && layout.locked, JSON.stringify(layout));
  await browser("screenshot", "/tmp/showpilot-template-save-retry-320.png");
  await add("later", "Changed during retry");
  await browser("wait", '[data-rundown-item-id="later"]');
  await click("Retry save"); await browser("wait", "--fn", "document.querySelector('[role=dialog]') === null");
  assert.deepEqual(await rows(), originalRows, "Retry must not duplicate or update the captured template");
  const requests = await evaluate("window.__templateSaveBodies");
  assert.equal(requests.length, 2); assert.equal(requests[0], requests[1]);
  assert.ok(requests[0].includes(template.id), "Captured request must contain the persisted save ID");
  const captured = await evaluate("window.__templateSaveRequest");
  const anonymous = await fetch(new URL(captured.url, origin), { method: "POST", headers: { ...Object.fromEntries(captured.headers), Origin: origin }, body: requests[0].replaceAll(template.id, randomUUID()), redirect: "manual" });
  await anonymous.text();
  assert.deepEqual(await rows(), originalRows, "An anonymous caller cannot create a template or receipt");
  console.log(JSON.stringify({ passed: true, realD1SaveBeforeLostResponse: true, oneTemplateOneReceipt: true, identicalRetry: true, ignoresLaterRundownEdits: true, timestampedError: true, accessibleLabels: true, fits320: true, anonymousSaveRejected: true }));
});
