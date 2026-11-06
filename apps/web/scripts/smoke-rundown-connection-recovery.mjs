// Real authenticated browser, built Worker and disposable relay data. No production writes.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll } from "./real-browser-fixture.mjs";
await withLocalSmokeFixture(async ({ origin, orgId, date, browser, operatorCookie, operatorEmail, operatorPassword, stopServer, startServer }) => {
  const evaluate = async expression => (await browser("eval", expression)).result;
  const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
  const endpoint = `${origin}/api/rundown/${orgId}`;
  const query = `showId=smoke-show&serviceDate=${date}`;
  const command = async (action, payload) => {
    const response = await fetch(`${endpoint}/command?${query}`, { method: "POST", headers: { Cookie: operatorCookie, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ action, payload }) });
    assert.equal(response.status, 200); assert.equal((await response.json()).ok, true);
  };
  const state = async () => (await fetch(`${endpoint}/state?${query}`, { headers: { Cookie: operatorCookie } })).json();
  await command("add-item", { id: "recovery-item", title: "Retained fixture item", type: "segment", duration: 300000, notes: "", assignee: "", cue: "", hardStop: false });
  await browser("open", `${origin}/login`); await browser("fill", "#email", operatorEmail); await browser("fill", "#password", operatorPassword);
  await click("Sign in"); await browser("wait", "--url", `**/${orgId}/**`);
  await browser("open", `${origin}/${orgId}/rundown?show=smoke-show&date=${date}`);
  await browser("wait", '[data-rundown-item-id="recovery-item"]');
  await browser("wait", "--fn", "[...document.querySelectorAll('button')].some(el => el.textContent.trim() === 'Start' && !el.disabled)");
  await evaluate(`(() => {
    const send = WebSocket.prototype.send; let loseFirst = true;
    window.__recoveryCommands = [];
    WebSocket.prototype.send = function(data) {
      let message; try { message = JSON.parse(data); } catch {}
      if (message?.type === 'command' && message.action === 'stage-message' && message.payload?.message.startsWith('Recovery fixture')) {
        window.__recoveryCommands.push(message);
        if (loseFirst) { loseFirst = false; return; }
      }
      return send.call(this, data);
    }; return true;
  })()`);
  await browser("fill", 'input[placeholder="Message to stage display..."]', "Recovery fixture first"); await click("Send stage message");
  const firstCommand = (await evaluate("window.__recoveryCommands"))[0];
  assert.ok(firstCommand?.id);
  await stopServer();
  await browser("wait", "text=Offline, 1 changes queued");
  await browser("wait", 'button:text-is("Reconnect rundown")');
  assert.ok(await evaluate("document.querySelector('[role=alert] time')?.dateTime"));
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Next rundown item\"]').disabled"), true);
  assert.equal(await evaluate("[...document.querySelectorAll('button')].find(el => el.textContent.trim() === 'Start').disabled"), true);
  assert.equal(await evaluate("document.querySelector('[data-rundown-item-id=\"recovery-item\"]') !== null"), true);
  await browser("fill", 'input[placeholder="Message to stage display..."]', "Recovery fixture second"); await click("Send stage message");
  await browser("wait", "text=Offline, 2 changes queued");
  await browser("click", "h1"); await browser("press", "Shift+Space");
  await browser("set", "viewport", "320", "740");
  const bounds = await evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === 'Reconnect rundown'); const r = button.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, height: r.height }; })()`);
  assert.ok(bounds.left >= 0 && bounds.right <= 320 && bounds.width >= 44 && bounds.height >= 44, JSON.stringify(bounds));
  await browser("screenshot", "/tmp/showpilot-rundown-recovery-320.png");
  await click("Reconnect rundown");
  await browser("wait", "text=Offline, 2 changes queued");
  await startServer(); await click("Reconnect rundown");
  await poll(async () => (await state()).stageMessage === "Recovery fixture second", "both retained changes acknowledged in order");
  await browser("wait", "--fn", "!document.body.innerText.includes('Offline,') && !document.body.innerText.includes('Syncing ')");
  const sent = await evaluate("window.__recoveryCommands");
  assert.equal(sent.length, 3); assert.deepEqual(sent[1], firstCommand);
  assert.notEqual(sent[2].id, firstCommand.id); assert.equal(sent[2].expectedRevision, firstCommand.expectedRevision + 1);
  assert.equal((await state()).timer.playback, "stop", "Offline shortcut must not start after reconnect");
  assert.equal(await evaluate("[...document.querySelectorAll('[role=alert]')].some(el => /Rundown connection|rundown update/.test(el.textContent))"), false);
  await browser("set", "viewport", "1440", "900");
  await browser("find", "role", "link", "click", "--name", "Songs", "--exact");
  await browser("wait", "--fn", "document.querySelector('[aria-label=\"Live rundown\"]')?.innerText.includes('No live rundown') && !document.querySelector('[aria-label=\"Live rundown\"]').innerText.includes('Waiting for confirmed live state')");
  await stopServer();
  await browser("wait", '[aria-label="Live rundown"] [role="alert"] time');
  await browser("wait", '[aria-label="Live rundown"] button:text-is("Reconnect rundown")');
  await startServer(); await click("Reconnect rundown");
  await browser("wait", "--fn", "document.querySelector('[aria-label=\"Live rundown\"] [role=\"alert\"]') === null && !document.body.innerText.includes('Reconnecting, showing last known state')");
  console.log(JSON.stringify({ passed: true, realWorkerOutage: true, retainedRundown: true, timestampedFailure: true, queuedEditsRetained: true, identicalCommandRetry: true, nextEditUsesAcknowledgedRevision: true, offlineTransportDisabled: true, manualReconnect: true, liveBarReconnect: true, fits320: true }));
});
