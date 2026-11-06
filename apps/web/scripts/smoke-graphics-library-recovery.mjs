// Real login and disposable D1; lose responses after actual mutation commits.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll } from "./real-browser-fixture.mjs";
await withLocalSmokeFixture(async ({ origin, orgId, browser, operatorEmail, operatorPassword, queryFixture }) => {
  const evaluate = async expression => (await browser("eval", expression)).result;
  const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
  const rows = () => queryFixture(`SELECT id,title FROM graphic_template WHERE orgId='${orgId}' AND name='Recovery fixture'`);
  await browser("open", `${origin}/login`); await browser("fill", "#email", operatorEmail); await browser("fill", "#password", operatorPassword);
  await click("Sign in"); await browser("wait", "--url", `**/${orgId}/**`);
  await browser("open", `${origin}/${orgId}/streaming/graphics`);
  await browser("wait", 'button[aria-label="Hide Fixture overlay title"]:not(:disabled)');
  await evaluate(`(() => {
    const original = window.fetch; window.__libraryPosts = []; window.__loseLibraryResponse = false;
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const post = init?.method === 'POST' && url.includes('/_serverFn/');
      if (post) window.__libraryPosts.push(init.body);
      const response = await original(input, init);
      if (post && window.__loseLibraryResponse && response.ok) {
        window.__loseLibraryResponse = false; await response.text(); throw new TypeError('Fixture lost library acknowledgement after commit');
      }
      return response;
    }; return true;
  })()`);
  // Cancel output and destructive confirmation without issuing a mutation.
  const before = (await evaluate("window.__libraryPosts")).length;
  await click("Hide Fixture overlay title"); await click("Cancel");
  await click("Delete Fixture overlay title"); await click("Cancel");
  assert.equal((await evaluate("window.__libraryPosts")).length, before);
  await click("New Graphic"); await browser("wait", "#graphic-title");
  await browser("fill", "#graphic-name", "Recovery fixture"); await browser("fill", "#graphic-title", "Original graphic");
  for (const [width,height] of [[320,480],[768,900],[1440,900]]) {
    await browser("set", "viewport", String(width), String(height));
    const bounds = await evaluate(`(() => { const el = document.querySelector('[role="dialog"]'); const r = el.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,fits:el.scrollWidth<=el.clientWidth}; })()`);
    assert.ok(bounds.left >= 0 && bounds.right <= width && bounds.top >= 0 && bounds.bottom <= height && bounds.fits, JSON.stringify(bounds));
    await browser("scrollintoview", '[role="dialog"] button[type="submit"]');
    const hit = await evaluate(`(() => { const el=document.querySelector('[role="dialog"] button[type="submit"]'); const r=el.getBoundingClientRect(); return r.height>=44 && document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('button')===el; })()`);
    assert.ok(hit, `Create must be reachable at ${width}x${height}`);
  }
  await browser("set", "viewport", "320", "480");
  await evaluate("window.__loseLibraryResponse = true"); await click("Create");
  await browser("wait", '[aria-label="Graphics library confirmation"] time');
  assert.equal((await rows()).length, 1);
  assert.equal(await evaluate("document.querySelector('#graphic-title').closest('fieldset').disabled"), true);
  await browser("scrollintoview", '[aria-label="Graphics library confirmation"]');
  await browser("screenshot", "/tmp/showpilot-graphics-library-retry-320.png");
  const firstPosts = await evaluate("window.__libraryPosts");
  await click("Retry library change");
  await browser("wait", "--fn", "!document.querySelector('[role=\"dialog\"]')");
  await browser("wait", 'button[aria-label="Edit Original graphic"]');
  const retriedPosts = await evaluate("window.__libraryPosts");
  assert.equal(retriedPosts.at(-1), firstPosts.at(-1), "Retry must send exactly the captured request");
  assert.equal((await rows()).length, 1);
  await browser("set", "viewport", "1440", "900");
  // A completed library read arrives late, after a newer update acknowledgement.
  await evaluate(`(() => {
    const original = window.fetch; window.__holdLibraryRead = true;
    window.fetch = async (input, init) => {
      const response = await original(input, init);
      if (init?.method !== 'POST' && window.__holdLibraryRead && (await response.clone().text()).includes('Recovery fixture')) {
        window.__holdLibraryRead = false;
        return new Promise(resolve => { window.__releaseLibraryRead = () => resolve(response); });
      }
      return response;
    }; return true;
  })()`);
  await click("New Graphic"); await browser("wait", "#graphic-title"); await browser("press", "Escape");
  await browser("wait", "--fn", "typeof window.__releaseLibraryRead === 'function'");
  // Editing warns that a live graphic changes immediately and has the same safe retry.
  await click("Edit Original graphic"); await browser("fill", "#graphic-title", "Updated graphic");
  await click("Update"); await click("Cancel");
  assert.equal((await rows())[0].title, "Original graphic");
  await click("Update"); await evaluate("window.__loseLibraryResponse = true"); await click("Update graphic");
  await browser("wait", '[aria-label="Graphics library confirmation"] time');
  assert.equal((await rows())[0].title, "Updated graphic");
  await click("Retry library change"); await browser("wait", 'button[aria-label="Edit Updated graphic"]');
  await evaluate("window.__releaseLibraryRead(); true");
  await browser("wait", "250");
  assert.equal(await evaluate("!!document.querySelector('button[aria-label=\"Edit Updated graphic\"]')"), true, "Old library read cannot overwrite the saved edit");
  // An uncertain delete remains visible until its receipt is acknowledged.
  await click("Delete Updated graphic"); await evaluate("window.__loseLibraryResponse = true"); await click("Delete graphic");
  await browser("wait", '[aria-label="Graphics library confirmation"] time');
  assert.equal((await rows()).length, 0);
  await click("Retry library change");
  await browser("wait", "--fn", "!document.querySelector('button[aria-label=\"Edit Updated graphic\"]')");
  await poll(async () => (await rows()).length === 0, "deleted graphic stays deleted");
  // Shared Dialog responds to Escape; it does not leave an invisible overlay behind.
  await click("New Graphic"); await browser("wait", "#graphic-title"); await browser("press", "Escape");
  await browser("wait", "--fn", "!document.querySelector('[role=\"dialog\"]')");
  console.log(JSON.stringify({passed:true,realD1:true,cancelDoesNotWrite:true,lostCreateUpdateDeleteResponses:true,retryUsesSameRequest:true,noDuplicateCreate:true,dialogFits320x480:true,escapeCloses:true,lateLibraryReadIgnored:true}));
});
