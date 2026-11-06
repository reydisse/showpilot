// Built browser and Worker, disposable organization only. No production writes.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll } from "./real-browser-fixture.mjs";

await withLocalSmokeFixture(async ({ origin, orgId, date, browser, operatorCookie, operatorEmail, operatorPassword, stopServer, startServer }) => {
  const evaluate = async expression => (await browser("eval", expression)).result;
  const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
  const command = async (action, payload) => {
    const response = await fetch(`${origin}/api/rundown/${orgId}/command?showId=smoke-show&serviceDate=${date}`, { method: "POST", headers: { Cookie: operatorCookie, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ action, payload }) });
    assert.equal(response.status, 200); assert.equal((await response.json()).ok, true);
  };
  await command("add-item", { id: "read-recovery-item", title: "Retained show fixture", type: "segment", duration: 300000, notes: "", assignee: "", cue: "", hardStop: false });
  await command("timer-start", { itemId: "read-recovery-item" });
  await browser("open", `${origin}/login`); await browser("fill", "#email", operatorEmail); await browser("fill", "#password", operatorPassword);
  await click("Sign in"); await browser("wait", "--url", `**/${orgId}/**`);
  await browser("open", `${origin}/${orgId}/show`);
  await browser("wait", "--fn", "document.querySelector('.show-page-header')?.innerText.includes('Live') && document.querySelector('[aria-label=\"Show timer\"]')?.textContent.includes(':')");
  const timer = () => evaluate("document.querySelector('[aria-label=\"Show timer\"]')?.textContent");
  const initial = await timer();
  await poll(async () => (await timer()) !== initial, "confirmed timer advances");
  await stopServer();
  await browser("wait", '[role="alert"][aria-label="Retry crew status"] time');
  await browser("wait", '[role="alert"][aria-label="Retry show selection"] time');
  await browser("wait", '[role="alert"][aria-label="Reconnect show"] time');
  assert.equal(await evaluate("document.querySelector('.show-page-header').innerText.includes('Reconnecting')"), true);
  assert.equal(await evaluate("document.body.textContent.includes('Retained show fixture') && document.body.textContent.includes('Last confirmed:')"), true);
  const held = await timer();
  await browser("wait", "2200");
  assert.equal(await timer(), held, "unconfirmed timer must hold its displayed value");
  await browser("set", "viewport", "320", "740");
  for (const label of ["Retry crew status", "Retry show selection", "Reconnect show"]) {
    await evaluate(`document.querySelector('button[aria-label=${JSON.stringify(label)}]').scrollIntoView({block:'nearest'})`);
    const bounds = await evaluate(`(() => { const el = document.querySelector('button[aria-label=${JSON.stringify(label)}]'); const r = el.getBoundingClientRect(); return { left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height,width:r.width, reachable:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('button') === el }; })()`);
    assert.ok(bounds.left >= 0 && bounds.right <= 320 && bounds.height >= 44 && bounds.width >= 44 && bounds.top >= 0 && bounds.bottom <= 740 && bounds.reachable, JSON.stringify({ label, bounds }));
  }
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  await browser("screenshot", "/tmp/showpilot-operator-read-320.png");
  await evaluate("document.querySelector('[aria-label=\"Show timer\"]').scrollIntoView({block:'center'})");
  const timerBounds = await evaluate("(() => { const r = document.querySelector('[aria-label=\"Show timer\"]').getBoundingClientRect(); return {top:r.top,bottom:r.bottom,height:r.height}; })()");
  assert.ok(timerBounds.top >= 0 && timerBounds.bottom <= 740 && timerBounds.height >= 44, JSON.stringify(timerBounds));
  await browser("screenshot", "/tmp/showpilot-operator-read-timer-320.png");
  await startServer();
  // Automatic recovery can win the race; exercise manual retry while its failure remains.
  for (const label of ["Retry crew status", "Retry show selection", "Reconnect show"]) {
    await evaluate(`document.querySelector('button[aria-label=${JSON.stringify(label)}]')?.click()`);
  }
  await browser("wait", "--fn", "document.querySelector('.show-page-header')?.innerText.includes('Live') && !document.querySelector('[role=\"alert\"][aria-label=\"Retry crew status\"]') && !document.querySelector('[role=\"alert\"][aria-label=\"Retry show selection\"]')");
  const recovered = await timer();
  await poll(async () => (await timer()) !== recovered, "timer resumes after confirmed recovery");
  for (const [width, height] of [[320,480], [768,900], [1440,900]]) {
    await browser("set", "viewport", String(width), String(height));
    await evaluate("document.querySelector('[aria-label=\"Show timer\"]').scrollIntoView({block:'center'})");
    const layout = await evaluate("(() => { const el = document.querySelector('[aria-label=\"Show timer\"]'); const r = el.getBoundingClientRect(); return { horizontalFits:document.documentElement.scrollWidth<=innerWidth, visible:r.top>=0 && r.bottom<=innerHeight, reachable:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2) === el }; })()");
    assert.ok(layout.horizontalFits && layout.visible && layout.reachable, JSON.stringify({width,height,layout}));
  }
  await browser("open", `${origin}/${orgId}/rundown?show=smoke-show&date=${date}`);
  await browser("wait", '[data-rundown-item-id="read-recovery-item"]');
  await browser("wait", "--fn", "[...document.querySelectorAll('button')].some(el => el.textContent.trim() === 'Pause' && !el.disabled)");
  await stopServer();
  // Returning to the tab refreshes the one-shot PP configuration, including when
  // there is no configured host and its normal controls therefore are absent.
  await evaluate("document.dispatchEvent(new Event('visibilitychange')); true");
  await browser("wait", '[role="alert"][aria-label="Retry ProPresenter configuration"] time');
  await browser("set", "viewport", "320", "740");
  await evaluate("document.querySelector('button[aria-label=\"Retry ProPresenter configuration\"]').scrollIntoView({block:'nearest'})");
  const ppBounds = await evaluate("(() => { const r = document.querySelector('button[aria-label=\"Retry ProPresenter configuration\"]').getBoundingClientRect(); return {left:r.left,right:r.right,height:r.height}; })()");
  assert.ok(ppBounds.left >= 0 && ppBounds.right <= 320 && ppBounds.height >= 44, JSON.stringify(ppBounds));
  await startServer(); await click("Retry ProPresenter configuration");
  await browser("wait", "--fn", "!document.querySelector('[role=\"alert\"][aria-label=\"Retry ProPresenter configuration\"]')");
  console.log(JSON.stringify({ passed: true, realWorkerOutage: true, retainedShow: true, timerHoldsDuringDisconnect: true, timerResumesAfterConfirmation: true, timestampedCrewAndSelectionFailures: true, recoveryWithoutReload: true, configurationRetryWithoutHost: true, retryControlsFit320: true }));
});
