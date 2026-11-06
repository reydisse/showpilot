// Built application, real login, real Worker rooms, disposable local D1 only.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";

await withLocalSmokeFixture(async ({ origin, orgId, browser, operatorCookie, operatorEmail, operatorPassword }) => {
  const headers = { Cookie: operatorCookie, Origin: origin, "Content-Type": "application/json" };
  async function command(showId, action, payload) {
    const { result } = await browser("eval", `fetch('/api/timecode/${orgId}/command?showId=${showId}', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(${JSON.stringify({ action, payload })})}).then(async response => ({status:response.status, body:await response.json()}))`);
    assert.equal(result.status, 200, `${showId}: ${action}`);
    assert.equal(result.body.ok, true);
  }
  async function state(showId) {
    const response = await fetch(`${origin}/api/timecode/${orgId}/state?showId=${showId}`, { headers });
    assert.equal(response.status, 200);
    return response.json();
  }
  const clickButton = name => browser("find", "role", "button", "click", "--name", name, "--exact");
  const selectShow = async name => {
    await clickButton("Choose show");
    await browser("click", `[role="menuitem"]:has-text("${name}")`);
  };
  await browser("open", `${origin}/login`);
  await browser("fill", "#email", operatorEmail);
  await browser("fill", "#password", operatorPassword);
  await clickButton("Sign in");
  await browser("wait", "--url", `**/${orgId}/**`);
  for (const [showId, name, seconds] of [["smoke-show", "Morning", 1], ["smoke-second-show", "Evening", 2]]) {
    await browser("eval", `new Promise((resolve, reject) => {
      const socket = new WebSocket(location.origin.replace('http', 'ws') + '/api/timecode/${orgId}/ws?showId=${showId}');
      const timer = setTimeout(() => reject(new Error('Control not granted')), 5000);
      socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.type === 'hydrate') socket.send(JSON.stringify({type:'command',action:'claim-control'}));
        if (message.type === 'control-status' && message.control === 'yours') { clearTimeout(timer); resolve(true); }
      };
    })`);
    await command(showId, "add-event", {
      id: `${name}-cue`, label: `${name} unique cue`, action: "stage-message",
      triggerTimecode: { hours: 0, minutes: 0, seconds: 30, frames: 0 }, payload: { message: name },
    });
    await command(showId, "set-timecode", { timecode: { hours: 0, minutes: 0, seconds, frames: 0 } });
    await command(showId, "set-lyrics", {
      songId: name, songTitle: name, sectionId: "verse", sectionLabel: "Verse", lyrics: `${name} held lyric`,
    });
  }
  await browser("open", `${origin}/${orgId}/timecode`);
  await browser("wait", "text=Morning unique cue");
  assert.equal((await browser("eval", "document.body.textContent.includes('Evening unique cue')")).result, false);
  await selectShow("Evening test show");
  await browser("wait", "text=Evening unique cue");
  assert.equal((await browser("eval", "document.body.textContent.includes('Morning unique cue')")).result, false);
  await selectShow("Display test show");
  await browser("wait", "text=Morning unique cue");

  // Keep the operator tab open while another tab changes the venue output.
  await browser("tab", "new", `${origin}/timer/${orgId}`);
  await browser("wait", "text=Morning held lyric");
  await browser("tab", "new", `${origin}/${orgId}/rundown?show=smoke-second-show`);
  await clickButton("Take live");
  await browser("wait", "text=Take Evening test show live?");
  await browser("click", '[role="dialog"] button:has-text("Take live")');
  await browser("wait", "text=Live output");
  await browser("tab", "1");
  await browser("wait", "text=Evening held lyric");
  assert.equal((await browser("eval", "document.body.textContent.includes('Morning held lyric')")).result, false);
  await browser("tab", "0");
  await clickButton("Refresh shows");
  await browser("wait", "text=Morning unique cue");
  assert.equal((await browser("get", "text", '[aria-label="Choose show"]')).text.includes("Display test show"), true);
  assert.equal((await state("smoke-show")).lyrics.lyrics, "Morning held lyric");
  assert.equal((await state("smoke-second-show")).lyrics.lyrics, "Evening held lyric");
  assert.equal((await state("smoke-show")).totalFrames, 30);
  assert.equal((await state("smoke-second-show")).totalFrames, 60);
  console.log(JSON.stringify({ login: "passed", sameDayCueIsolation: "passed", explicitShowSelection: "passed", activeChangeDoesNotRetargetOperator: "passed", confidenceFollowsVenueShow: "passed", bothLyricsPreserved: "passed", separateClocks: "passed" }, null, 2));
}, { secondShow: true });
