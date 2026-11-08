// Real auth/D1/compiled app/Chrome, with all outbound email confined to the fixture.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";
const require = createRequire(new URL("../package.json", import.meta.url));
const router = createRequire(require.resolve("@tanstack/react-router"));
const core = createRequire(router.resolve("@tanstack/router-core"));
const { toJSONAsync, fromJSON, fromCrossJSON } = core("seroval");
const { defaultSerovalPlugins } = router("@tanstack/router-core");
const ids = {},
  names = ["sendScheduleReminders", "getCrewSchedulePortal"];
const assets = resolve(import.meta.dirname, "../dist/server/assets");
for (const file of (await readdir(assets)).filter((file) =>
  file.endsWith(".js"),
)) {
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
  async ({ origin, orgId, operatorCookie, configureEmail, capturedEmails }) => {
    async function portal(token) {
      const payload = JSON.stringify(await toJSONAsync({ data: { token } }));
      const response = await fetch(
        `${origin}/_serverFn/${ids.getCrewSchedulePortal}?payload=${encodeURIComponent(payload)}`,
        {
          headers: {
            Origin: origin,
            "x-tsr-serverFn": "true",
            "Content-Type": "application/json",
          },
        },
      );
      assert.equal(response.status, 200);
      const reply = fromCrossJSON(await response.json(), {
        refs: new Map(),
        plugins: defaultSerovalPlugins,
      });
      assert.equal(reply.error, undefined);
      return reply.result;
    }
    await configureEmail("partial-schedule");
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
          source: `window.reminderCalls=[];window.reminderHeld=[];window.reminderErrors=[];window.holdReminders=true;window.reminderDocument='same';
      addEventListener('error',e=>reminderErrors.push(e.message));addEventListener('unhandledrejection',e=>reminderErrors.push(String(e.reason)));
      const original=fetch;window.fetch=async(input,options)=>{const url=input instanceof Request?input.url:String(input);if(!url.includes('/_serverFn/${ids.sendScheduleReminders}'))return original(input,options);reminderCalls.push(options.body);const hold=holdReminders;const response=await original(input,hold?{...options,signal:new AbortController().signal}:options);if(!hold)return response;const bytes=await response.arrayBuffer();return new Promise(resolve=>reminderHeld.push(()=>resolve(new Response(bytes,{status:response.status,headers:response.headers}))));};`,
        });
        const check = (expression, label) =>
          poll(() => evaluate(expression), label).catch(async (error) => {
            console.log(
              JSON.stringify({
                label,
                body: await evaluate("document.body.innerText"),
                errors: await evaluate("reminderErrors"),
              }),
            );
            throw error;
          });
        const button = (name) =>
          `[...document.querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(name)}&&!n.disabled&&n.getBoundingClientRect().width>0)`;
        const click = async (expression) => {
          const point = await check(
            `(async()=>{const n=${expression};if(!n||!Object.keys(n).some(k=>k.startsWith('__reactProps')))return null;n.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`,
            "reachable " + expression,
          );
          for (const type of ["mousePressed", "mouseReleased"])
            await page("Input.dispatchMouseEvent", {
              type,
              button: "left",
              clickCount: 1,
              ...point,
            });
        };
        await page("Page.navigate", {
          url: `${origin}/${orgId}/schedule?date=2099-01-01&show=assignment-show&month=2099-01`,
        });
        await click(button("Remind awaiting crew (3)"));
        const firstEmails = await poll(async () => {
          const emails = await capturedEmails();
          return emails.length === 3 ? emails : null;
        }, "three fixture emails");
        await check(
          "reminderHeld.length===1",
          "server response held after partial provider acknowledgement",
        );
        assert.equal(
          new Set(firstEmails.map((email) => email.idempotencyKey)).size,
          3,
        );
        const uncertainEmail = firstEmails.find(
          (email) => email.to === "other@display-smoke.invalid",
        );
        assert.ok(uncertainEmail?.delivered);
        const token = uncertainEmail.html.match(
          /\/crew\/schedule\/([A-Za-z0-9_-]+)/,
        )?.[1];
        assert.ok(token);
        assert.equal(
          (await portal(token)).initialAssignmentId,
          "assignment-other",
          "The possibly delivered email still opens its invitation",
        );
        await click(`document.querySelector('a[href="/${orgId}/songs"]')`);
        await check(
          "location.pathname.endsWith('/songs')",
          "navigate away during reminder request",
        );
        await evaluate("history.back()");
        await check(
          "location.pathname.endsWith('/schedule')&&location.search.includes('assignment-show')",
          "return to same schedule selection",
        );
        await check(
          `!!${button("Retry reminders")}`,
          "client reminder deadline",
        );
        await evaluate(
          "holdReminders=false;reminderHeld.splice(0).forEach(release=>release());true",
        );
        await click(button("Retry reminders"));
        await check(
          "document.body.innerText.includes('3 of 3 emails accepted.')",
          "exact retry confirms original deliveries",
        );
        const attempts = (await evaluate("reminderCalls")).map(
          (body) => fromJSON(JSON.parse(body)).data,
        );
        assert.deepEqual(attempts[1], attempts[0]);
        const recovered = await capturedEmails();
        assert.equal(recovered.length, 4);
        assert.equal(recovered[3].replayed, true);
        assert.equal(
          recovered[3].idempotencyKey,
          uncertainEmail.idempotencyKey,
        );
        assert.equal(
          (await portal(token)).initialAssignmentId,
          "assignment-other",
        );
        await configureEmail("fail");
        await click(button("Send another reminder"));
        await check(
          "document.body.innerText.includes('0 of 3 emails accepted.')&&document.body.innerText.includes('Email was rejected.')",
          "definite rejection is visible",
        );
        assert.equal((await capturedEmails()).length, 7);
        for (const [width, height] of [
          [320, 480],
          [768, 1024],
          [1440, 1000],
        ]) {
          await page("Emulation.setDeviceMetricsOverride", {
            width,
            height,
            deviceScaleFactor: 1,
            mobile: false,
          });
          const layout = await check(
            `(async()=>{await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=${button("Retry reminders")};if(!b)return null;b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect(),p=b.parentElement.getBoundingClientRect();if(r.left<0||r.right>innerWidth||r.top<0||r.bottom>innerHeight)return null;return {height:r.height,left:p.left,right:p.right}})()`,
            "reachable reminder recovery at " + width,
          );
          assert.ok(
            layout.height >= 44 && layout.left >= 0 && layout.right <= width,
            JSON.stringify(layout),
          );
          await writeFile(
            `/tmp/showpilot-reminder-${width}.png`,
            Buffer.from(
              (await page("Page.captureScreenshot", { format: "png" })).data,
              "base64",
            ),
          );
        }
        await configureEmail("success");
        await click(button("Retry reminders"));
        await check(
          "document.body.innerText.includes('3 of 3 emails accepted.')",
          "retry rejected emails",
        );
        const all = (await evaluate("reminderCalls")).map(
          (body) => fromJSON(JSON.parse(body)).data,
        );
        assert.notEqual(all[2].requestId, all[0].requestId);
        assert.deepEqual(all[3], all[2]);
        const emails = await capturedEmails();
        assert.equal(emails.length, 10);
        assert.equal(
          emails.filter((email) => email.delivered && !email.replayed).length,
          6,
        );
        assert.equal(await evaluate("reminderDocument"), "same");
        assert.deepEqual(await evaluate("reminderErrors"), []);
        console.log(
          JSON.stringify({
            preservedUncertainInvitation: true,
            retainedAcrossNavigation: true,
            originalRequestRetried: true,
            acceptedEmailsNotRepeated: true,
            definiteFailuresVisible: true,
            capturedAttempts: emails.length,
            distinctAcceptedEmails: 6,
            viewports: [320, 768, 1440],
            errors: [],
          }),
        );
      },
    );
  },
  { personalAssignments: true, captureEmail: true },
);
