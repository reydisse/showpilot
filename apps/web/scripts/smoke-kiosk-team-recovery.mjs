// Real auth/D1/Chrome: org-chart command recovery and membership editing.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";
const require = createRequire(new URL("../package.json", import.meta.url)),
  router = createRequire(require.resolve("@tanstack/react-router")),
  core = createRequire(router.resolve("@tanstack/router-core"));
const { toJSONAsync, fromJSON, fromCrossJSON } = core("seroval"),
  { defaultSerovalPlugins } = router("@tanstack/router-core");
const ids = {},
  names = ["getKioskTeams", "writeKioskTeam"];
const assets = resolve(import.meta.dirname, "../dist/server/assets");
for (const file of (await readdir(assets)).filter((f) => f.endsWith(".js"))) {
  const source = await readFile(resolve(assets, file), "utf8");
  for (const name of names)
    ids[name] ??= source.match(
      new RegExp(
        `const ${name}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([^"]+)"`,
      ),
    )?.[1];
}
assert.ok(names.every((name) => ids[name]));
await withLocalSmokeFixture(
  async ({
    origin,
    orgId,
    operatorCookie,
    stopServer,
    queryFixture,
    capturedEmails,
  }) => {
    async function rpc(name, data = {}) {
      const payload = JSON.stringify(
          await toJSONAsync({ data: { orgId, ...data } }),
        ),
        url = `${origin}/_serverFn/${ids[name]}`,
        headers = {
          Cookie: operatorCookie,
          Origin: origin,
          "Sec-Fetch-Site": "same-origin",
          "x-tsr-serverFn": "true",
          "Content-Type": "application/json",
        };
      const response = await fetch(
        name === "getKioskTeams"
          ? `${url}?payload=${encodeURIComponent(payload)}`
          : url,
        name === "getKioskTeams"
          ? { headers }
          : { method: "POST", headers, body: payload },
      );
      assert.equal(response.status, 200);
      const reply = fromCrossJSON(await response.json(), {
        refs: new Map(),
        plugins: defaultSerovalPlugins,
      });
      assert.equal(reply.error, undefined);
      assert.equal(reply instanceof Error, false);
      return reply.result;
    }
    await withRealBrowser(
      { origin, cookie: operatorCookie },
      async ({ page, evaluate }) => {
        await page("Page.enable");
        await page("Emulation.setFocusEmulationEnabled", { enabled: true });
        await page("Emulation.setDeviceMetricsOverride", {
          width: 1440,
          height: 1000,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await page("Page.addScriptToEvaluateOnNewDocument", {
          source: `window.teamCalls=[];window.teamErrors=[];window.holdTeamWrites=true;window.holdTeamReads=false;window.teamReplies=[];
   addEventListener('error',e=>window.teamErrors.push(e.message));addEventListener('unhandledrejection',e=>window.teamErrors.push(String(e.reason)));
   const original=fetch;window.fetch=async(input,options)=>{const url=input instanceof Request?input.url:String(input),write=url.includes('/_serverFn/${ids.writeKioskTeam}'),read=url.includes('/_serverFn/${ids.getKioskTeams}');if(write)window.teamCalls.push(options.body);const response=await original(input,options);if((write&&window.holdTeamWrites)||(read&&window.holdTeamReads)){const body=await response.text();return new Promise(resolve=>window.teamReplies.push(()=>resolve(new Response(body,{status:response.status,headers:response.headers}))));}return response;};`,
        });
        const check = (expression, label) =>
          poll(() => evaluate(expression), label).catch(async (error) => {
            console.log(
              JSON.stringify({
                label,
                body: await evaluate("document.body?.innerText"),
                errors: await evaluate("window.teamErrors"),
                calls: (await evaluate("window.teamCalls")).map((body) =>
                  fromJSON(JSON.parse(body)),
                ),
              }),
            );
            throw error;
          });
        const click = async (name) => {
          const point = await check(
            `(async()=>{const dialog=document.querySelector('[role="dialog"]');if(dialog&&(dialog.getAttribute('data-state')==='closed'||dialog.getAnimations({subtree:true}).some(a=>a.playState!=='finished')))return null;const root=dialog??document;const n=[...root.querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(name)}&&!n.disabled);if(!n)return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`,
            "click " + name,
          );
          await page("Input.dispatchMouseEvent", {
            type: "mousePressed",
            button: "left",
            clickCount: 1,
            ...point,
          });
          await page("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            button: "left",
            clickCount: 1,
            ...point,
          });
          if (name === "Cancel")
            await check(
              `!document.querySelector('[role="dialog"]')`,
              "dialog closed",
            );
        };
        const fill = async (selector, value) => {
          await check(
            `!!document.querySelector(${JSON.stringify(selector)})`,
            "field",
          );
          await evaluate(
            `(()=>{const n=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(n instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event(n instanceof HTMLSelectElement?'change':'input',{bubbles:true}));})()`,
          );
          await check(
            `document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(value)}`,
            "field retained",
          );
        };
        const card = () =>
          check(
            `!!document.querySelector('article[aria-label="Audio updated elsewhere team"]')`,
            "latest team",
          );
        await page("Page.navigate", {
          url: `${origin}/${orgId}/settings?section=kiosk`,
        });
        await check(
          `!!document.querySelector('form[aria-label="New kiosk team"]')`,
          "org chart",
        );
        await check(
          `Object.keys(document.querySelector('button')??{}).some(k=>k.startsWith('__reactProps'))`,
          "hydration",
        );
        await fill('form[aria-label="New kiosk team"] input', "Audio");
        await click("Add Team");
        const created = await poll(async () => {
          const teams = await rpc("getKioskTeams");
          return teams.length === 1 ? teams[0] : null;
        }, "committed create");
        await rpc("writeKioskTeam", {
          action: "update",
          id: created.id,
          revision: created.revision,
          requestId: crypto.randomUUID(),
          name: "Audio updated elsewhere",
          color: "#3b82f6",
        });
        await check(
          `document.body.textContent.includes('Retry team command')`,
          "bounded write failure",
        );
        await click("Notifications");
        await check(
          `[...document.querySelectorAll('h1')].some(n=>n.textContent==='Notifications')`,
          "section changed",
        );
        await click("Kiosk Displays");
        await check(
          `document.body.textContent.includes('Retry team command')`,
          "retained command",
        );
        await evaluate("window.holdTeamWrites=false");
        await click("Retry team command");
        await card();
        await check(
          `document.querySelector('form[aria-label="New kiosk team"] input')?.value===''`,
          "create acknowledged",
        );
        const requests = (await evaluate("window.teamCalls")).map((body) =>
          fromJSON(JSON.parse(body)),
        );
        assert.equal(requests.length, 2);
        assert.deepEqual(requests[0], requests[1]);
        assert.equal((await rpc("getKioskTeams")).length, 1);
        await evaluate(
          "window.teamReplies.splice(0).forEach(release=>release())",
        );
        await click("Edit team");
        await fill(
          'form[aria-label="Edit Audio updated elsewhere"] input',
          "Audio draft",
        );
        assert.equal(await evaluate("window.teamCalls.length"), 2);
        await evaluate("window.holdTeamReads=true");
        await click("Save team");
        await check(
          `document.body.textContent.includes('Retry kiosk organization')`,
          "refresh-only recovery",
        );
        assert.equal(await evaluate("window.teamCalls.length"), 3);
        await evaluate("window.holdTeamReads=false");
        await click("Retry kiosk organization");
        await check(
          `!!document.querySelector('article[aria-label="Audio draft team"]')`,
          "rename refreshed",
        );
        assert.equal(await evaluate("window.teamCalls.length"), 3);
        await evaluate(
          "window.teamReplies.splice(0).forEach(release=>release())",
        );
        await fill("article select", "smoke-operator");
        await click("Add member");
        await check(
          `[...document.querySelectorAll('article button')].some(n=>n.textContent==='Make lead'&&!n.disabled)`,
          "member added",
        );
        await click("Make lead");
        await click("Cancel");
        assert.equal(await evaluate("window.teamCalls.length"), 4);
        await click("Make lead");
        await click("Make lead");
        await check(
          `[...document.querySelectorAll('article button')].some(n=>n.textContent==='Make member'&&!n.disabled)`,
          "lead saved",
        );
        await check(
          `!document.querySelector('[role="dialog"]')`,
          "lead confirmation closed",
        );
        for (const width of [320, 768, 1440]) {
          await page("Emulation.setDeviceMetricsOverride", {
            width,
            height: 1000,
            deviceScaleFactor: 1,
            mobile: false,
          });
          await check(
            `(()=>{const section=document.querySelector('section[aria-label="Kiosk org chart"]');return section&&document.documentElement.scrollWidth<=innerWidth+1&&[...section.querySelectorAll('li > span')].every(n=>n.getBoundingClientRect().width>=120)&&[...section.querySelectorAll('button,input,select')].every(n=>{const b=n.getBoundingClientRect();return b.height>=44&&b.width>=44&&b.left>=0&&b.right<=innerWidth;});})()`,
            "contained 44px controls " + width,
          );
          if (width === 320) {
            await evaluate(
              `document.querySelector('article').scrollIntoView({block:'center'})`,
            );
            await writeFile(
              "/tmp/showpilot-kiosk-team-320.png",
              Buffer.from(
                (await page("Page.captureScreenshot", { format: "png" })).data,
                "base64",
              ),
            );
          }
          await click("Delete team");
          await check(
            `document.querySelector('[role="dialog"]').getAnimations({subtree:true}).every(a=>a.playState==='finished')`,
            "settled dialog",
          );
          assert.equal(
            await evaluate(
              `(()=>{const d=document.querySelector('[role="dialog"]'),b=d.getBoundingClientRect();return b.left>=0&&b.right<=innerWidth&&d.scrollWidth<=d.clientWidth+1;})()`,
            ),
            true,
          );
          await click("Cancel");
        }
        assert.equal(await evaluate("window.teamCalls.length"), 5);
        await click("Delete team");
        await click("Delete team");
        await check(
          `!document.querySelector('article')&&document.body.textContent.includes('No teams yet')`,
          "team deletion refreshed",
        );
        assert.deepEqual(await rpc("getKioskTeams"), []);
        assert.deepEqual(await evaluate("window.teamErrors"), []);
      },
    );
    await stopServer();
    assert.deepEqual(
      await queryFixture(`SELECT id FROM team WHERE orgId='${orgId}'`),
      [],
    );
    assert.deepEqual(await queryFixture("SELECT * FROM team_member"), []);
    assert.equal(
      (
        await queryFixture(
          `SELECT requestId FROM kiosk_team_command_receipt WHERE orgId='${orgId}'`,
        )
      ).length,
      6,
    );
    assert.deepEqual(
      await queryFixture(
        "SELECT * FROM kiosk_team_command_receipt WHERE orgId='display-other'",
      ),
      [],
    );
    assert.equal((await capturedEmails()).length, 0);
    console.log(
      JSON.stringify({
        passed: true,
        lostCreateReply: true,
        exactRetryAcrossNavigation: true,
        newerNameKept: true,
        refreshOnlyRetry: true,
        confirmedLeadAndDelete: true,
        widths: [320, 768, 1440],
        receipts: 6,
        externalEmails: 0,
      }),
    );
  },
  { captureEmail: true, paidPlan: true },
);
