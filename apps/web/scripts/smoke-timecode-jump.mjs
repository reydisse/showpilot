// Real login/Worker/two-second guard and confirmation UI, disposable local data.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";

await withLocalSmokeFixture(async ({ origin, orgId, browser, operatorEmail, operatorPassword }) => {
  const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
  const timecode = seconds => ({ hours: 0, minutes: 0, seconds, frames: 0 });
  const command = async (action, payload) => {
    const { result } = await browser("eval", `fetch('/api/timecode/${orgId}/command?showId=smoke-show', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(${JSON.stringify({ action, payload })})}).then(async response => ({status:response.status, body:await response.json()}))`);
    assert.equal(result.status, 200); assert.equal(result.body.ok, true);
  };
  const read = async path => (await browser("eval", `fetch('/api/timecode/${orgId}/${path}?showId=smoke-show').then(response => response.json())`)).result;
  const feed = seconds => command("feed-tc", { timecode: timecode(seconds), format: { frameRate: 30, dropFrame: "ndf" } });
  await browser("open", `${origin}/login`);
  await browser("fill", "#email", operatorEmail);
  await browser("fill", "#password", operatorPassword);
  await click("Sign in");
  await browser("wait", "--url", `**/${orgId}/**`);
  await browser("open", `${origin}/${orgId}/timecode`);
  await click("Take control");
  await browser("wait", "text=You control this show's timecode.");
  for (const [id, seconds] of [["already-fired", 1], ["skipped", 2], ["landing", 10], ["during-hold", 11], ["future", 21]]) {
    await command("add-event", { id, label: id, action: "lyrics-clear", triggerTimecode: timecode(seconds), payload: {}, toleranceFrames: 0 });
  }
  await command("start");
  await feed(1);
  await feed(10);
  await browser("wait", "text=Timecode jumped from 00:00:01:00 to 00:00:10:00.");
  assert.equal((await read("state")).triggersEnabled, false);
  await feed(11);
  assert.equal((await read("state")).totalFrames, 330, "The held automation must not freeze the clock");
  await click("Review and resume automation");
  await click("Cancel");
  assert.equal((await read("state")).triggersEnabled, false);
  await click("Review and resume automation");
  await feed(20);
  await browser("wait", "text=Timecode changed again.");
  assert.equal((await browser("eval", "[...document.querySelectorAll('[role=dialog] button')].find(button => button.textContent === 'Resume automation').disabled")).result, true);
  await click("Cancel");
  await click("Review and resume automation");
  await click("Resume automation");
  await browser("wait", "text=Disable automation");
  assert.equal((await read("state")).triggersEnabled, true);
  await feed(21);
  assert.deepEqual((await read("events")).map(event => [event.id, event.fired]), [
    ["already-fired", true], ["skipped", false], ["landing", false], ["during-hold", false], ["future", true],
  ]);
  console.log(JSON.stringify({ login: "passed", jumpDisablesAutomation: "passed", clockContinues: "passed", cancelKeepsHold: "passed", staleConfirmationBlocked: "passed", confirmedResumeSkipsMissedCues: "passed", firedCuesPreserved: "passed" }, null, 2));
});
