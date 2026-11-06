// Real browser/operator/relay checks using disposable local data only.
// Run after the web build: node apps/web/scripts/smoke-show-day-safety.mjs
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";

await withLocalSmokeFixture(async ({ origin, orgId, date, browser, stopServer, startServer, operatorCookie, operatorEmail, operatorPassword }) => {
  const rundownPath = `/api/rundown/${orgId}`;
  const query = `showId=smoke-show&serviceDate=${date}`;
  async function command(action, payload) {
    const response = await fetch(`${origin}${rundownPath}/command?${query}`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: operatorCookie, Origin: origin }, body: JSON.stringify({ action, payload }) });
    assert.equal(response.status, 200, action);
    assert.equal((await response.json()).ok, true, action);
  }
  async function state() {
    const response = await fetch(`${origin}${rundownPath}/state?${query}`, { headers: { Cookie: operatorCookie } });
    assert.equal(response.status, 200);
    return response.json();
  }
  async function expectState(predicate, message) {
    for (let attempt = 0; attempt < 30; attempt++) {
      if (predicate(await state())) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail(message);
  }
  const clickButton = (name) => browser("find", "role", "button", "click", "--name", name, "--exact");
  const openActions = () => browser("click", '[aria-label="Rundown actions"]');
  await command("add-item", { id: "smoke-item", title: "Safety fixture item", type: "segment", duration: 300_000, notes: "Private operator notes", assignee: "", cue: "", hardStop: false });
  await browser("open", `${origin}/login`);
  await browser("fill", "#email", operatorEmail);
  await browser("fill", "#password", operatorPassword);
  await clickButton("Sign in");
  await browser("wait", "--url", `**/${orgId}/**`);
  await browser("open", `${origin}/${orgId}/rundown?showId=smoke-show`);
  await browser("wait", "text=Safety fixture item");
  await browser("wait", '[aria-label="Rundown keyboard shortcuts"]');
  await clickButton("Dismiss shortcuts");
  await browser("click", "h1");
  await browser("press", "Space");
  assert.equal((await state()).timer.playback, "stop", "Bare Space must not start the show");

  await openActions();
  await browser("find", "role", "menuitem", "click", "--name", "Reset timer", "--exact");
  await browser("wait", 'text=Reset this rundown timer?');
  await clickButton("Cancel");
  assert.equal((await state()).items.length, 1);
  await browser("click", "h1");
  await browser("press", "Shift+Space");
  await expectState(value => value.timer.playback === "play", "Shift+Space did not start the show");
  await browser("wait", 'button:has-text("Pause")');
  await openActions();
  assert.equal((await browser("eval", `(() => { const item = [...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent.trim() === 'Reset timer'); return item?.getAttribute('aria-disabled'); })()`)).result, "true", "Reset must be disabled during playback");
  await browser("press", "Escape");
  await command("timer-stop");

  await browser("click", 'button[title="Delete"]');
  await browser("wait", 'text=Delete this rundown item?');
  assert.equal((await state()).items.length, 1, "Delete must wait for confirmation");
  await clickButton("Cancel");
  await browser("click", 'button[title="Delete"]');
  await clickButton("Delete item");
  await expectState(value => value.items.length === 0, "Confirmed item deletion did not reach the relay");
  await clickButton("Undo");
  await expectState(value => value.items.some(item => item.id === "smoke-item"), "Undo did not restore the item");
  assert.equal((await state()).timer.playback, "stop");

  await openActions();
  await browser("find", "role", "menuitem", "click", "--name", "Save as template", "--exact");
  await browser("wait", "text=Save Rundown Template");
  await browser("fill", 'input[placeholder^="e.g."]', "Safety fixture template");
  await clickButton("Save");
  await browser("wait", '[aria-label="Rundown actions"]');
  await openActions();
  await browser("find", "role", "menuitem", "click", "--name", "Load from date or template", "--exact");
  await clickButton("Saved Templates");
  await browser("wait", '[aria-label="Delete Safety fixture template template"]');
  await browser("click", '[aria-label="Delete Safety fixture template template"]');
  await browser("wait", "text=Delete Safety fixture template?");
  await clickButton("Cancel");
  await browser("wait", '[aria-label="Delete Safety fixture template template"]');
  await browser("click", '[aria-label="Delete Safety fixture template template"]');
  await clickButton("Delete template");
  await browser("wait", 'text=No saved templates yet.');
  await browser("click", '[aria-label="Close load rundown"]');

  const timecodePath = `${origin}/api/timecode/${orgId}`;
  const event = { id: "smoke-event", label: "Safety fixture cue", action: "stage-message", triggerTimecode: { hours: 0, minutes: 0, seconds: 30, frames: 0 }, triggerFrame: 900, toleranceFrames: 5, enabled: true, fired: false, payload: { message: "Fixture cue message" } };
  await browser("open", `${origin}/${orgId}/timecode`);
  await browser("find", "role", "button", "click", "--name", "Take control", "--exact");
  await browser("wait", "text=You control this show's timecode.");
  const added = await browser("eval", `fetch('/api/timecode/${orgId}/command?showId=smoke-show', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(${JSON.stringify({ action: "add-event", payload: event })})}).then(response => response.status)`);
  assert.equal(added.result, 200);
  const events = async () => (await fetch(`${timecodePath}/events`, { headers: { Cookie: operatorCookie } })).json();
  assert.equal((await events()).length, 1);
  await browser("wait", "text=Safety fixture cue");
  assert.equal((await browser("eval", "document.body.textContent.includes('Load Demo Show')")).result, false, "Demo events must not be offered in a real timeline");
  await clickButton("Reset All");
  await browser("wait", "text=Reset all automation cues?");
  await clickButton("Cancel");
  await browser("click", '[aria-label="Delete Safety fixture cue automation"]');
  await browser("wait", "text=Delete this automation cue?");
  assert.equal((await events()).length, 1);
  await clickButton("Cancel");
  await browser("click", '[aria-label="Delete Safety fixture cue automation"]');
  await clickButton("Delete cue");
  await browser("wait", "text=No automation events");
  assert.equal((await events()).length, 0);
  await browser("fill", 'input[placeholder="00:05:00:00"]', "00:01:00:00");
  await browser("fill", 'input[placeholder^="e.g."]', "Preserved offline draft");
  await browser("tab", "new", `${origin}/${orgId}/rundown?showId=smoke-show`);
  await browser("wait", "text=Safety fixture item");
  await stopServer();
  await browser("wait", "text=Offline, 0 changes queued");
  assert.equal((await browser("eval", "document.querySelector('[aria-label=\"Next rundown item\"]').disabled")).result, true);
  assert.equal((await browser("eval", "[...document.querySelectorAll('button')].find(el => el.textContent.trim() === 'Start').disabled")).result, true);
  await browser("click", "h1");
  await browser("press", "Shift+Space");
  await browser("tab", "0");
  await browser("wait", "text=Timecode disconnected. Controls will be available after reconnecting.");
  assert.equal((await browser("eval", "document.querySelector('input[placeholder=\"00:05:00:00\"]').value")).result, "00:01:00:00");
  assert.equal((await browser("eval", "[...document.querySelectorAll('button')].find(el => el.textContent.trim() === 'Add Event').matches(':disabled')")).result, true);
  assert.equal((await browser("eval", "[...document.querySelectorAll('button')].find(el => el.textContent.trim() === 'Start Internal Generator').matches(':disabled')")).result, true);
  await startServer();
  await browser("wait", 'button:has-text("Add Event"):not(:disabled)');
  assert.equal((await state()).timer.playback, "stop", "Disconnected shortcut must not start later on reconnect");
  assert.equal((await browser("eval", "document.querySelector('input[placeholder^=\"e.g.\"]').value")).result, "Preserved offline draft");
  await clickButton("Add Event");
  await browser("wait", "text=Preserved offline draft");
  assert.equal((await events()).some(event => event.label === "Preserved offline draft"), true);
  assert.equal((await browser("eval", "document.querySelector('input[placeholder^=\"e.g.\"]').value")).result, "");
  console.log(JSON.stringify({ login: "passed", bareSpace: "safe", modifiedTransportShortcut: "passed", resetConfirmation: "passed", resetWhilePlaying: "blocked", itemDeleteConfirmationAndUndo: "passed", templateDeleteConfirmation: "passed", automationResetAndDeleteConfirmation: "passed", demoHiddenOnRealTimeline: "passed", disconnectedTransport: "disabled", offlineDraftAndReconnect: "preserved", staleShortcut: "not replayed" }, null, 2));
});
