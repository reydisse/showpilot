// Real auth/D1/Chrome: weekly duty commands, lost replies, notification delivery and both editors.
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
  names = ["getDutyRosterState", "writeDutyRoster"];
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
        name === "getDutyRosterState"
          ? `${url}?payload=${encodeURIComponent(payload)}`
          : url,
        name === "getDutyRosterState"
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
          source: `window.dutyCalls=[];window.dutyErrors=[];window.holdDutyWrites=true;window.holdDutyReads=false;window.dutyReplies=[];
   addEventListener('error',e=>window.dutyErrors.push(e.message));addEventListener('unhandledrejection',e=>window.dutyErrors.push(String(e.reason)));
   const original=fetch;window.fetch=async(input,options)=>{const url=input instanceof Request?input.url:String(input),write=url.includes('/_serverFn/${ids.writeDutyRoster}'),read=url.includes('/_serverFn/${ids.getDutyRosterState}');if(write)window.dutyCalls.push(options.body);const response=await original(input,options);if((write&&window.holdDutyWrites)||(read&&window.holdDutyReads)){const body=await response.text();return new Promise(resolve=>window.dutyReplies.push(()=>resolve(new Response(body,{status:response.status,headers:response.headers}))));}return response;};`,
        });
        const check = (expression, label) =>
          poll(() => evaluate(expression), label).catch(async (error) => {
            console.log(
              JSON.stringify({
                label,
                body: await evaluate("document.body?.innerText"),
                errors: await evaluate("window.dutyErrors"),
                calls: (await evaluate("window.dutyCalls")).map((body) =>
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
        const read = () => rpc("getDutyRosterState", { weekStart: week });
        const sunday = new Date();
        sunday.setUTCHours(12, 0, 0, 0);
        sunday.setUTCDate(sunday.getUTCDate() - sunday.getUTCDay());
        const week = sunday.toISOString().slice(0, 10);
        for (const code of ["audio", "tm"]) {
          const state = await read();
          assert.equal(
            (
              await rpc("writeDutyRoster", {
                action: "create-role",
                orgId,
                weekStart: week,
                requestId: crypto.randomUUID(),
                rolesRevision: state.rolesRevision,
                code,
                name: code === "audio" ? "Audio" : "Technical Manager",
                short: code === "audio" ? "Audio" : "TM",
              })
            ).outcome,
            "applied",
          );
        }
        const audio = (await read()).roles.find(
          (role) => role.code === "audio",
        );
        assert.ok(audio);
        await page("Page.navigate", {
          url: `${origin}/${orgId}/settings?section=kiosk`,
        });
        await check(
          `Object.keys(document.querySelector('button')??{}).some(k=>k.startsWith('__reactProps'))`,
          "hydration",
        );
        await click("On-Duty Roster");
        await fill('select[aria-label="Audio assignment"]', "smoke-operator");
        await click("Save Week");
        const saved = await poll(async () => {
          const state = await read();
          return state.tech[audio.id] === "smoke-operator" ? state : null;
        }, "saved first duty assignment");
        await rpc("writeDutyRoster", {
          action: "set-officer",
          orgId,
          weekStart: week,
          requestId: crypto.randomUUID(),
          rolesRevision: saved.rolesRevision,
          weekRevision: saved.weekRevision,
          duty: "pm",
          userId: "smoke-second-operator",
        });
        await check(
          `document.body.textContent.includes('Retry roster command')`,
          "bounded lost reply",
        );
        await click("Notifications");
        await check(
          `[...document.querySelectorAll('h1')].some(n=>n.textContent==='Notifications')`,
          "section changed",
        );
        await click("Kiosk Displays");
        await click("On-Duty Roster");
        await check(
          `document.body.textContent.includes('Retry roster command')`,
          "command retained after navigation",
        );
        await evaluate("window.holdDutyWrites=false");
        await click("Retry roster command");
        await check(
          `!document.body.textContent.includes('Retry roster command')&&document.querySelector('select[aria-label="Production Manager assignment"]')?.value==='smoke-second-operator'`,
          "newer PM assignment kept",
        );
        const calls = (await evaluate("window.dutyCalls")).map(
          (body) => fromJSON(JSON.parse(body)).data,
        );
        assert.equal(calls.length, 2);
        assert.deepEqual(calls[1], calls[0]);
        await evaluate(
          "window.dutyReplies.splice(0).forEach(resolve=>resolve())",
        );
        await fill(
          'select[aria-label="Audio assignment"]',
          "smoke-second-operator",
        );
        await fill(
          'input[aria-label="Roster week starting Sunday"]',
          "2031-02-02",
        );
        await check(
          `document.querySelector('select[aria-label="Audio assignment"]')?.value===''`,
          "different week's assignments",
        );
        await fill('input[aria-label="Roster week starting Sunday"]', week);
        await check(
          `document.querySelector('select[aria-label="Audio assignment"]')?.value==='smoke-second-operator'`,
          "week draft retained",
        );
        await click("Save Week");
        await check(
          `!!document.querySelector('[role="dialog"]')`,
          "replace confirmation",
        );
        assert.equal(await evaluate("window.dutyCalls.length"), 2);
        await click("Cancel");
        await click("Save Week");
        await click("Save assignments");
        await check(
          `!document.querySelector('[role="dialog"]')&&!document.body.textContent.includes('Waiting for the roster command')`,
          "replacement acknowledged",
        );
        assert.equal((await read()).tech[audio.id], "smoke-second-operator");
        await click("Manage roles (2)");
        for (const width of [320, 768, 1440]) {
          await page("Emulation.setDeviceMetricsOverride", {
            width,
            height: 1000,
            deviceScaleFactor: 1,
            mobile: false,
          });
          await check(
            `(()=>{const s=document.querySelector('section[aria-label="On-duty roster"]');return s&&document.documentElement.scrollWidth<=innerWidth+1&&[...s.querySelectorAll('button,input,select')].every(n=>{const b=n.getBoundingClientRect();return b.height>=44&&b.width>=44&&b.left>=0&&b.right<=innerWidth;});})()`,
            "contained roster controls " + width,
          );
          if (width === 320) {
            await evaluate(
              `document.querySelector('select[aria-label="Audio assignment"]').scrollIntoView({block:'center'})`,
            );
            await writeFile(
              "/tmp/showpilot-duty-roster-320.png",
              Buffer.from(
                (await page("Page.captureScreenshot", { format: "png" })).data,
                "base64",
              ),
            );
          }
          await click("Delete role");
          await check(
            `document.querySelector('[role="dialog"]')?.getAnimations({subtree:true}).every(a=>a.playState==='finished')`,
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
        assert.equal(await evaluate("window.dutyCalls.length"), 3);
        await click("Delete role");
        await click("Delete role");
        await check(
          `!document.querySelector('select[aria-label="Audio assignment"]')`,
          "deleted role refreshed",
        );
        assert.equal((await read()).roles.length, 1);
        assert.deepEqual(await evaluate("window.dutyErrors"), []);
        await page("Page.navigate", {
          url: `${origin}/${orgId}/dashboard/prod-manager`,
        });
        await check(
          `document.querySelector('#duty-pm')?.value==='smoke-second-operator'`,
          "dashboard same duty snapshot",
        );
        await evaluate("window.holdDutyWrites=false");
        await evaluate(
          `(()=>{const n=document.querySelector("#duty-pm");Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value").set.call(n,"smoke-operator");n.dispatchEvent(new Event("change",{bubbles:true}));})()`,
        );
        await click("Change assignment");
        await check(
          `document.querySelector('#duty-pm')?.value==='smoke-operator'`,
          "dashboard saved assignment",
        );
        const final = await read();
        assert.equal(final.pmUserId, "smoke-operator");
        assert.equal(final.pendingNotifications, 0);
        assert.deepEqual(await evaluate("window.dutyErrors"), []);
      },
    );
    await stopServer();
    const receipts = await queryFixture(
      `SELECT requestId FROM duty_roster_command_receipt WHERE orgId='${orgId}'`,
    );
    assert.equal(receipts.length, 7);
    const notifications = await queryFixture(
      `SELECT id FROM notification WHERE orgId='${orgId}' AND type='duty-assignment'`,
    );
    assert.equal(notifications.length, 7);
    assert.deepEqual(
      await queryFixture(
        "SELECT * FROM duty_roster_command_receipt WHERE orgId='display-other'",
      ),
      [],
    );
    assert.equal((await capturedEmails()).length, 0);
    console.log(
      JSON.stringify({
        passed: true,
        lostReply: true,
        exactRetryAcrossNavigation: true,
        newerPmKept: true,
        weekDrafts: true,
        confirmedReplacementAndDelete: true,
        dashboard: true,
        widths: [320, 768, 1440],
        receipts: receipts.length,
        notifications: notifications.length,
        externalEmails: 0,
      }),
    );
  },
  {
    captureEmail: true,
    paidPlan: true,
    secondOperator: true,
    secondOperatorMember: true,
  },
);
