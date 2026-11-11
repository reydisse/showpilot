// Real empty-library entry points in the compiled app, using disposable D1/auth.
// Stream creation is opened but never submitted: no paid ingest is provisioned.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";

const audit = process.argv.includes("--audit");
const findings = [];
await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie }) => {
  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    await page("Emulation.setFocusEmulationEnabled", { enabled: true });
    await page("Page.enable");
    await page("Page.addScriptToEvaluateOnNewDocument", { source: "window.emptyActionErrors=[];addEventListener('error',e=>window.emptyActionErrors.push(e.message));addEventListener('unhandledrejection',e=>window.emptyActionErrors.push(String(e.reason)));" });
    const check = (code, label) => poll(() => evaluate(code), label).catch(async error => {
      console.log(JSON.stringify({ label, body: await evaluate("document.body?.innerText"), errors: await evaluate("window.emptyActionErrors") }));
      throw error;
    });
    const buttons = names => `[...document.querySelectorAll('button,a')].filter(n=>${JSON.stringify(names)}.includes(n.getAttribute('aria-label')||n.textContent.trim())&&n.getBoundingClientRect().height>0)`;
    const click = async name => {
      const position = await check(`(async()=>{const n=${buttons([name])}.at(-1);if(!n||n.disabled||!Object.keys(n).some(k=>k.startsWith('__reactProps')))return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`, `click ${name}`);
      await page("Input.dispatchMouseEvent", { type: "mousePressed", ...position, button: "left", clickCount: 1 });
      await page("Input.dispatchMouseEvent", { type: "mouseReleased", ...position, button: "left", clickCount: 1 });
    };
    const navigate = async path => {
      await page("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
      await page("Page.navigate", { url: `${origin}/${orgId}/${path}` });
    };
    // The fixture starts with one graphic. Prove the populated header is usable,
    // then delete that disposable graphic through its real confirmation dialog.
    await navigate("streaming/graphics");
    await click("New Graphic");
    await check("!!document.querySelector('[aria-label=\"Close graphic editor\"]')", "populated graphic editor");
    await click("Close graphic editor");
    await click("Delete Fixture overlay title");
    await click("Delete graphic");
    await check("document.body?.innerText.includes('No graphics yet')", "last graphic removed");

    const routes = [
      { path: "songs", empty: "Build your first lyrics cue map", actions: ["Import from ProPresenter", "New song"], primary: "Import from ProPresenter", form: '[role="dialog"]', close: "Close import" },
      { path: "streaming/health", empty: "No live inputs configured", actions: ["Add Input", "Create Live Input"], primary: "Create Live Input", form: '[aria-label="Close live input editor"]', close: "Close live input editor" },
      { path: "streaming/graphics", empty: "No graphics yet", actions: ["New Graphic", "Create first graphic"], primary: "Create first graphic", form: '[aria-label="Close graphic editor"]', close: "Close graphic editor" },
      { path: "dashboard/audio", empty: "No channels assigned", actions: ["Add Channel", "Add First Channel"], primary: "Add First Channel", form: 'form', close: "Cancel" },
      { path: "dashboard/devices", empty: "No devices registered", actions: ["Add Device", "Add First Device"], primary: "Add Device", form: '#device-name', close: "Cancel" },
      { path: "streaming/platforms", empty: "No streaming destinations", actions: ["Add Destination", "Go Live"], primary: "Add Destination", form: 'form', close: "Cancel" },
      { path: "board", empty: "Crew status is ready", actions: ["Add Team Members"], primary: "Add Team Members" },
    ];
    for (const route of routes) {
      await navigate(route.path);
      await check(`document.body?.innerText.includes(${JSON.stringify(route.empty)})`, route.empty);
      // The server's empty state can be replaced by the first client refresh.
      // Count actions once that refresh has completed and the action is usable.
      const { count } = await check(`(() => {const primary=${buttons([route.primary])}.at(-1);return primary&&!primary.disabled&&Object.keys(primary).some(k=>k.startsWith('__reactProps'))?{count:${buttons(route.actions)}.length}:null;})()`, `${route.path} hydrated empty actions`);
      const sizes = [];
      for (const [width, height] of [[320, route.path === "board" ? 480 : 780], [768, 1024], [1440, 1000]]) {
        await page("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
        const bounds = await check(`(async()=>{const n=${buttons([route.primary])}.at(-1);if(!n)return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect();if(!n.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)))return null;return {height:b.height,left:b.left,right:b.right,viewport:innerWidth,hit:n.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)),overflow:document.documentElement.scrollWidth>innerWidth+1};})()`, `${route.path} ${width}`);
        sizes.push({ width, ...bounds });
        if (width === 320) await writeFile(`/tmp/showpilot-empty-${route.path.replaceAll("/", "-")}-320.png`, Buffer.from((await page("Page.captureScreenshot", { format: "png" })).data, "base64"));
        if (route.form) {
          await click(route.primary);
          await check(`!!document.querySelector(${JSON.stringify(route.form)})`, `${route.path} creation form`);
          await click(route.close);
          await check(`!document.querySelector(${JSON.stringify(route.form)})`, `${route.path} form closed`);
        }
      }
      const result = { path: route.path, count, sizes };
      if (route.path === "board") {
        result.href = await evaluate(`${buttons([route.primary])}[0].getAttribute('href')`);
        await click(route.primary);
        await check(`location.pathname==='/${orgId}/team'&&document.body?.innerText.includes('Invite')`, "Board opens Team");
      }
      assert.deepEqual(await evaluate("window.emptyActionErrors"), []);
      findings.push(result);
      console.log(JSON.stringify(result));
    }
  });
});
if (!audit) for (const finding of findings) {
  assert.equal(finding.count, 1, `${finding.path}: one empty-state primary action`);
  for (const bounds of finding.sizes) {
    assert.ok(bounds.height >= 44 && bounds.left >= 0 && bounds.right <= bounds.viewport + 1 && bounds.hit && !bounds.overflow, `${finding.path}: reachable 44px action at ${bounds.width}`);
  }
  if (finding.href) assert.equal(finding.href, "/display-smoke/team");
}
console.log(JSON.stringify({ passed: !audit, audited: audit, routes: findings.length }));
