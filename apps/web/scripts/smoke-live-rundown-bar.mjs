// Real login, built UI and relay. Disposable local organizations only.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll } from "./real-browser-fixture.mjs";

await withLocalSmokeFixture(async ({ origin, orgId, date, browser, operatorCookie, operatorEmail, operatorPassword, stopServer, startServer }) => {
  const path = `${origin}/api/rundown/${orgId}`;
  const query = `showId=smoke-show&serviceDate=${date}`;
  const command = async (action, payload) => {
    const response = await fetch(`${path}/command?${query}`, { method: "POST", headers: { Cookie: operatorCookie, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ action, payload }) });
    assert.equal(response.status, 200); assert.equal((await response.json()).ok, true);
  };
  const state = async () => {
    const response = await fetch(`${path}/state?${query}`, { headers: { Cookie: operatorCookie } });
    assert.equal(response.status, 200); return response.json();
  };
  const evaluate = async expression => (await browser("eval", expression)).result;
  const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
  const bar = 'section[aria-label="Live rundown"]';
  await browser("open", `${origin}/login`);
  await browser("fill", "#email", operatorEmail); await browser("fill", "#password", operatorPassword);
  await click("Sign in"); await browser("wait", "--url", `**/${orgId}/**`);
  await browser("open", `${origin}/${orgId}/songs`);
  await browser("wait", "text=No live rundown");
  assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(bar)}).length`), 1);
  for (const [id, title] of [["first", "Welcome to the production rehearsal"], ["last", "Long final item title ".repeat(8)]]) {
    await command("add-item", { id, title, type: "segment", duration: 300000, notes: "", assignee: "", cue: "", hardStop: false });
  }
  await command("timer-start", { itemId: "first" });
  await browser("wait", "text=Rundown live");
  await browser("wait", `${bar} button[aria-label="Pause rundown"]`);
  await click("Pause rundown");
  await poll(async () => (await state()).timer.playback === "pause", "live bar pause acknowledgement");
  await click("Resume rundown");
  await poll(async () => (await state()).timer.playback === "play", "live bar resume acknowledgement");
  await click("Next rundown item");
  await poll(async () => (await state()).timer.currentItemId === "last", "live bar next item");

  for (const [width, height] of [[1440, 900], [320, 480]]) {
    await browser("set", "viewport", String(width), String(height));
    const layout = await evaluate(`(() => {
      const bar = document.querySelector(${JSON.stringify(bar)}); const bounds = bar.getBoundingClientRect();
      return { fits: bar.scrollWidth <= bar.clientWidth + 1 && bounds.left >= 0 && bounds.right <= innerWidth + 1,
        controls: [...bar.querySelectorAll('button')].map(button => { const r = button.getBoundingClientRect(); return { label: button.getAttribute('aria-label'), width: r.width, height: r.height, visible: r.top >= 0 && r.bottom <= innerHeight && button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) }; }) };
    })()`);
    assert.ok(layout.fits, JSON.stringify(layout)); assert.equal(layout.controls.length, 3);
    for (const control of layout.controls) assert.ok(control.width >= 44 && control.height >= 44 && control.visible, JSON.stringify(control));
    await browser("screenshot", `/tmp/showpilot-livebar-${width}.png`);
  }
  await click("Next rundown item");
  await browser("wait", "text=End this show?");
  assert.equal((await state()).timer.playback, "play");
  await click("Keep show running");
  await click("Previous rundown item");
  await poll(async () => (await state()).timer.currentItemId === "first", "previous item");

  // A failed target lookup must not silently enable transport against an old target.
  await browser("network", "route", "**/_serverFn/**", "--abort");
  await evaluate("window.dispatchEvent(new Event('showpilot:active-rundown-changed')); true");
  await browser("wait", "text=Reconnecting, showing last known state");
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(`${bar} button[aria-label="Pause rundown"]`)}).disabled`), true);
  await browser("network", "unroute", "**/_serverFn/**");
  await click("Retry live rundown");
  await browser("wait", "--fn", `document.querySelector(${JSON.stringify(`${bar} button[aria-label="Pause rundown"]`)}).disabled === false`);

  await stopServer();
  await browser("wait", "text=Reconnecting, showing last known state");
  const held = await evaluate("document.querySelector('[data-live-rundown-timer]').textContent");
  await browser("wait", "1200");
  assert.equal(await evaluate("document.querySelector('[data-live-rundown-timer]').textContent"), held);
  assert.equal(await evaluate(`[...document.querySelector(${JSON.stringify(bar)}).querySelectorAll('p')].find(node => node.textContent === 'Reconnecting, showing last known state').getAttribute('aria-live')`), "polite");
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(`${bar} button[aria-label="Pause rundown"]`)}).disabled`), true);
  await browser("screenshot", "/tmp/showpilot-livebar-disconnected-320.png");
  await startServer();
  await browser("wait", "--fn", `document.querySelector(${JSON.stringify(`${bar} button[aria-label="Pause rundown"]`)}).disabled === false`);
  await click("Next rundown item");
  await poll(async () => (await state()).timer.currentItemId === "last", "last item after reconnect");
  await click("Next rundown item"); await click("End show");
  await browser("wait", "text=Show ended");
  assert.equal((await state()).timer.playback, "stop");
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(bar)}).querySelectorAll('button[aria-label$="rundown item"]').length`), 0);
  await browser("screenshot", "/tmp/showpilot-livebar-ended-320.png");
  console.log(JSON.stringify({ passed: true, idleAndEndedVisible: true, realTransportCommands: true, finalItemConfirmation: true, controls44pxAt1440And320: true, targetRefreshFailureVisible: true, disconnectedClockHeld: true, reconnectRecovery: true, productionDataUsed: false }));
});
