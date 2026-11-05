// Built application, real operator WebSocket confirmation, disposable local D1.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";

await withLocalSmokeFixture(async ({ origin, orgId, browser, operatorEmail, operatorPassword }) => {
  const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
  const fmt30 = { frameRate: 30, dropFrame: "ndf" };
  const fmt25 = { frameRate: 25, dropFrame: "ndf" };
  const tc = seconds => ({ hours: 0, minutes: 0, seconds, frames: 0 });
  const read = async path => (await browser("eval", `fetch('/api/timecode/${orgId}/${path}?showId=smoke-show').then(response => response.json())`)).result;
  const command = async (action, payload) => {
    const { result } = await browser("eval", `fetch('/api/timecode/${orgId}/command?showId=smoke-show', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(${JSON.stringify({ action, payload })})}).then(async response => ({status:response.status,body:await response.json()}))`);
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
  for (const [id, seconds] of [["fired-format-cue", 1], ["future-format-cue", 2]]) {
    await command("add-event", { id, label: id, action: "lyrics-clear", triggerTimecode: tc(seconds), payload: {}, toleranceFrames: 0 });
  }
  await command("start");
  await command("feed-tc", { timecode: tc(1), format: fmt30 });
  const observed = await browser("eval", `(async () => {
    const tick = ${JSON.stringify({ action: "feed-tc", payload: { timecode: tc(1), format: fmt25 } })};
    const send = () => fetch('/api/timecode/${orgId}/command?showId=smoke-show', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(tick)}).then(response => response.json());
    for(let i=0;i<4;i++) await send();
    const before = await fetch('/api/timecode/${orgId}/state?showId=smoke-show').then(response => response.json());
    await send();
    const after = await fetch('/api/timecode/${orgId}/state?showId=smoke-show').then(response => response.json());
    return {before,after};
  })()`);
  assert.deepEqual(observed.result.before.format, fmt30);
  assert.ok(!observed.result.before.incomingFormat);
  assert.deepEqual(observed.result.after.incomingFormat.format, fmt25);
  assert.equal(observed.result.after.running, false);
  assert.equal(observed.result.after.triggersEnabled, false);
  await browser("wait", "text=Input reports 25 fps NDF for five consecutive readings.");
  await click("Reformat timeline to 25 fps NDF");
  await click("Cancel");
  assert.deepEqual((await read("state")).format, fmt30);
  await click("Reformat timeline to 25 fps NDF");
  await click("Reformat timeline");
  await browser("wait", "--fn", "document.querySelector('#timecode-frame-rate')?.value === '25-ndf'");
  assert.equal((await read("state")).triggersEnabled, false);
  assert.deepEqual((await read("events")).map(event => [event.id, event.triggerFrame, event.fired]), [
    ["fired-format-cue", 25, true], ["future-format-cue", 50, false],
  ]);
  await click("Enable automation");
  await command("feed-tc", { timecode: tc(1), format: fmt25 });
  await command("feed-tc", { timecode: tc(2), format: fmt25 });
  assert.deepEqual((await read("events")).map(event => [event.fired, event.executionAttempts]), [[true, 1], [true, 1]]);
  await command("stop");
  await browser("select", "#timecode-frame-rate", "30-ndf");
  await click("Reformat timeline");
  await browser("wait", "--fn", "document.querySelector('#timecode-frame-rate')?.value === '30-ndf'");
  await command("add-event", { id: "invalid-frame", label: "Frame 29 guard", action: "lyrics-clear", triggerTimecode: { ...tc(1), frames: 29 }, payload: {} });
  await browser("select", "#timecode-frame-rate", "25-ndf");
  await click("Reformat timeline");
  await browser("wait", "text=Correct or remove that cue before reformatting.");
  assert.deepEqual((await read("state")).format, fmt30);
  console.log(JSON.stringify({ login: "passed", transientFormatsIgnored: "passed", stableFormatHeld: "passed", cancelPreservesFormat: "passed", explicitReformat: "passed", firedCuesPreserved: "passed", separateRearm: "passed", invalidCueVisibleRejection: "passed" }, null, 2));
});
