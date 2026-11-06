// Real authentication, built Worker and disposable D1. No production writes.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll } from "./real-browser-fixture.mjs";
await withLocalSmokeFixture(async ({ origin, orgId, browser, operatorEmail, operatorPassword, queryFixture, stopServer, startServer }) => {
  const evaluate = async expression => (await browser("eval", expression)).result;
  const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
  const stored = async () => JSON.parse((await queryFixture(`SELECT value FROM app_setting WHERE orgId='${orgId}' AND key='active-graphics'`))[0]?.value ?? "[]");
  await browser("open", `${origin}/login`); await browser("fill", "#email", operatorEmail); await browser("fill", "#password", operatorPassword);
  await click("Sign in"); await browser("wait", "--url", `**/${orgId}/**`);
  await browser("open", `${origin}/${orgId}/streaming/graphics`);
  await browser("wait", 'button[aria-label="Hide Fixture overlay title"]:not(:disabled)');
  await stopServer();
  await browser("wait", '[role="alert"][aria-label="Refresh graphics output"] time');
  assert.equal(await evaluate("document.querySelector('button[aria-label=\"Hide Fixture overlay title\"]').disabled"), true);
  assert.equal(await evaluate("document.body.textContent.includes('last confirmed on air')"), true);
  assert.equal(await evaluate("[...document.querySelectorAll('button')].find(el => el.textContent.trim() === 'Clear all').disabled"), false, "Explicit stop-all stays available");
  await browser("set", "viewport", "320", "740");
  await browser("scrollintoview", 'button[aria-label="Refresh graphics output"]');
  const bounds = await evaluate("(() => { const el = document.querySelector('button[aria-label=\"Refresh graphics output\"]'); const r = el.getBoundingClientRect(); return {left:r.left,right:r.right,height:r.height,reachable:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('button')===el}; })()");
  assert.ok(bounds.left >= 0 && bounds.right <= 320 && bounds.height >= 44 && bounds.reachable, JSON.stringify(bounds));
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  await browser("screenshot", "/tmp/showpilot-graphics-output-320.png");
  await browser("scrollintoview", 'button[aria-label="Hide Fixture overlay title"]');
  const pageFits = await evaluate("(() => { let el = document.querySelector('h1'); while(el && !(el.classList.contains('h-full') && el.classList.contains('overflow-auto'))) el = el.parentElement; return el && el.scrollWidth <= el.clientWidth; })()");
  await browser("screenshot", "/tmp/showpilot-graphics-output-card-320.png");
  assert.ok(pageFits, "Graphics workspace must not scroll horizontally");
  const stopBounds = await evaluate("(() => { const el = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === 'Clear all'); const r = el.getBoundingClientRect(); return {left:r.left,right:r.right,height:r.height,reachable:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('button')===el}; })()");
  assert.ok(stopBounds.left >= 0 && stopBounds.right <= 320 && stopBounds.height >= 44 && stopBounds.reachable, JSON.stringify(stopBounds));
  await click("Refresh graphics output");
  await startServer(); await evaluate("document.querySelector('button[aria-label=\"Refresh graphics output\"]')?.click()");
  await browser("wait", 'button[aria-label="Hide Fixture overlay title"]:not(:disabled)');
  await browser("wait", "--fn", "!document.querySelector('[role=\"alert\"][aria-label=\"Refresh graphics output\"]')");
  await browser("set", "viewport", "1440", "900");
  // Hold one real completed read to deliver it after a newer output mutation.
  await evaluate(`(() => {
    const original = window.fetch; window.__holdGraphicRead = true; window.__lostGraphicPost = false; window.__graphicPosts = [];
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const post = init?.method === 'POST' && url.includes('/_serverFn/');
      if (post) window.__graphicPosts.push(init.body);
      const response = await original(input, init);
      if (post && window.__lostGraphicPost && response.ok) { window.__lostGraphicPost = false; await response.text(); throw new TypeError('Fixture lost output acknowledgement after commit'); }
      if (!post && window.__holdGraphicRead && url.includes('/_serverFn/') && (await response.clone().text()).includes('smoke-graphic')) {
        window.__holdGraphicRead = false;
        return new Promise(resolve => { window.__releaseGraphicRead = () => resolve(response); });
      }
      return response;
    }; return true;
  })()`);
  await browser("wait", "--fn", "typeof window.__releaseGraphicRead === 'function'");
  await click("Hide Fixture overlay title");
  await browser("wait", 'button[aria-label="Show Fixture overlay title"]:not(:disabled)');
  await evaluate("window.__releaseGraphicRead(); true");
  await browser("wait", "250");
  assert.equal(await evaluate("document.querySelector('button[aria-label=\"Show Fixture overlay title\"]') !== null"), true, "Old on-air read must not overwrite the hide acknowledgement");
  assert.deepEqual(await stored(), []);
  await click("Show Fixture overlay title"); await browser("wait", 'button[aria-label="Hide Fixture overlay title"]:not(:disabled)');
  const beforeLost = (await evaluate("window.__graphicPosts")).length;
  await evaluate("window.__lostGraphicPost = true");
  await click("Hide Fixture overlay title");
  await browser("wait", '[aria-label="Graphics change confirmation"] time');
  await browser("wait", 'button[aria-label="Show Fixture overlay title"]:not(:disabled)');
  assert.deepEqual(await stored(), []);
  await browser("wait", "2500");
  assert.equal((await evaluate("window.__graphicPosts")).length, beforeLost + 1, "Recovery must read state without replaying the write");
  await click("Show Fixture overlay title");
  await browser("wait", 'button[aria-label="Hide Fixture overlay title"]:not(:disabled)');
  await browser("wait", "--fn", "!document.querySelector('[aria-label=\"Graphics change confirmation\"]')");
  await click("Clear all");
  await browser("wait", 'button[aria-label="Show Fixture overlay title"]:not(:disabled)');
  await poll(async () => (await stored()).length === 0, "clear persisted");
  assert.equal(await evaluate("[...document.querySelectorAll('button')].some(el => el.textContent.trim() === 'Clear all' && !el.disabled)"), true, "Stop-all stays reachable even when the last confirmed output is empty");
  console.log(JSON.stringify({passed:true,realWorkerOutage:true,lastConfirmedStateVisible:true,readRecovery:true,stopAllAvailable:true,lateReadCannotOverwriteWrite:true,lostAcknowledgementAfterCommit:true,reconcileWithoutReplay:true,clearConfirmed:true,fits320:true}));
});
