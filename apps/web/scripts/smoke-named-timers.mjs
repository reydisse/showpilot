// Real built UI, show-scoped relays and confidence outputs. Disposable local data only.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll } from "./real-browser-fixture.mjs";

await withLocalSmokeFixture(async ({ origin, orgId, browser, operatorEmail, operatorPassword, operatorCookie, stopServer, startServer }) => {
  const read = async path => {
    const response = await fetch(`${origin}${path}`, { headers: { Cookie: operatorCookie } });
    assert.equal(response.status, 200); return response.json();
  };
  const state = () => read(`/api/timecode/${orgId}/state?showId=smoke-show`);
  const events = () => read(`/api/timecode/${orgId}/events?showId=smoke-show`);
  const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
  const command = async (action, payload) => {
    const result = (await browser("eval", `fetch(${JSON.stringify(`/api/timecode/${orgId}/command?showId=smoke-show`)}, {method:'POST',headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify({ action, payload }))}}).then(async response => ({status:response.status,body:await response.text()}))`)).result;
    assert.equal(result.status, 200, result.body);
  };
  await browser("open", `${origin}/login`);
  await browser("fill", "#email", operatorEmail); await browser("fill", "#password", operatorPassword); await click("Sign in");
  await browser("wait", "--url", `**/${orgId}/**`);
  await browser("open", `${origin}/${orgId}/timecode`); await browser("wait", "text=Start Internal Generator");
  await click("Take control"); await browser("wait", "text=You control this show");
  await command("set-lyrics", { songId: "fixture-song", songTitle: "Fixture song", sectionId: "verse", sectionLabel: "Verse", lyrics: "A held lyric\nSecond line", nextLabel: "Chorus" });
  await browser("tab", "new", `${origin}/timer/${orgId}?view=stage`);
  await browser("wait", "text=A held lyric");
  await browser("eval", "window.heldLyric = [...document.querySelectorAll('p')].find(node => node.textContent === 'A held lyric\\nSecond line')");
  await browser("tab", "0");
  const form = 'form:has(input[placeholder="00:05:00:00"])';
  for (const [action, name, duration, second] of [["timer-start", "Speaker countdown", "5:00", 10], ["timer-stop", "Speaker countdown", null, 20], ["timer-start", "Break", "1:00", 30]]) {
    await browser("select", `${form} select >> nth=0`, action);
    await browser("fill", `${form} input[placeholder="00:05:00:00"]`, `00:00:${second}:00`);
    await browser("find", "label", "Timer name", "fill", name);
    if (duration) await browser("find", "label", "Duration (m:ss)", "fill", duration);
    if (second === 10) {
      await browser("set", "viewport", "320", "780"); await browser("scrollintoview", `${form} input[placeholder="5:00"]`);
      assert.equal((await browser("eval", `document.querySelector(${JSON.stringify(form)}).scrollWidth <= document.querySelector(${JSON.stringify(form)}).clientWidth + 1`)).result, true);
      await browser("screenshot", "/tmp/showpilot-named-timer-editor-320.png"); await browser("set", "viewport", "1440", "900");
    }
    await click("Add Event");
    await browser("wait", "--fn", `document.querySelector(${JSON.stringify(`${form} input[placeholder="00:05:00:00"]`)}).value === ''`);
  }
  assert.equal((await events()).length, 3);
  await click("Fire Start Speaker countdown");
  await poll(async () => (await state()).namedTimers.timers.length === 1, "named timer start");
  assert.equal((await state()).running, false, "Countdown must not need the timecode clock");
  const firstDeadline = (await state()).namedTimers.timers[0].endsAt;
  const timerSelector = '[data-named-timer="Speaker countdown"] [data-named-timer-remaining]';
  await browser("tab", "1"); await browser("wait", timerSelector);
  const initial = (await browser("get", "text", timerSelector)).text;
  await browser("wait", "--fn", `document.querySelector(${JSON.stringify(timerSelector)}).textContent !== ${JSON.stringify(initial)}`);
  assert.equal((await browser("eval", "window.heldLyric?.isConnected && window.heldLyric.textContent === 'A held lyric\\nSecond line'")).result, true);
  await browser("screenshot", "/tmp/showpilot-named-timer-stage.png");
  await browser("tab", "0");
  const outputUrl = (await browser("eval", "document.querySelector('a[aria-label=\"Open Speaker countdown timer display\"]').href")).result;
  assert.equal(new URL(outputUrl).searchParams.get("showId"), "smoke-show");
  await browser("tab", "new", outputUrl);
  await browser("wait", '[data-named-timer-output]'); await browser("wait", "text=Countdown");
  await browser("set", "viewport", "320", "240");
  assert.equal((await browser("eval", "document.querySelector('[data-named-timer-output]').scrollWidth <= innerWidth + 1")).result, true);
  await browser("screenshot", "/tmp/showpilot-named-timer-output-320.png"); await browser("set", "viewport", "1440", "900");
  await browser("tab", "0"); await click("Fire Start Break"); await click("Fire Stop Speaker countdown");
  await poll(async () => (await state()).namedTimers.timers.map(timer => timer.name).join() === "Break", "named stop leaves other timer");
  await browser("tab", "1");
  await browser("wait", '[data-named-timer="Break"]');
  await browser("wait", "--fn", "!document.querySelector('[data-named-timer=\"Speaker countdown\"]')");
  assert.equal((await browser("eval", "window.heldLyric?.isConnected")).result, true);
  await browser("tab", "2"); await browser("wait", "text=Stopped");
  await browser("tab", "0");
  await browser("click", 'div:has(> button[aria-label="Re-arm Start Speaker countdown"]) > button:text-is("Re-fire")');
  await click("Fire again");
  await poll(async () => (await state()).namedTimers.timers.some(timer => timer.name === "Speaker countdown" && timer.endsAt > firstDeadline), "reviewed timer restart");
  const restartDeadline = (await state()).namedTimers.timers.find(timer => timer.name === "Speaker countdown").endsAt;
  await browser("tab", "2"); await browser("wait", "text=Countdown");
  await browser("tab", "new", `${origin}/${orgId}/rundown?show=smoke-second-show`);
  await click("Take live"); await browser("wait", '[role="dialog"]'); await browser("click", '[role="dialog"] button:text-is("Take live")');
  await browser("wait", "text=Live output");
  await browser("tab", "1"); await browser("wait", "--fn", "!document.querySelector('[aria-label=\"Named timers\"]')");
  await browser("tab", "2");
  assert.equal((await browser("get", "text", '[data-named-timer-output] h1')).text, "Speaker countdown");
  assert.equal((await browser("get", "text", '[role="status"]')).text, "Countdown");
  await stopServer();
  await browser("wait", "text=Reconnecting · timer unconfirmed");
  const frozen = (await browser("get", "text", '[data-named-timer-remaining]')).text;
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal((await browser("get", "text", '[data-named-timer-remaining]')).text, frozen);
  await startServer(); await browser("wait", "text=Countdown");
  assert.equal((await state()).namedTimers.timers.find(timer => timer.name === "Speaker countdown").endsAt, restartDeadline);
  console.log(JSON.stringify({ passed: true, independentCountdown: true, lyricsStayedMounted: true, stopLeftOtherTimer: true, reviewedRestart: true, pinnedShowSurvivedActivation: true, disconnectedOutputFrozen: true, restartPreservedDeadline: true }));
}, { secondShow: true });
