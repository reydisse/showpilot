// Real login, compiled panel and D1 receipts; held replies contain real commits.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";
const web = createRequire(new URL("../package.json", import.meta.url));
const router = createRequire(web.resolve("@tanstack/react-router"));
const { fromJSON } = createRequire(router.resolve("@tanstack/router-core"))(
  "seroval",
);
const names = [
  "getPersonalNotifications",
  "markAllPersonalNotificationsRead",
  "markPersonalNotificationRead",
];
const ids = {},
  assets = resolve(import.meta.dirname, "../dist/server/assets");
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
assert.ok(
  names.every((name) => ids[name]),
  "Build before running inbox rehearsal",
);
await withLocalSmokeFixture(
  async ({
    origin,
    orgId,
    operatorCookie,
    stopServer,
    startServer,
    queryFixture,
    insertInboxArrival,
    capturedEmails,
  }) => {
    await withRealBrowser(
      { origin, cookie: operatorCookie },
      async ({ page, evaluate }) => {
        await page("Page.enable");
        await page("Emulation.setFocusEmulationEnabled", { enabled: true });
        await page("Emulation.setDeviceMetricsOverride", {
          width: 1440,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await page("Page.addScriptToEvaluateOnNewDocument", {
          source: `
      window.inboxErrors=[];window.inboxWrites=[];window.inboxHeld=[];window.inboxModes={getPersonalNotifications:'hold'};window.inboxDocument='same';
      addEventListener('error',e=>window.inboxErrors.push(e.message));addEventListener('unhandledrejection',e=>window.inboxErrors.push(String(e.reason)));
      const original=fetch,ids=${JSON.stringify(ids)};
      window.fetch=async(input,options)=>{
        const url=input instanceof Request?input.url:String(input),name=Object.keys(ids).find(key=>url.includes('/_serverFn/'+ids[key]));
        if(!name)return original(input,options);
        if(name!=='getPersonalNotifications')window.inboxWrites.push({name,body:options.body});
        if(window.inboxModes[name]==='fail')throw new TypeError('Fixture inbox connection failed');
        const hold=window.inboxModes[name]==='hold';
        const response=await original(input,hold?{...options,signal:new AbortController().signal}:options);
        if(!hold)return response;
        const body=await response.arrayBuffer();return new Promise(resolve=>window.inboxHeld.push({name,release:()=>resolve(new Response(body,{status:response.status,headers:response.headers}))}));
      };`,
        });
        const check = (expression, label, timeout = 15_000) =>
          poll(() => evaluate(expression), label, timeout).catch(
            async (error) => {
              console.error(
                JSON.stringify({
                  label,
                  state: await evaluate(
                    `({text:document.body.innerText,errors:window.inboxErrors})`,
                  ),
                }),
              );
              throw error;
            },
          );
        const button = (text) =>
          `[...document.querySelectorAll('button')].find(el=>el.textContent.trim()===${JSON.stringify(text)}&&el.getBoundingClientRect().width>0)`;
        const click = async (expression) => {
          const point = await check(
            `(async()=>{const el=${expression};if(!el||el.disabled||!Object.keys(el).some(k=>k.startsWith('__reactProps')))return null;el.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=el.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return el.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`,
            "reachable inbox control",
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
        };
        const mode = (name, value) =>
          evaluate(
            `window.inboxModes[${JSON.stringify(name)}]=${JSON.stringify(value)};true`,
          );
        const list = `document.querySelector('[data-testid="notification-list"]')`;
        const close = async () => {
          await page("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "Escape",
            code: "Escape",
            windowsVirtualKeyCode: 27,
          });
          await page("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "Escape",
            code: "Escape",
            windowsVirtualKeyCode: 27,
          });
          await check(
            `!document.querySelector('[role=dialog]')`,
            "closed panel",
          );
        };
        const open = () =>
          click(`document.querySelector('button[title="Notifications"]')`);
        await page("Page.navigate", { url: `${origin}/${orgId}/show` });
        await open();
        await check(
          `!!${button("Retry notifications")}`,
          "initial read timeout",
        );
        assert.equal(
          await evaluate(
            `!!document.querySelector('[aria-label="Loading notifications"]')||${list}.textContent.includes('Nothing waiting for you.')`,
          ),
          false,
        );
        await evaluate(`window.inboxHeld.forEach(h=>h.release());true`);
        assert.equal(
          await evaluate(`${list}.textContent.includes('Fixture alert 34')`),
          false,
        );
        for (const [width, height] of [
          [320, 480],
          [768, 900],
          [1440, 900],
        ]) {
          await page("Emulation.setDeviceMetricsOverride", {
            width,
            height,
            deviceScaleFactor: 1,
            mobile: false,
          });
          await check(
            `(()=>{const el=${button("Retry notifications")};el.scrollIntoView({block:'center'});const b=el.getBoundingClientRect();return b.width>=44&&b.height>=44&&b.left>=0&&b.right<=innerWidth&&el.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2));})()`,
            `retry fits ${width}`,
          );
          if (width === 320)
            await writeFile(
              "/tmp/showpilot-notification-inbox-failure-320.png",
              Buffer.from(
                (await page("Page.captureScreenshot", { format: "png" })).data,
                "base64",
              ),
            );
        }
        await mode("getPersonalNotifications", "normal");
        await click(button("Retry notifications"));
        await check(
          `${list}?.textContent.includes('Fixture alert 34')`,
          "confirmed first page",
        );
        await mode("getPersonalNotifications", "hold");
        await click(button("Load older notifications"));
        await check(
          `${list}?.textContent.includes('Older notifications could not be loaded')`,
          "older read timeout",
        );
        assert.equal(
          await evaluate(`${list}.textContent.includes('Fixture alert 34')`),
          true,
        );
        await mode("getPersonalNotifications", "normal");
        await click(button("Retry notifications"));
        await check(
          `${list}?.textContent.includes('Fixture alert 0')`,
          "older page retry",
        );
        await evaluate(`window.inboxHeld.forEach(h=>h.release());true`);
        await mode("markAllPersonalNotificationsRead", "hold");
        await click(button("Mark all read"));
        await check(
          `window.inboxHeld.some(h=>h.name==='markAllPersonalNotificationsRead')`,
          "real read-set commit",
        );
        await close();
        await stopServer();
        assert.equal(
          (
            await queryFixture(
              "SELECT COUNT(*) AS count FROM notification WHERE orgId='display-smoke' AND userId='smoke-operator' AND readAt IS NOT NULL",
            )
          )[0].count,
          35,
        );
        await insertInboxArrival();
        await startServer();
        await open();
        await check(
          `!!${button("Retry read status")}`,
          "failed command retained after close",
        );
        await evaluate(`window.inboxHeld.forEach(h=>h.release());true`);
        assert.equal(
          await evaluate(`!!${button("Retry read status")}`),
          true,
          "late response cannot hide uncertainty",
        );
        await mode("markAllPersonalNotificationsRead", "normal");
        await click(button("Retry read status"));
        await check(
          `${list}?.textContent.includes('Arrived after mark-all')&&!${list}.textContent.includes('was not confirmed')`,
          "exact retry and new alert",
        );
        const attempts = (
          await evaluate(
            `window.inboxWrites.filter(w=>w.name==='markAllPersonalNotificationsRead')`,
          )
        ).map((entry) => fromJSON(JSON.parse(entry.body)).data);
        assert.equal(attempts.length, 2);
        assert.deepEqual(attempts[0], attempts[1]);
        assert.equal(
          await evaluate(
            `[...${list}.querySelectorAll('button')].find(el=>el.textContent.includes('Arrived after mark-all')).textContent.includes('Unread')`,
          ),
          true,
        );
        await mode("markPersonalNotificationRead", "fail");
        await click(
          `[...${list}.querySelectorAll('button')].find(el=>el.textContent.includes('Arrived after mark-all'))`,
        );
        await check(
          `location.pathname.endsWith('/schedule')&&!document.querySelector('[role=dialog]')`,
          "notification navigates without waiting",
        );
        await open();
        await check(
          `!!${button("Retry read status")}`,
          "individual failure retained across navigation",
        );
        await mode("markPersonalNotificationRead", "normal");
        await click(button("Retry read status"));
        await check(
          `${list}&&!${list}.textContent.includes('was not confirmed')&&!${list}.textContent.includes('Unread')`,
          "individual retry",
        );
        const individual = (
          await evaluate(
            `window.inboxWrites.filter(w=>w.name==='markPersonalNotificationRead')`,
          )
        ).map((entry) => fromJSON(JSON.parse(entry.body)).data);
        assert.equal(individual.length, 2);
        assert.deepEqual(individual[0], individual[1]);
        for (const [width, height] of [
          [320, 480],
          [768, 900],
          [1440, 900],
        ]) {
          await page("Emulation.setDeviceMetricsOverride", {
            width,
            height,
            deviceScaleFactor: 1,
            mobile: false,
          });
          await check(
            `document.documentElement.scrollWidth<=innerWidth+1&&${list}?.getBoundingClientRect().height>100`,
            "usable inbox viewport",
          );
          if (width === 320)
            await writeFile(
              "/tmp/showpilot-notification-inbox-320.png",
              Buffer.from(
                (await page("Page.captureScreenshot", { format: "png" })).data,
                "base64",
              ),
            );
        }
        await page("Fetch.enable", { patterns: [{ urlPattern: "*/assets/DeviceNotificationsControl-*.js", requestStage: "Request" }] });
      await click(`document.querySelector('button[aria-label="Back to account"]')`);
      await check(`!!${button('Retry account view')}`, 'device setup download timeout',18_000);
      await page("Fetch.disable");
      assert.equal(await evaluate(`!!${button('Retry account view')}`),true);
      await click(button('Retry account view'));

      await evaluate(`(()=>{window.permissionCalls=0;Notification.requestPermission=()=>{window.permissionCalls++;return new Promise(resolve=>window.finishPermission=resolve);};return true;})()`);
      const alerts=`[...document.querySelectorAll('button')].find(el=>el.textContent.includes('Device notifications')&&el.getBoundingClientRect().width>0)`;
      await click(alerts);
      await check(`document.querySelector('[role=dialog]')?.textContent.includes('Device alerts were not confirmed')`,'bounded device alert setup',18_000);
      assert.equal(await evaluate(`${alerts}.disabled`),false);
      assert.equal(await evaluate('window.permissionCalls'),1);
      await evaluate(`window.finishPermission('default');true`);
      assert.equal(await evaluate(`document.querySelector('[role=dialog]').textContent.includes('Device alerts were not confirmed')`),true);
      await evaluate(`Notification.requestPermission=()=>Promise.reject(new Error('Fixture permission read failed'));true`);
      await click(alerts);
      await check(`!${alerts}.disabled&&document.querySelector('[role=dialog]').textContent.includes('Device alerts were not confirmed')`,'device alerts retry after permission failure');
      assert.equal(await evaluate("window.inboxDocument"), "same");
        assert.deepEqual(await evaluate("window.inboxErrors"), []);
      },
    );
    await stopServer();
    assert.equal(
      (
        await queryFixture(
          "SELECT COUNT(*) AS count FROM notification_read_receipt WHERE orgId='display-smoke' AND userId='smoke-operator'",
        )
      )[0].count,
      2,
    );
    assert.equal((await capturedEmails()).length, 0);
    console.log(
      JSON.stringify({
        passed: true,
        boundedInitialAndOlderReads: true,
        lateRepliesIgnored: true,
        retainedWriteAfterPanelClose: true,
        exactRetryPreservesNewAlert: true,
        individualRetryAfterNavigation: true,
        widths: [320, 768, 1440],
        capturedEmails: 0,
      }),
    );
  },
  { notificationInbox: true, captureEmail: true },
);
