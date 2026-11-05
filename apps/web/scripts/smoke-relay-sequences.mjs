// Built app, real D1/relays and two browser tabs. Drops selected messages only
// in the disposable reader tab, to reproduce a gap without touching app code.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";

await withLocalSmokeFixture(async ({ origin, orgId, date, browser, queryFixture, operatorCookie, operatorEmail, operatorPassword }) => {
  const headers = { Cookie: operatorCookie, Origin: origin, "Content-Type": "application/json" };
  async function command(kind, action, payload) {
    if (kind === "timecode") {
      const { result } = await browser("eval", `fetch('/api/timecode/${orgId}/command?showId=smoke-show', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(${JSON.stringify({ action, payload })})}).then(async response => ({status:response.status, body:await response.json()}))`);
      assert.equal(result.status, 200); assert.equal(result.body.ok, true); return;
    }
    const response = await fetch(`${origin}/api/${kind}/${orgId}/command?showId=smoke-show&serviceDate=${date}`, { method: "POST", headers, body: JSON.stringify({ action, payload }) });
    assert.equal(response.status, 200); assert.equal((await response.json()).ok, true);
  }
  async function waitFor(check, label) {
    for (let i = 0; i < 50; i++) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail(label);
  }
  await command("rundown", "add-item", { id: "sequence-item", title: "Sequence fixture item", type: "segment", duration: 300000, notes: "", assignee: "", cue: "", hardStop: false });
  await browser("open", `${origin}/login`);

  await browser("fill", "#email", operatorEmail);
  await browser("fill", "#password", operatorPassword);
  await browser("find", "role", "button", "click", "--name", "Sign in", "--exact");
  await browser("wait", "--url", `**/${orgId}/**`);
  await browser("click", `a[href='/${orgId}/timecode']`);
  await browser("wait", "text=Start Internal Generator");
  await browser("eval", `(() => {
    const Native = window.WebSocket;
    window.fixtureSockets = []; window.fixtureResyncs = [];
    window.WebSocket = class extends Native {
      constructor(...args) { super(...args); window.fixtureSockets.push(this); }
      set onmessage(handler) {
        super.onmessage = event => {
          const message = JSON.parse(event.data);
          if (window.dropCueNote && this.url.includes('/cue-sheet/') && message.type === 'note') { window.dropCueNote = false; return; }
          if (window.dropTimecodeEvents && this.url.includes('/timecode/') && message.type === 'events-update') { window.dropTimecodeEvents = false; return; }
          handler?.call(this, event);
        };
      }
      get onmessage() { return super.onmessage; }
      send(data) { const message = JSON.parse(data); if (message.type === 'sync') window.fixtureResyncs.push(this.url); super.send(data); }
    };
    return true;
  })()`);
  for (const name of ["Evening test show", "Display test show"]) {
    await browser("find", "role", "button", "click", "--name", "Choose show", "--exact");
    await browser("click", `[role="menuitem"]:has-text("${name}")`);
    await waitFor(async () => (await browser("eval", "window.fixtureSockets.some(socket => socket.readyState === 1 && socket.url.includes('/timecode/'))")).result, "Selected show socket did not open");
  }
  assert.ok((await browser("eval", "window.fixtureSockets.some(socket => socket.url.includes('/timecode/'))")).result);
  await browser("find", "role", "button", "click", "--name", "Take control", "--exact");
  await browser("wait", "text=You control this show's timecode.");
  await browser("eval", "window.dropTimecodeEvents = true");
  await command("timecode", "add-event", { id: "recovered-cue", action: "lyrics-clear", label: "Recovered timeline cue", triggerTimecode: { hours: 0, minutes: 0, seconds: 20, frames: 0 }, payload: {} });
  assert.equal((await browser("eval", "document.body.textContent.includes('Recovered timeline cue')")).result, false);
  await command("timecode", "set-timecode", { timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 } });
  await browser("wait", "text=Recovered timeline cue");
  assert.ok((await browser("eval", "window.fixtureResyncs.some(url => url.includes('/timecode/'))")).result);

  await browser("click", `a[href='/${orgId}/production/cue-sheets']`);
  await browser("wait", "text=Sequence fixture item");
  await browser("wait", "text=Synced");
  await browser("eval", "document.querySelectorAll('table textarea').forEach((el,i) => el.dataset.testid = 'cue-' + i); true");
  assert.ok((await browser("eval", "document.querySelectorAll('table textarea').length >= 3")).result);
  await browser("eval", "window.dropCueNote = true");
  await browser("tab", "new", `${origin}/${orgId}/production/cue-sheets`);
  await browser("wait", "text=Sequence fixture item");
  await browser("wait", "text=Synced");
  await browser("eval", "document.querySelectorAll('table textarea').forEach((el,i) => el.dataset.testid = 'cue-' + i); true");
  await browser("fill", '[data-testid="cue-0"]', "Saved during the reader gap");
  await browser("click", "h1");
  await waitFor(async () => (await queryFixture("SELECT text FROM cue_note WHERE orgId='display-smoke' AND text='Saved during the reader gap'")).length === 1, "First note did not save");
  await browser("tab", "0");
  assert.equal((await browser("eval", "document.querySelector('[data-testid=cue-0]').value")).result, "");
  await browser("fill", '[data-testid="cue-2"]', "Draft held through resync");
  await browser("tab", "1");
  await browser("fill", '[data-testid="cue-1"]', "The next note reveals the gap");
  await browser("click", "h1");
  await browser("tab", "0");
  await waitFor(async () => (await browser("eval", "document.querySelector('[data-testid=cue-0]')?.value === 'Saved during the reader gap' && document.querySelector('[data-testid=cue-1]')?.value === 'The next note reveals the gap'")).result, "Reader did not reload missing D1 notes");
  assert.ok((await browser("eval", "window.fixtureResyncs.some(url => url.includes('/cue-sheet/'))")).result);
  assert.equal((await browser("eval", "document.querySelector('[data-testid=cue-2]').value")).result, "Draft held through resync");
  await browser("tab", "1");
  await browser("eval", `(() => {
    const nativeFetch = window.fetch;
    let rejectOne = true;
    window.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (rejectOne && method === 'POST' && url.includes('/_serverFn/')) { rejectOne = false; return Promise.resolve(new Response('Injected fixture failure', { status: 503 })); }
      return nativeFetch(input, init);
    };
    return true;
  })()`);
  await browser("fill", '[data-testid="cue-0"]', "Retained unsaved draft");
  await browser("click", "h1");
  await browser("wait", "text=Your edits are kept.");
  assert.equal((await queryFixture("SELECT text FROM cue_note WHERE text='Retained unsaved draft'")).length, 0);
  await browser("tab", "0");
  assert.equal((await browser("eval", "document.querySelector('[data-testid=cue-0]').value")).result, "Saved during the reader gap");
  await browser("tab", "1");
  await browser("find", "role", "button", "click", "--name", "Retry saves", "--exact");
  await waitFor(async () => (await queryFixture("SELECT text FROM cue_note WHERE text='Retained unsaved draft'")).length === 1, "Retried note did not save");
  await browser("tab", "0");
  await waitFor(async () => (await browser("eval", "document.querySelector('[data-testid=cue-0]')?.value === 'Retained unsaved draft'")).result, "Retried committed note did not reach reader");
  console.log(JSON.stringify({ login: "passed", timecodeGapRefresh: "passed", cueSheetGapReloadsD1: "passed", secondTabEdits: "passed", noManualReload: "passed", typingSurvivesRefresh: "passed", failedSaveRetainedAndRetried: "passed" }, null, 2));
}, { secondShow: true });
