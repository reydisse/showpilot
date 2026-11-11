import { assertOperatorReadability } from "./operator-readability-audit.mjs";
// Built app and disposable relay/D1: no Bridge or physical equipment is connected.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll } from "./real-browser-fixture.mjs";

await withLocalSmokeFixture(async ({ origin, orgId, browser, operatorEmail, operatorPassword, operatorCookie, queryFixture, stopServer, startServer }) => {
  const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
  const evaluate = async expression => (await browser("eval", expression)).result;
  const events = async () => {
    const response = await fetch(`${origin}/api/timecode/${orgId}/events?showId=smoke-show`, { headers: { Cookie: operatorCookie } });
    assert.equal(response.status, 200); return response.json();
  };
  const command = async (action, payload) => {
    const result = await evaluate(`fetch(${JSON.stringify(`/api/timecode/${orgId}/command?showId=smoke-show`)}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify({ action, payload }))} }).then(async response => ({ status: response.status, body: await response.text() }))`);
    assert.equal(result.status, 200, result.body);
  };
  await browser("open", `${origin}/login`);
  await browser("fill", "#email", operatorEmail);
  await browser("fill", "#password", operatorPassword);
  await click("Sign in");
  await browser("wait", "--url", `**/${orgId}/**`);
  await browser("open", `${origin}/${orgId}/dashboard/devices`);
  await browser("click", 'button:text-is("Add Device") >> nth=0');
  await browser("select", "#device-adapter", "atem");
  await browser("fill", "#device-name", "Main stage ATEM");
  await browser("fill", "#device-field-host", "192.0.2.10");
  await browser("fill", "#device-latency", "200");
  await browser("click", "form button[type=submit]");
  await browser("wait", "text=Configuration & device details");
  const [device] = await queryFixture(`SELECT id FROM device WHERE orgId='${orgId}' AND name='Main stage ATEM'`);
  assert.ok(device);
  await browser("open", `${origin}/${orgId}/timecode`);
  await browser("wait", "text=Start Internal Generator");
  await click("Take control");
  await browser("wait", "text=You control this show\'s timecode.");
  const cue = (id, seconds, extras = {}) => ({ id, label: id, action: "lyrics-clear", enabled: true, triggerTimecode: { hours: 0, minutes: Math.floor(seconds / 60), seconds: seconds % 60, frames: 0 }, toleranceFrames: 5, payload: {}, ...extras });
  await command("add-event", cue("Device cue", 180, { action: "device-action", leadMs: 2000, targetDeviceId: device.id, targetActionId: "set_program_input", payload: { params: { input: 3 } }, toleranceFrames: 12 }));
  await command("add-event", cue("Earlier nominal cue", 179));
  const longLabel = "Long".repeat(45);
  await command("add-event", cue("Webhook cue", 240, { action: "custom-webhook", label: longLabel, payload: { url: "https://example.com/private?token=hidden-query" } }));
  await browser("wait", "text=Device: Main stage ATEM");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-automation-event]')].map(row => row.dataset.automationEvent)"), ["Earlier nominal cue", "Device cue", "Webhook cue"]);
  const next = await evaluate("document.querySelector('[data-next-cue]').textContent");
  assert.match(next, /Next: Device cue/); assert.match(next, /Clock held/);
  const rowText = await evaluate("document.querySelector('[data-automation-event=\"Device cue\"]').textContent");
  assert.match(rowText, /input: 3/); assert.match(rowText, /Tolerance ±12 frames/);
  const webhookText = await evaluate("document.querySelector('[data-automation-event=\"Webhook cue\"]').textContent");
  assert.match(webhookText, /POST https:\/\/example.com/); assert.ok(!webhookText.includes("hidden-query"));

  for (const [width, height] of [[1440, 900], [320, 480]]) {
    await browser("set", "viewport", String(width), String(height));
    await browser("scrollintoview", '[data-automation-event="Webhook cue"]');
    const layout = await evaluate(`(() => {
      const header = document.querySelector('[data-timecode-header]');
      const rows = [...document.querySelectorAll('[data-automation-event]')];
      const rect = header.getBoundingClientRect();
      const start = [...header.querySelectorAll('button')].find(button => button.textContent.includes('Start Internal'));
      const box = start.getBoundingClientRect();
      return { headerTop: rect.top, headerBottom: rect.bottom, width: innerWidth, height: innerHeight,
        rowsFit: rows.every(row => row.scrollWidth <= row.clientWidth + 1),
        actionsFit: rows.every(row => [...row.querySelectorAll('button,label')].every(button => { const r = button.getBoundingClientRect(); return r.width >= 44 && r.height >= 44 && r.left >= 0 && r.right <= innerWidth + 1; })),
        startVisible: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight && start.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)) };
    })()`);
    assert.ok(layout.rowsFit, JSON.stringify(layout)); assert.ok(layout.actionsFit, JSON.stringify(layout)); assert.ok(layout.startVisible, JSON.stringify(layout));
    await assertOperatorReadability(browser, "[data-timecode-page]");
    await browser("screenshot", `/tmp/showpilot-timeline-${width}.png`);
  }
  await click("Start Internal Generator");
  await browser("wait", "text=Pause clock");
  await browser("wait", "--fn", "document.querySelector('[data-timecode-header] [role=status]').textContent.includes('Running')");
  await poll(async () => {
    const response = await fetch(`${origin}/api/timecode/${orgId}/state?showId=smoke-show`, { headers: { Cookie: operatorCookie } });
    assert.equal(response.status, 200);
    return (await response.json()).totalFrames >= 30;
  }, "generator advances before the missed-cue check");
  assert.match(await evaluate("document.querySelector('[data-next-cue]').textContent"), /Next: Device cue.*in [0-9]/);
  await click("Pause clock");
  await browser("wait", "--fn", "document.querySelector('[data-timecode-header] [role=status]').textContent.includes('Paused')");
  await click("Resume clock");
  await browser("wait", "text=Pause clock");
  await click("Stop Generator");
  await browser("wait", "text=Resume Internal Generator");
  await command("add-event", cue("Past cue", 0, { toleranceFrames: 0 }));
  await browser("wait", "--fn", "document.querySelector('[data-automation-event=\"Past cue\"]')?.textContent.includes('Missed')");
  assert.match(await evaluate("document.querySelector('[aria-label=\"Missed or failed cues\"]').textContent"), /Past cue · Missed/);
  assert.equal((await events()).find(event => event.id === "Past cue").fired, false, "A missed cue is not reported as fired");
  await assertOperatorReadability(browser, "[data-timecode-page]");
  await browser("set", "viewport", "1440", "900");
  await click("Fire Device cue");
  const failure = await poll(async () => (await events()).find(event => event.id === "Device cue" && event.executionStatus === "failed"), "disconnected device failure");
  await browser("wait", "--fn", "document.querySelector('[data-automation-event=\"Device cue\"]').textContent.includes('FAILED')");
  await click("Retry Device cue");
  await poll(async () => (await events()).find(event => event.id === "Device cue" && event.executionStatus === "failed" && event.executionId !== failure.executionId), "row Retry new attempt");
  await browser("set", "viewport", "320", "480");
  await browser("scrollintoview", '[data-automation-event="Device cue"]');
  await browser("screenshot", "/tmp/showpilot-timeline-failed-320.png");
  await click("Fire Earlier nominal cue");
  await poll(async () => (await events()).some(event => event.id === "Earlier nominal cue" && event.fired), "successful fired row");
  await assertOperatorReadability(browser, "[data-timecode-page]");
  const rememberedAttempts = (await events()).map(event => ({ id: event.id, executionId: event.executionId }));
  const rememberedRows = await evaluate("[...document.querySelectorAll('[data-automation-event]')].map(row => row.dataset.automationEvent)");
  await stopServer();
  await browser("wait", "--fn", "document.querySelector('[data-timecode-header] [role=status]').textContent.includes('Reconnecting')");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-automation-event]')].map(row => row.dataset.automationEvent)"), rememberedRows);
  await browser("wait", "text=Reconnecting, showing last known timecode state.");
  assert.ok(await evaluate("document.querySelector('[data-timecode-error] time')?.dateTime"));
  assert.equal(await evaluate("[...document.querySelectorAll('[data-timecode-header] button')].every(button => button.disabled)"), true);
  await startServer();
  // The automatic retry may already have hydrated while the fixture restarts.
  if (await evaluate("[...document.querySelectorAll('button')].some(button => button.textContent === 'Reconnect timecode')")) await click("Reconnect timecode");
  await browser("wait", "--fn", "[...document.querySelectorAll('[data-timecode-header] button')].some(button => !button.disabled)");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-automation-event]')].map(row => row.dataset.automationEvent)"), rememberedRows);
  assert.deepEqual((await events()).map(event => ({ id: event.id, executionId: event.executionId })), rememberedAttempts, "Reconnection must not replay any cues");
  console.log(JSON.stringify({ passed: true, nominalOrder: true, compensatedNextWhileStopped: true, runningCountdown: true, missedCueAndAttentionList: true, deviceNamesAndSummaries: true, webhookOriginOnly: true, stickyTransport1440And320: true, minimum44pxActions: true, startPauseResumeStop: true, failedRowRetry: true, disconnectHonesty: true, retainedTimeline: true, timestampedError: true, noReplayAfterReconnect: true, physicalEquipmentConnected: false, operationalTextFloorAndMutedContrast: true }));
}, { paidPlan: true });
