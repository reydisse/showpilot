// Built editor/operator UI -> authenticated local TimecodeRelay -> real stage output.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll } from "./real-browser-fixture.mjs";

await withLocalSmokeFixture(async ({ origin, orgId, browser, operatorEmail, operatorPassword, operatorCookie, date }) => {
  const read = async path => {
    const response = await fetch(`${origin}${path}`, { headers: { Cookie: operatorCookie } });
    assert.equal(response.status, 200); return response.json();
  };
  const state = () => read(`/api/timecode/${orgId}/state?showId=smoke-show`);
  const events = () => read(`/api/timecode/${orgId}/events?showId=smoke-show`);
  const stage = () => read(`/api/rundown/${orgId}/state?showId=smoke-show&serviceDate=${date}`);
  const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
  const command = async (action, payload) => {
    const result = (await browser("eval", `fetch(${JSON.stringify(`/api/timecode/${orgId}/command?showId=smoke-show`)}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify({ action, payload }))} }).then(async response => ({status:response.status, body:await response.text()}))`)).result;
    assert.equal(result.status, 200, result.body);
  };
  const feed = seconds => command("feed-tc", { timecode: { hours: 0, minutes: 0, seconds, frames: 0 }, format: { frameRate: 30, dropFrame: "ndf" } });
  await browser("open", `${origin}/login`);
  await browser("fill", "#email", operatorEmail);
  await browser("fill", "#password", operatorPassword);
  await click("Sign in");
  await browser("wait", "--url", `**/${orgId}/**`);
  await browser("open", `${origin}/${orgId}/timecode`);
  await browser("wait", "text=Start Internal Generator");
  const form = 'form:has(input[placeholder="00:05:00:00"])';
  for (const [action, second] of [["triggers-disable", 1], ["triggers-enable", 3]]) {
    await browser("select", `${form} select`, action);
    await browser("fill", `${form} input[placeholder="00:05:00:00"]`, `00:00:0${second}:00`);
    assert.equal((await browser("eval", `document.querySelector(${JSON.stringify(form)}).querySelector('textarea') === null`)).result, true);
    if (action === "triggers-disable") {
      await browser("set", "viewport", "320", "780");
      await browser("scrollintoview", form);
      assert.equal((await browser("eval", `document.querySelector(${JSON.stringify(form)}).scrollWidth <= document.querySelector(${JSON.stringify(form)}).clientWidth + 1`)).result, true);
      await browser("screenshot", "/tmp/showpilot-trigger-editor-320.png");
      await browser("set", "viewport", "1440", "900");
    }
    await click("Add Event");
    await browser("wait", "--fn", `document.querySelector(${JSON.stringify(`${form} input[placeholder="00:05:00:00"]`)}).value === ''`);
  }
  const controls = await events();
  assert.deepEqual(controls.map(event => event.action), ["triggers-disable", "triggers-enable"]);
  for (const [id, second] of [["held", 2], ["future", 4], ["manual", 10]]) {
    await command("add-event", { id, label: id, action: "stage-message", triggerTimecode: { hours: 0, minutes: 0, seconds: second, frames: 0 }, payload: { message: id }, toleranceFrames: 0 });
  }
  await command("start"); await feed(0); await feed(1); await feed(2);
  assert.equal((await state()).automaticCuesEnabled, false);
  assert.equal((await state()).running, true);
  assert.equal((await state()).totalFrames, 60);
  assert.equal((await stage()).stageMessage, "Fixture private stage message");
  await browser("wait", "text=Automatic cues paused by cue.");
  await browser("set", "viewport", "320", "780");
  await browser("scrollintoview", 'button:text-is("Resume automatic cues")');
  await browser("screenshot", "/tmp/showpilot-trigger-pause-320.png");
  await browser("set", "viewport", "1440", "900");
  await click("Fire manual");
  await poll(async () => (await stage()).stageMessage === "manual", "manual cue while paused");
  await feed(3);
  await poll(async () => (await state()).automaticCuesEnabled === true, "timed resume");
  await feed(4);
  assert.equal((await stage()).stageMessage, "future");
  assert.equal((await events()).find(event => event.id === "held").fired, false);
  // Re-fire the pause through the reviewed relay contract, then use the actual Resume button.
  const pause = (await events()).find(event => event.action === "triggers-disable");
  await command("retry-event", { id: pause.id, confirmed: true, expected: { fired: true, skipped: false, executionId: pause.executionId } });
  await browser("wait", "text=Automatic cues paused by cue.");
  await click("Disable automation");
  await poll(async () => (await state()).triggersEnabled === false, "safety kill");
  assert.equal((await browser("eval", `[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Resume automatic cues').disabled`)).result, true);
  await click("Enable automation");
  await poll(async () => (await state()).triggersEnabled === true, "safety re-enable");
  assert.equal((await state()).automaticCuesEnabled, false);
  await click("Resume automatic cues");
  await poll(async () => (await state()).automaticCuesEnabled === true, "operator resume");
  assert.equal((await events()).find(event => event.id === "held").fired, false);
  console.log(JSON.stringify({ passed: true, clockContinued: true, timedResume: true, manualFireDuringPause: true, skippedCueReplayed: false, safetyKillRespected: true, operatorResume: true }));
});
