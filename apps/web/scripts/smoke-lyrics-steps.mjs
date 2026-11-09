// Built UI -> saved song -> real timecode relay -> rendered confidence display.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll } from "./real-browser-fixture.mjs";

await withLocalSmokeFixture(async ({ origin, orgId, browser, pass, operatorEmail, operatorPassword, operatorCookie }) => {
  const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
  await browser("open", `${origin}/login`);
  await browser("fill", "#email", operatorEmail);
  await browser("fill", "#password", operatorPassword);
  await click("Sign in");
  await browser("wait", "--url", `**/${orgId}/**`);
  await browser("open", `${origin}/${orgId}/songs`);
  await click("New song");
  await browser("find", "label", "Title", "fill", "Step rehearsal");
  await browser("find", "label", "Section 1 lyrics", "fill", "Verse line one\nVerse line two");
  await click("Add section");
  await browser("find", "label", "Section 2 name", "fill", "Chorus");
  await browser("find", "label", "Section 2 lyrics", "fill", "Chorus line one\nChorus line two");
  await click("Add section");
  await browser("find", "label", "Section 3 name", "fill", "Bridge");
  await browser("find", "label", "Section 3 lyrics", "fill", "Bridge line one\nBridge line two");
  await click("Create song");
  await browser("wait", "--url", `**/${orgId}/songs/*`);
  await browser("click", 'button:text-is("Show now") >> nth=0');
  const state = async () => {
    const response = await fetch(`${origin}/api/timecode/${orgId}/state?showId=smoke-show`, { headers: { Cookie: operatorCookie } });
    assert.equal(response.status, 200); return response.json();
  };
  await poll(async () => (await state()).lyrics?.lyrics === "Verse line one\nVerse line two", "initial live verse");
  await browser("tab", "new", `${origin}/timer/${orgId}?displayPass=${pass("timer")}&view=stage`);
  await browser("wait", "text=Verse line one");
  await browser("eval", `(() => {
    const lyric = [...document.querySelectorAll('p')].find(node => node.textContent === 'Verse line one\\nVerse line two');
    if (!lyric) throw new Error('Live lyric node missing');
    window.lyricCheck = { values: [lyric.textContent], removed: false };
    window.lyricObserver = new MutationObserver(() => {
      window.lyricCheck.removed ||= !lyric.isConnected;
      const value = lyric.isConnected ? lyric.textContent : null;
      if (window.lyricCheck.values.at(-1) !== value) window.lyricCheck.values.push(value);
    });
    window.lyricObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    return true;
  })()`);
  await browser("tab", "0");
  await browser("open", `${origin}/${orgId}/timecode`);
  await browser("wait", "text=Start Internal Generator");
  const form = 'form:has(input[placeholder="00:05:00:00"])';
  const readEvents = async () => {
    const response = await fetch(`${origin}/api/timecode/${orgId}/events?showId=smoke-show`, { headers: { Cookie: operatorCookie } });
    assert.equal(response.status, 200); return response.json();
  };
  for (const [action, label, expected] of [
    ["lyrics-next-section", "Next Lyrics Section", "Chorus line one\nChorus line two"],
    ["lyrics-previous-section", "Previous Lyrics Section", "Verse line one\nVerse line two"],
  ]) {
    await browser("fill", `${form} input[placeholder="00:05:00:00"]`, "00:01:00:00");
    await browser("select", `${form} select`, action);
    assert.equal((await browser("eval", `document.querySelector(${JSON.stringify(form)}).querySelector('textarea') === null`)).result, true);
    await browser("set", "viewport", "320", "780");
    await browser("scrollintoview", `${form} button[type=submit]`);
    assert.equal((await browser("eval", `document.querySelector(${JSON.stringify(form)}).scrollWidth <= document.querySelector(${JSON.stringify(form)}).clientWidth + 1`)).result, true);
    await browser("screenshot", `/tmp/showpilot-${action}-320.png`);
    await browser("set", "viewport", "1440", "900");
    await click("Add Event");
    await browser("wait", "--fn", `document.querySelector(${JSON.stringify(`${form} input[placeholder="00:05:00:00"]`)}).value === ''`);
    await click(`Fire ${label}`);
    await poll(async () => (await readEvents()).find(event => event.action === action)?.executionStatus === "acknowledged", `${action} acknowledgment`);
    assert.equal((await state()).lyrics.lyrics, expected);
    await browser("tab", "1");
    await browser("wait", "--fn", `window.lyricCheck.values.at(-1) === ${JSON.stringify(expected)}`);
    await browser("screenshot", `/tmp/showpilot-${action}-confidence.png`);
    await browser("tab", "0");
  }
  await browser("tab", "1");
  const result = (await browser("eval", "window.lyricObserver.disconnect(); window.lyricCheck")).result;
  assert.equal(result.removed, false, "Confidence lyric node must stay mounted");
  assert.deepEqual(result.values, ["Verse line one\nVerse line two", "Chorus line one\nChorus line two", "Verse line one\nVerse line two"]);
  console.log(JSON.stringify({ passed: true, confidenceNodeStayedMounted: !result.removed, lyricStates: result.values }));
});
