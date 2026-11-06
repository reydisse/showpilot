// Real login and built Worker/DO alarms; local disposable organization only.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";

await withLocalSmokeFixture(async ({ origin, orgId, browser, operatorCookie, operatorEmail, operatorPassword }) => {
  await browser("open", `${origin}/login`);
  await browser("fill", "#email", operatorEmail);
  await browser("fill", "#password", operatorPassword);
  await browser("find", "role", "button", "click", "--name", "Sign in", "--exact");
  await browser("wait", "--url", `**/${orgId}/**`);
  await browser("open", `${origin}/${orgId}/timecode`);
  await browser("wait", "text=Start Internal Generator");
  const started = await browser("eval", `new Promise((resolve, reject) => {
    const socket = new WebSocket(location.origin.replace('http', 'ws') + '/api/timecode/${orgId}/ws?showId=smoke-show');
    window.watchdogMaster = socket;
    const timeout = setTimeout(() => reject(new Error('Master feed not confirmed')), 5000);
    socket.onmessage = event => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'hydrate') socket.send(JSON.stringify({ type: 'command', action: 'start' }));
      if (msg.type === 'master-status' && msg.granted) {
        socket.send(JSON.stringify({ type: 'command', action: 'set-source', payload: { source: 'mtc' } }));
        socket.send(JSON.stringify({ type: 'command', action: 'feed-tc', payload: { timecode: { hours: 0, minutes: 0, seconds: 5, frames: 0 }, format: { frameRate: 30, dropFrame: 'ndf' } } }));
      }
      if (msg.type === 'tc-update' && msg.state.totalFrames === 150 && msg.state.running) { clearTimeout(timeout); resolve(msg.state); }
    };
  })`);
  assert.equal(started.result.totalFrames, 150);
  await browser("wait", "text=MTC signal lost");
  assert.equal((await browser("eval", "document.body.textContent.includes('Clock held; automation paused.')")).result, true);
  assert.equal((await browser("eval", "document.querySelectorAll('[aria-label=\"Timecode signal lost\"]').length > 0")).result, true);
  const deadline = Date.now() + 5000;
  let held;
  do {
    const response = await fetch(`${origin}/api/timecode/${orgId}/state?showId=smoke-show`, { headers: { Cookie: operatorCookie } });
    assert.equal(response.status, 200);
    held = await response.json();
    if (held.signal?.status === "timecode-lost") break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.equal(held.signal.status, "timecode-lost");
  assert.equal(held.signal.lastFeedAt, started.result.signal.lastFeedAt);
  assert.equal(held.running, false);
  assert.equal(held.totalFrames, 150);
  await browser("eval", `new Promise(resolve => {
    window.watchdogMaster.onmessage = event => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'tc-update' && msg.state.signal?.status === 'idle') resolve(true);
    };
    window.watchdogMaster.send(JSON.stringify({ type: 'command', action: 'stop' }));
  })`);
  await browser("wait", "text=Resume Internal Generator");
  await browser("find", "role", "button", "click", "--name", "Resume Internal Generator", "--exact");
  await browser("wait", "text=Stop Generator");
  const resumed = await (await fetch(`${origin}/api/timecode/${orgId}/state?showId=smoke-show`, { headers: { Cookie: operatorCookie } })).json();
  assert.equal(resumed.running, true);
  assert.ok(resumed.totalFrames >= 150 && resumed.totalFrames < 450, `Resume reset/jumped the clock to ${resumed.totalFrames}`);
  await browser("find", "role", "button", "click", "--name", "Stop Generator", "--exact");
  await browser("wait", "text=Resume Internal Generator");
  assert.equal((await browser("eval", "document.body.textContent.includes('Stopped · position held')")).result, true);
  console.log(JSON.stringify({ login: "passed", liveFeed: "passed", visibleMtcLoss: "passed", relayAlarmLoss: "passed", heldFrame: "passed", persistedLastFeed: "passed", resumeFromHeldFrame: "passed" }, null, 2));
});
