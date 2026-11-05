// Real editor -> authenticated relay, with sparse synthetic feed observations.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";

await withLocalSmokeFixture(async ({ origin, orgId, browser, operatorEmail, operatorPassword }) => {
  const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
  const tolerance = 'form input[type="number"][aria-describedby]';
  const readEvents = async () => (await browser("eval", `fetch('/api/timecode/${orgId}/events?showId=smoke-show').then(response => response.json())`)).result;
  const command = async (action, payload) => {
    const { result } = await browser("eval", `fetch('/api/timecode/${orgId}/command?showId=smoke-show',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify({ action, payload })})}).then(async response => ({status:response.status,body:await response.json()}))`);
    assert.equal(result.status, 200); assert.equal(result.body.ok, true);
  };
  await browser("open", `${origin}/login`);
  await browser("fill", "#email", operatorEmail);
  await browser("fill", "#password", operatorPassword);
  await click("Sign in");
  await browser("wait", "--url", `**/${orgId}/**`);
  await browser("open", `${origin}/${orgId}/timecode`);
  await click("Take control");
  await browser("wait", "text=You control this show's timecode.");
  assert.equal((await browser("get", "value", tolerance)).value, "5");
  await browser("fill", tolerance, "1.5");
  await browser("wait", "text=Tolerance must be a whole number");
  assert.equal((await browser("eval", "[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Add Event').disabled")).result, true);
  for (const [label, tc, frames] of [["Exact sparse cue", "00:00:01:00", "0"], ["Custom sparse cue", "00:00:02:00", "3"]]) {
    await browser("fill", 'input[placeholder="00:05:00:00"]', tc);
    await browser("fill", 'input[placeholder^="e.g."]', label);
    await browser("select", "form select", "lyrics-clear");
    await browser("fill", tolerance, frames);
    await click("Add Event");
    await browser("wait", `text=${label}`);
    assert.equal((await browser("get", "value", tolerance)).value, "5", "A confirmed save restores the default for the next cue");
  }
  assert.deepEqual((await readEvents()).map(event => event.toleranceFrames), [0, 3]);
  await command("start");
  // Deliver observations without browser-command delays turning playback into resync.
  const observeFrames = async frames => (await browser("eval", `(async () => {
    const results = [];
    for (const frame of ${JSON.stringify(frames)}) {
      const response = await fetch('/api/timecode/${orgId}/command?showId=smoke-show', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'feed-tc',payload:{timecode:{hours:0,minutes:0,seconds:Math.floor(frame/30),frames:frame%30},format:{frameRate:30,dropFrame:'ndf'}}})});
      if(!response.ok) throw new Error('Feed failed');
      results.push(await fetch('/api/timecode/${orgId}/events?showId=smoke-show').then(response=>response.json()));
    }
    return results.map(events=>events.map(event=>event.fired));
  })()`)).result;
  assert.deepEqual(await observeFrames([26, 31, 40, 58, 61]), [[false, false], [true, false], [true, false], [true, false], [true, true]]);
  console.log(JSON.stringify({ login: "passed", defaultFiveFrames: "passed", invalidToleranceDisabled: "passed", zeroAndCustomSaved: "passed", sparseCrossingsWithZero: "passed", noEarlyForwardFiring: "passed" }, null, 2));
});
