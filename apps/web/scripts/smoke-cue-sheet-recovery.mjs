// Real Worker/D1 outage and delayed read responses in a disposable browser only.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll } from "./real-browser-fixture.mjs";

await withLocalSmokeFixture(async ({ origin, orgId, date, browser, operatorCookie, operatorEmail, operatorPassword, queryFixture, stopServer, startServer }) => {
  const evaluate = async expression => (await browser("eval", expression)).result;
  const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
  const headers = { Cookie: operatorCookie, Origin: origin, "Content-Type": "application/json" };
  for (const [show, id, title] of [["smoke-show", "cue-recovery", "Retained cue fixture"], ["smoke-second-show", "cue-second", "Second show cue fixture"]]) {
    const response = await fetch(`${origin}/api/rundown/${orgId}/command?showId=${show}&serviceDate=${date}`, { method: "POST", headers, body: JSON.stringify({ action: "add-item", payload: { id, title, type: "segment", duration: 300000, notes: "", assignee: "", cue: "", hardStop: false } }) });
    assert.equal(response.status, 200); assert.equal((await response.json()).ok, true);
  }
  await browser("open", `${origin}/login`); await browser("fill", "#email", operatorEmail); await browser("fill", "#password", operatorPassword); await click("Sign in");
  await browser("wait", "--url", `**/${orgId}/**`);
  await evaluate(`(() => {
    const Native = WebSocket; window.cueSockets = [];
    window.WebSocket = class extends Native {
      constructor(...args) { super(...args); if (String(args[0]).includes('/cue-sheet/')) window.cueSockets.push(this); }
    };
    const nativeFetch = window.fetch; window.cuePosts = 0; window.cuePostCalls = []; window.cueDelayed = []; window.cueReadSignals = [];
    window.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (url.includes('/_serverFn/')) {
        if (method === 'POST' && typeof init?.body === 'string' && ['columnId', 'itemId', 'text'].every(key => init.body.includes(key))) {
          window.cuePosts++; window.cuePostCalls.push({url,body:typeof init?.body === "string" ? init.body : "request body"});
          if (window.cueRejectWrite) { window.cueRejectWrite = false; return Promise.resolve(new Response('Fixture write failure', { status: 503 })); }
        }
        if (method === 'GET' && window.cueDelayReads) {
          // Capture a real response, deliberately ignore cancellation, and
          // release it after the UI's deadline to exercise stale-result guards.
          window.cueReadSignals.push(init?.signal ?? (input instanceof Request ? input.signal : null));
          const response = nativeFetch(input, init);
          return new Promise(resolve => window.cueDelayed.push(async () => resolve(await response)));
        }
      }
      return nativeFetch(input, init);
    }; return true;
  })()`);
  await browser("click", `a[href='/${orgId}/production/cue-sheets']`);
  await browser("wait", "text=Synced");
  // Seeding the second relay can make it the active show. Choose explicitly.
  await click("Choose show"); await browser("click", '[role="menuitem"]:has-text("Display test show")');
  await browser("wait", "text=Retained cue fixture"); await browser("wait", "text=Synced");
  await evaluate("document.querySelectorAll('table textarea').forEach((node, index) => node.dataset.testid = 'recovery-note-' + index); true");
  await browser("fill", '[data-testid="recovery-note-0"]', "Confirmed cue note"); await browser("click", "h1");
  await poll(async () => (await queryFixture("SELECT text FROM cue_note WHERE orgId='display-smoke' AND text='Confirmed cue note'")).length === 1, "confirmed cue note");
  await evaluate("window.cueRejectWrite = true");
  await browser("fill", '[data-testid="recovery-note-1"]', "Keep this unsaved cue"); await browser("click", "h1");
  await browser("wait", "text=Your edits are kept.");
  const writesBeforeOutage = await evaluate("window.cuePosts");
  assert.equal(writesBeforeOutage, 2, "both cue-note writes were observed");
  await stopServer();
  await browser("wait", 'header [role="alert"] time');
  await browser("wait", "text=Reconnecting…");
  assert.equal(await evaluate("document.querySelector('[data-testid=recovery-note-0]').value"), "Confirmed cue note");
  assert.equal(await evaluate("document.querySelector('[data-testid=recovery-note-1]').value"), "Keep this unsaved cue");
  await browser("set", "viewport", "320", "740");
  await browser("scrollintoview", 'header button:text-is("Retry")');
  const bounds = await evaluate(`(() => { const node = [...document.querySelectorAll('header button')].find(node => node.textContent === 'Retry'); const r = node.getBoundingClientRect(); return {left:r.left,right:r.right,width:r.width,height:r.height,reachable:node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}; })()`);
  assert.ok(bounds.left >= 0 && bounds.right <= 320 && bounds.height >= 44 && bounds.reachable, JSON.stringify(bounds));
  await browser("screenshot", "/tmp/showpilot-cue-recovery-320.png");
  const socketsBeforeRetry = await evaluate("window.cueSockets.length");
  await click("Retry");
  assert.ok(await evaluate(`window.cueSockets.length > ${socketsBeforeRetry}`), "Retry opens a fresh connection immediately");
  await startServer();
  await browser("wait", "text=Synced");
  console.log("Outage, manual reconnect and recovery passed");
  assert.equal(await evaluate("window.cuePosts"), writesBeforeOutage, "reconnect must not replay a write: " + JSON.stringify(await evaluate("window.cuePostCalls")));
  assert.equal(await evaluate("document.querySelector('[data-testid=recovery-note-1]').value"), "Keep this unsaved cue");
  assert.equal((await queryFixture("SELECT text FROM cue_note WHERE orgId='display-smoke' AND text='Keep this unsaved cue'")).length, 0);
  await browser("set", "viewport", "1440", "900");
  await click("Retry saves");
  await poll(async () => (await queryFixture("SELECT text FROM cue_note WHERE orgId='display-smoke' AND text='Keep this unsaved cue'")).length === 1, "explicit retry saves the retained note");
  await browser("wait", "--fn", "!document.body.textContent.includes('Your edits are kept.')");

  console.log("Explicit retained-note save passed");

  // A delayed read must stop loading, retain the last sheet, and keep its error
  // even when that old response eventually arrives. Retry reads confirmed data.
  await evaluate("window.cueDelayReads = true; window.cueSockets.at(-1).close(); true");
  await poll(async () => await evaluate("window.cueDelayed.length > 0"), "held read response");
  await browser("wait", "text=Cue sheet refresh timed out.");
  assert.equal(await evaluate("document.querySelector('[aria-busy=true]') !== null"), false);
  assert.equal(await evaluate("document.querySelector('[data-testid=recovery-note-0]').value"), "Confirmed cue note");
  assert.equal(await evaluate("window.cueReadSignals.some(signal => signal?.aborted)"), true);
  await evaluate("window.cueDelayReads = false; Promise.all(window.cueDelayed.splice(0).map(release => release())).then(() => true)");
  assert.equal(await evaluate("document.body.textContent.includes('Cue sheet refresh timed out.')"), true);
  await evaluate(`(() => { const retry = [...document.querySelectorAll('header button')].find(node => node.textContent === 'Retry'); if (retry && !retry.disabled) retry.click(); return true; })()`);
  await browser("wait", "text=Synced");
  assert.equal(await evaluate("document.body.textContent.includes('Cue sheet refresh timed out.')"), false);

  console.log("Timeout and late response checks passed");

  // A read for a previous selection must not replace the next show's sheet.
  await evaluate("window.cueDelayReads = true; window.cueSockets.at(-1).close(); true");
  await poll(async () => await evaluate("window.cueDelayed.length > 0"), "old show request");
  await evaluate("window.cueDelayReads = false");
  await click("Choose show"); await browser("click", '[role="menuitem"]:has-text("Evening test show")');
  await browser("wait", "text=Second show cue fixture"); await browser("wait", "text=Synced");
  await evaluate("Promise.all(window.cueDelayed.splice(0).map(release => release())).then(() => true)");
  assert.equal(await evaluate("document.querySelector('table').textContent.includes('Second show cue fixture')"), true);
  assert.equal(await evaluate("document.querySelector('table').textContent.includes('Retained cue fixture')"), false);
  const errors = await browser("errors"); assert.deepEqual(errors.errors, []);
  console.log(JSON.stringify({ passed: true, realWorkerOutage: true, retainedConfirmedAndUnsavedNotes: true, timestampedError: true, retryFits320: true, reconnectNeverReplaysWrites: true, explicitSaveRetry: true, boundedReadAborted: true, lateResponseIgnored: true, showSwitchRejectsOldRead: true, pageErrors: errors.errors }));
}, { secondShow: true });
