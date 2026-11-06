// Real built login, show-scoped relay and lyrics output. Disposable local data only.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";

await withLocalSmokeFixture(async ({ origin, orgId, browser, operatorEmail, operatorPassword }) => {
  const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
  const api = `/api/timecode/${orgId}`;
  const command = async (action, payload) => {
    const { result } = await browser("eval", `fetch('${api}/command?showId=smoke-show', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(${JSON.stringify({ action, payload })})}).then(async response => ({status:response.status, body:await response.json()}))`);
    assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.body.ok, true);
  };
  const read = async (path, showId = "smoke-show") => (await browser("eval", `fetch('${api}/${path}?showId=${showId}').then(response => response.json())`)).result;
  const waitCue = (id, condition) => browser("wait", "--fn", `fetch('${api}/events?showId=smoke-show').then(response => response.json()).then(events => { const cue = events.find(event => event.id === '${id}'); return cue && (${condition}); })`);
  await browser("open", `${origin}/login`);
  await browser("fill", "#email", operatorEmail);
  await browser("fill", "#password", operatorPassword);
  await click("Sign in");
  await browser("wait", "--url", `**/${orgId}/**`);
  await browser("open", `${origin}/${orgId}/timecode`);
  await click("Take control");
  await browser("wait", "text=You control this show's timecode.");
  for (const [id, seconds, enabled] of [["Disabled", 1, false], ["First", 2, true], ["Second", 3, true]]) {
    await command("add-event", { id, label: id, action: "lyrics-goto", enabled,
      triggerTimecode: { hours: 0, minutes: 0, seconds, frames: 0 }, toleranceFrames: 0,
      payload: { songId: "song", songTitle: "Fixture song", sectionId: id, sectionLabel: id, lyrics: id, nextLabel: "" } });
  }
  await click("Skip First");
  await waitCue("First", "cue.skipped === true && !cue.fired");
  await click("Fire next");
  await waitCue("Second", "cue.fired === true");
  assert.equal((await read("state")).lyrics.lyrics, "Second");
  assert.equal((await read("state")).totalFrames, 0, "Manual Fire must not advance the clock");
  await click("Re-arm First");
  await click("Cancel");
  assert.equal((await read("events")).find(cue => cue.id === "First").skipped, true);
  await click("Re-arm First");
  await click("Re-arm cue");
  await waitCue("First", "!cue.skipped && !cue.fired && cue.executionStatus === 'scheduled'");
  assert.equal((await read("state")).lyrics.lyrics, "Second", "Re-arm must not replace live output");
  await click("Fire First");
  await waitCue("First", "cue.fired === true");
  assert.equal((await read("state")).lyrics.lyrics, "First");
  const reviewed = (await read("events")).find(cue => cue.id === "First");
  await click("Re-arm First");
  await command("retry-event", { id: "First" });
  await browser("wait", "text=The cue changed. Close this dialog and review its latest status.");
  assert.equal((await browser("eval", "[...document.querySelectorAll('[role=dialog] button')].find(button => button.textContent === 'Re-arm cue').disabled")).result, true);
  assert.notEqual((await read("events")).find(cue => cue.id === "First").executionId, reviewed.executionId);
  await click("Cancel");
  await click("Re-arm First"); await click("Re-arm cue");
  await waitCue("First", "!cue.fired");
  await click("Disable automation");
  await browser("wait", "--fn", "[...document.querySelectorAll('button')].find(button => button.textContent === 'Fire next')?.disabled");
  assert.equal((await browser("eval", "document.querySelector('[aria-label=\"Fire First\"]').disabled")).result, true);
  for (const width of [320, 768, 2560]) {
    await browser("set", "viewport", String(width), "900");
    const { result } = await browser("eval", `(() => {
      const fire = document.querySelector('[aria-label="Fire First"]');
      const panel = fire.parentElement.parentElement.parentElement;
      return { width: panel.clientWidth, contentWidth: panel.scrollWidth,
        buttons: [...panel.querySelectorAll('button')].map(button => ({ height: button.getBoundingClientRect().height, label: button.getAttribute('aria-label') || button.textContent })) };
    })()`);
    assert.ok(result.contentWidth <= result.width + 1, `Timeline overflows at ${width}px`);
    for (const button of result.buttons) assert.ok(button.height >= 44, `${button.label} must be at least 44px tall at ${width}px`);
  }
  assert.deepEqual(await read("events", "smoke-second-show"), [], "Manual controls must not alter another show");
  console.log(JSON.stringify({ login: "passed", fireNextSkipsDisabledAndSkipped: "passed", manualOutput: "passed", rearmCancelAndConfirm: "passed", staleReviewBlocked: "passed", killSwitch: "passed", separateShow: "passed", timelineSizes: "320/768/2560 passed" }, null, 2));
}, { secondShow: true });
