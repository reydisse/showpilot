// Named fields -> authenticated save -> real lyric and stage outputs.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll } from "./real-browser-fixture.mjs";

await withLocalSmokeFixture(async ({ origin, orgId, browser, operatorEmail, operatorPassword, operatorCookie }) => {
  const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
  const evaluate = async expression => (await browser("eval", expression)).result;
  const form = 'form:has(input[placeholder="00:05:00:00"])';
  const read = async path => { const response = await fetch(`${origin}/api/${path}/${orgId}/state?showId=smoke-show`, { headers: { Cookie: operatorCookie } }); assert.equal(response.status, 200); return response.json(); };
  const events = async () => { const response = await fetch(`${origin}/api/timecode/${orgId}/events?showId=smoke-show`, { headers: { Cookie: operatorCookie } }); assert.equal(response.status, 200); return response.json(); };
  const action = value => browser("select", `${form} select >> nth=0`, value);
  const selectLabel = async (label, value) => {
    const id = await evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(`${form} label`)})).find(label => label.textContent.trim() === ${JSON.stringify(label)})?.htmlFor`);
    assert.ok(id); await browser("select", `[id=${JSON.stringify(id)}]`, value);
  };
  await browser("open", `${origin}/login`);
  await browser("fill", "#email", operatorEmail); await browser("fill", "#password", operatorPassword); await click("Sign in");
  await browser("wait", "--url", `**/${orgId}/**`);
  await browser("open", `${origin}/${orgId}/songs`);
  await click("New song");
  await browser("find", "label", "Title", "fill", "Cue fields rehearsal");
  await browser("find", "label", "Section 1 lyrics", "fill", "First verse line\nSecond verse line");
  await click("Add section");
  await browser("find", "label", "Section 2 name", "fill", "Chorus");
  await browser("find", "label", "Section 2 lyrics", "fill", "Chorus words");
  await click("Create song");
  await browser("wait", "--url", `**/${orgId}/songs/*`);
  const songId = new URL(await evaluate("location.href")).pathname.split("/").at(-1);
  await browser("open", `${origin}/${orgId}/timecode`);
  await browser("wait", "text=Start Internal Generator");
  await browser("fill", `${form} input[placeholder="00:05:00:00"]`, "00:01:00:00");
  await action("lyrics-goto");
  await browser("wait", "--fn", `Array.from(document.querySelectorAll('option')).some(option => option.value === ${JSON.stringify(songId)})`);
  await selectLabel("Song", songId);
  await browser("wait", "--fn", "Array.from(document.querySelectorAll('option')).some(option => option.textContent === 'Verse 1')");
  const sectionId = await evaluate("Array.from(document.querySelectorAll('option')).find(option => option.textContent === 'Verse 1').value");
  await selectLabel("Section", sectionId);
  await browser("set", "viewport", "320", "780");
  await browser("scrollintoview", `${form} button[type=submit]`);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(form)}).scrollWidth <= document.querySelector(${JSON.stringify(form)}).clientWidth + 1`), true);
  await browser("screenshot", "/tmp/showpilot-cue-fields-lyrics-320.png");
  await browser("find", "label", "Label", "fill", "Saved verse");
  await click("Add Event");
  const lyric = await poll(async () => (await events()).find(event => event.label === "Saved verse"), "saved lyric section");
  assert.deepEqual(lyric.payload, { songId, songTitle: "Cue fields rehearsal", sectionId, sectionLabel: "Verse 1", lyrics: "First verse line\nSecond verse line", nextLabel: "Chorus" });
  await browser("set", "viewport", "1440", "900");
  await click("Fire Saved verse");
  await poll(async () => (await read("timecode")).lyrics?.sectionId === sectionId, "live saved verse");
  for (const [kind, field, value, label] of [
    ["stage-message", "Stage message", "Stand by cameras", "Stage standby"],
    ["rundown-adjust", "Seconds to add or subtract", "-12.5", "Shorten current item"],
    ["lower-third-show", "First line", "Welcome everyone", "Welcome graphic"],
  ]) {
    await action(kind);
    await browser("fill", `${form} input[placeholder="00:05:00:00"]`, "00:02:00:00");
    await browser("find", "label", field, "fill", value);
    await browser("find", "label", "Label", "fill", label);
    await click("Add Event");
    await poll(async () => (await events()).some(event => event.label === label), `saved ${kind}`);
  }
  for (const [kind, field, value, label] of [["person", "Person name", "Fixture speaker", "Person cue"], ["scripture", "Scripture text", "Fixture verse", "Scripture cue"]]) {
    await selectLabel("Lower third type", kind);
    await browser("fill", `${form} input[placeholder="00:05:00:00"]`, "00:03:00:00");
    await browser("find", "label", field, "fill", value);
    await browser("find", "label", "Label", "fill", label);
    await click("Add Event");
    const cue = await poll(async () => (await events()).find(event => event.label === label), `saved ${kind} lower third`);
    assert.equal(cue.payload.type, kind);
    assert.equal(cue.payload[kind === "person" ? "name" : "scripture"], value);
    await click(`Fire ${label}`);
    await poll(async () => (await events()).find(event => event.id === cue.id)?.executionStatus === "acknowledged", `${kind} lower third acknowledgement`);
  }
  await click("Fire Stage standby");
  await poll(async () => (await read("rundown")).stageMessage === "Stand by cameras", "stage message output");
  assert.equal((await events()).find(event => event.label === "Shorten current item").payload.deltaMs, -12500);
  await action("pp-trigger-slide");
  await browser("wait", "text=Import a presentation from ProPresenter in Songs first.");
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(form)}).querySelector('button[type=submit]').disabled`), true);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(form)}).textContent.includes('JSON')`), false);
  console.log(JSON.stringify({ passed: true, savedSongAndSection: true, liveLyrics: true, liveStageMessage: true, narrowFormFits: true, noRawJson: true }));
});
