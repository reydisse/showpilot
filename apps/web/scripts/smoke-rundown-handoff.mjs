// Built browser/Worker with real authentication and relay persistence. No production data.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll } from "./real-browser-fixture.mjs";
await withLocalSmokeFixture(async ({ origin, orgId, date, browser, operatorCookie, operatorEmail, operatorPassword }) => {
  const evaluate = async expression => (await browser("eval", expression)).result;
  const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
  const state = async () => (await fetch(`${origin}/api/rundown/${orgId}/state?showId=smoke-show&serviceDate=${date}`, { headers: { Cookie: operatorCookie } })).json();
  await browser("open", `${origin}/login`); await browser("fill", "#email", operatorEmail); await browser("fill", "#password", operatorPassword);
  await click("Sign in"); await browser("wait", "--url", `**/${orgId}/**`);
  await browser("open", `${origin}/${orgId}/rundown?show=smoke-show&date=${date}`);
  await browser("wait", 'input[placeholder="Message to stage display..."]');
  await browser("wait", "--fn", "!document.body.innerText.includes('Offline,')");
  await evaluate(`(() => {
    const send = WebSocket.prototype.send; const request = window.fetch.bind(window);
    window.__queuedFixtureCommands = []; window.__handoffFixtureRequests = [];
    WebSocket.prototype.send = function(data) {
      let command; try { command = JSON.parse(data); } catch {}
      if (command?.type === 'command' && command.action === 'stage-message' && command.payload?.message.startsWith('Handoff fixture')) {
        window.__queuedFixtureCommands.push(command); return;
      }
      return send.call(this, data);
    };
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const handoff = url.includes('/api/rundown/') && url.includes('/command') && init?.keepalive;
      if (handoff) window.__handoffFixtureRequests.push(JSON.parse(init.body));
      const response = await request(input, init);
      if (handoff && response.ok) { await response.text(); throw new TypeError('Fixture lost acknowledgement after commit'); }
      return response;
    }; return true;
  })()`);
  await browser("fill", 'input[placeholder="Message to stage display..."]', "Handoff fixture first"); await click("Send stage message");
  await browser("fill", 'input[placeholder="Message to stage display..."]', "Handoff fixture later"); await click("Send stage message");
  assert.equal((await evaluate("window.__queuedFixtureCommands")).length, 1, "Only the first queued command may be in flight");
  await browser("find", "role", "link", "click", "--name", "Songs", "--exact");
  await browser("wait", "--url", "**/songs");
  await browser("wait", '[aria-label="Rundown changes"] [role="alert"]');
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Rundown changes\"]').innerText.includes('2 rundown changes need review')"), true);
  assert.ok(await evaluate("document.querySelector('[aria-label=\"Rundown changes\"] time')?.dateTime"));
  assert.equal(await evaluate("window.__handoffFixtureRequests.length"), 1, "An uncertain response must stop subsequent commands");
  const original = (await evaluate("window.__queuedFixtureCommands"))[0];
  const handedOff = (await evaluate("window.__handoffFixtureRequests"))[0];
  assert.equal(handedOff.id, original.id); assert.equal(handedOff.expectedRevision, original.expectedRevision);
  await poll(async () => (await state()).stageMessage === "Handoff fixture first", "first command persisted before acknowledgement was lost");
  const committedRevision = (await state()).revision;
  await browser("find", "role", "link", "click", "--name", "Crew status", "--exact");
  await browser("wait", "--url", "**/board");
  await browser("wait", '[aria-label="Rundown changes"] [role="alert"]');
  await browser("open", `${origin}/${orgId}/songs`);
  await browser("wait", '[aria-label="Rundown changes"] [role="alert"]');
  const metadata = await evaluate(`sessionStorage.getItem('showpilot:rundown-handoff:${orgId}')`);
  assert.ok(metadata); assert.equal(metadata.includes("Handoff fixture"), false);
  await browser("set", "viewport", "320", "740");
  const layout = await evaluate(`(() => {
    const notice = document.querySelector('[aria-label="Rundown changes"]');
    return { fits: notice.scrollWidth <= notice.clientWidth + 1, controls: [...notice.querySelectorAll('a,button')].map(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })) };
  })()`);
  assert.ok(layout.fits && layout.controls.every(control => control.width >= 44 && control.height >= 44), JSON.stringify(layout));
  await browser("screenshot", "/tmp/showpilot-rundown-handoff-320.png");
  await browser("find", "role", "link", "click", "--name", "Review rundown", "--exact");
  await browser("wait", "--url", "**/rundown?**");
  const reviewed = new URL((await browser("get", "url")).url);
  assert.equal(reviewed.searchParams.get("show"), "smoke-show"); assert.equal(reviewed.searchParams.get("date"), date);
  await browser("wait", 'input[placeholder="Message to stage display..."]');
  assert.equal((await state()).stageMessage, "Handoff fixture first");
  assert.equal((await state()).revision, committedRevision, "Review must not replay either command");
  await click("Dismiss notice");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Rundown changes\"]') === null"), true);
  assert.equal(await evaluate(`sessionStorage.getItem('showpilot:rundown-handoff:${orgId}')`), null);
  // A full navigation does not run React route cleanup. pagehide must save
  // the notice synchronously and submit the same idempotent command once.
  await evaluate(`(() => {
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) {
      let command; try { command = JSON.parse(data); } catch {}
      if (command?.type === 'command' && command.action === 'stage-message' && command.payload?.message === 'Handoff fixture unload') return;
      return send.call(this, data);
    }; return true;
  })()`);
  await browser("fill", 'input[placeholder="Message to stage display..."]', "Handoff fixture unload"); await click("Send stage message");
  await browser("open", `${origin}/${orgId}/songs`);
  // Completion may arrive before the old document closes. Either a confirmed
  // commit clears the notice, or an interrupted notice remains for review.
  await poll(async () => (await state()).stageMessage === "Handoff fixture unload", "pagehide HTTP command persisted");
  const persistedNotice = await evaluate(`sessionStorage.getItem('showpilot:rundown-handoff:${orgId}')`);
  if (persistedNotice) {
    await browser("wait", '[aria-label="Rundown changes"] [role="alert"]');
    assert.equal(JSON.parse(persistedNotice).length, 1);
  }
  console.log(JSON.stringify({ pagehideSubmitsOnce: true, standaloneNoticeVisible: true, passed: true, realNavigationHandoff: true, realCommitBeforeLostResponse: true, sameCommandIdAndRevision: true, subsequentChangeStopped: true, noticeSurvivesReload: true, noPayloadStored: true, reviewPreservesTarget: true, noReplayOnReview: true, fits320: true }));
});
