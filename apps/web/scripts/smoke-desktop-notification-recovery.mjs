// Compiled web app/auth/D1 and actual Tauri JS boundaries; native IPC is simulated.
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";

const assets = resolve(import.meta.dirname, "../dist/server/assets");
let inboxId;
for (const file of (await readdir(assets)).filter((file) =>
  file.endsWith(".js"),
)) {
  inboxId ??= (await readFile(resolve(assets, file), "utf8")).match(
    /const getPersonalDeviceNotifications_createServerFn_handler = createServerRpc\(\{\s*id: "([^"]+)"/,
  )?.[1];
}
assert.ok(inboxId, "Build before the desktop delivery rehearsal");
await withLocalSmokeFixture(
  async ({ origin, orgId, operatorCookie, queryFixture }) => {
    await withRealBrowser(
      { origin, cookie: operatorCookie },
      async ({ page, evaluate, onPageEvent }) => {
        await page("Page.enable");
        await page("Emulation.setFocusEmulationEnabled", { enabled: true });
        await page("Emulation.setDeviceMetricsOverride", {
          width: 1440,
          height: 1000,
          deviceScaleFactor: 1,
          mobile: false,
        });
        const heldModules = [];
        onPageEvent((event) => {
          if (event.method === "Fetch.requestPaused")
            heldModules.push(event.params.requestId);
        });
        await page("Fetch.enable", {
          patterns: [
            {
              urlPattern: "*desktop-notification-delivery-*.js",
              requestStage: "Request",
            },
          ],
        });
        await page("Page.addScriptToEvaluateOnNewDocument", {
          source: `
      window.desktopFixture={errors:[],sent:[],attempts:[],registered:[],removed:[],heldReads:[],heldPermissions:[],heldRegistrations:[],readMode:'hold',permissionMode:'normal',registrationMode:'hold',sendMode:'fail-b',readCount:0,permissionCount:0,focusCount:0,document:'same'};
      const fixture=window.desktopFixture;
      addEventListener('error',e=>fixture.errors.push(e.message));addEventListener('unhandledrejection',e=>fixture.errors.push(String(e.reason)));
      localStorage.setItem('showpilot.desktop-notifications.v1:smoke-operator:display-smoke',JSON.stringify(['desktop-old']));
      class NativeNotification {
        static permission='default';
        static async requestPermission(){return 'granted';}
        constructor(title,options){const id=options.extra?.notificationId;fixture.attempts.push(id);if(fixture.sendMode==='fail-b'&&id==='desktop-b')throw new Error('Fixture native send failure');fixture.sent.push({id,title,options});}
      }
      Object.defineProperty(window,'Notification',{configurable:true,value:NativeNotification});
      const callbacks=new Map();let callbackId=0;
      const invoke=async(command,args={})=>{
        if(command==='plugin:notification|is_permission_granted'){fixture.permissionCount++;if(fixture.permissionMode==='hold')return new Promise(resolve=>fixture.heldPermissions.push(()=>resolve(true)));return true;}
        if(command==='plugin:notification|register_listener'){fixture.registered.push(args.handler);if(fixture.registrationMode==='hold')return new Promise(resolve=>fixture.heldRegistrations.push(()=>resolve()));return;}
        if(command==='plugin:notification|remove_listener'){fixture.removed.push(args.channelId);return;}
        if(command==='focus_main_window'){fixture.focusCount++;return new Promise(()=>{});}
        if(command==='engine_info')return {native:true,platform:'fixture',version:'test',cachePath:null};
        if(command==='bridge_status')return {configured:false,localDevicesEnabled:false,running:false,connection:'offline',pid:null,logs:[],lastError:null};
        if(command==='local_show_request')return {mode:'empty',installationId:null,commandSource:'cloud'};
        if(command==='confidence_outputs')return {monitors:[],decklink:{devices:[],error:null},active:null};
        if(command==='confidence_output_status')return {state:'stopped',message:''};
        if(command==='display_fullscreen_state')return false;
        if(command.startsWith('plugin:'))return null;
        throw new Error('Unexpected fixture IPC '+command);
      };
      window.__TAURI_INTERNALS__={invoke,transformCallback:fn=>{callbacks.set(++callbackId,fn);return callbackId;},unregisterCallback:id=>callbacks.delete(id),metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}}};
      window.__TAURI__={core:{invoke}};
      fixture.emit=(index,payload)=>{const channel=fixture.registered[index];callbacks.get(channel.id)({index:0,message:{extra:payload}});};
      const original=fetch;window.fetch=async(input,options)=>{
        const url=input instanceof Request?input.url:String(input);if(!url.includes('/_serverFn/${inboxId}'))return original(input,options);
        fixture.readCount++;const hold=fixture.readMode==='hold';const response=await original(input,hold?{...options,signal:new AbortController().signal}:options);
        if(!hold)return response;const bytes=await response.arrayBuffer();return new Promise(resolve=>fixture.heldReads.push(()=>resolve(new Response(bytes,{status:response.status,headers:response.headers}))));
      };`,
        });
        const check = (expression, label, timeout = 18_000) =>
          poll(() => evaluate(expression), label, timeout).catch(
            async (error) => {
              console.error(
                JSON.stringify({
                  label,
                  state: await evaluate(
                    "({text:document.body.innerText,errors:desktopFixture.errors,sent:desktopFixture.sent,attempts:desktopFixture.attempts,reads:desktopFixture.readCount,registered:desktopFixture.registered.length,removed:desktopFixture.removed})",
                  ),
                }),
              );
              throw error;
            },
          );
        const retry = async () => {
          const point = await check(
            `(async()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent==='Retry desktop alerts'&&!b.disabled);if(!b)return null;b.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const q=b.getBoundingClientRect(),x=q.x+q.width/2,y=q.y+q.height/2;return b.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`,
            "reachable native alert retry",
          );
          for (const type of ["mousePressed", "mouseReleased"])
            await page("Input.dispatchMouseEvent", {
              type,
              button: "left",
              clickCount: 1,
              ...point,
            });
        };
        const sizes = async (label) => {
          for (const [width, height] of [
            [320, 480],
            [768, 1000],
            [1440, 1000],
          ]) {
            await page("Emulation.setDeviceMetricsOverride", {
              width,
              height,
              deviceScaleFactor: 1,
              mobile: false,
            });
            await check(
              width < 1024
                ? "!!document.querySelector('button[aria-label=\"Open menu\"]')&&document.querySelector('aside[aria-hidden=\"true\"]')?.getBoundingClientRect().right<=0"
                : "!document.querySelector('button[aria-label=\"Open menu\"]')",
              "responsive navigation settled",
            );
            await check(
              `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent==='Retry desktop alerts');if(!b)return false;const q=b.getBoundingClientRect();return q.height>=44&&q.width>=44&&q.left>=0&&q.right<=innerWidth&&q.bottom<=innerHeight&&b.contains(document.elementFromPoint(q.x+q.width/2,q.y+q.height/2));})()`,
              "desktop retry fits " + width,
            );
            if (width === 320)
              await writeFile(
                "/tmp/showpilot-desktop-notification-" + label + "-320.png",
                Buffer.from(
                  (await page("Page.captureScreenshot", { format: "png" }))
                    .data,
                  "base64",
                ),
              );
          }
        };
        await page("Page.navigate", { url: `${origin}/${orgId}/show` });
        await poll(() => heldModules.length, "native delivery module held");
        await check(
          "document.body.innerText.includes('Desktop alerts could not start')",
          "native module deadline",
        );
        assert.equal(await evaluate("desktopFixture.readCount"), 0);
        await sizes("module");
        for (const requestId of heldModules)
          await page("Fetch.continueRequest", { requestId });
        await page("Fetch.disable");
        await check(
          "performance.getEntriesByType('resource').some(x=>x.name.includes('desktop-notification-delivery-')&&x.responseEnd>0)",
          "late module loaded",
        );
        assert.equal(
          await evaluate("desktopFixture.readCount"),
          0,
          "Late module does not start expired setup",
        );
        await retry();
        await check(
          "document.body.innerText.includes('Desktop alerts could not be checked')&&document.body.innerText.includes('actions could not connect')",
          "inbox and listener deadlines",
        );
        await sizes("delivery");
        await evaluate(
          "desktopFixture.readMode='normal';desktopFixture.registrationMode='normal';desktopFixture.heldReads.splice(0).forEach(r=>r());true",
        );
        assert.equal(await evaluate("desktopFixture.sent.length"), 0);
        await retry();
        await check(
          "desktopFixture.sent.length===1&&document.body.innerText.includes('could not be delivered')",
          "partial delivery retains first alert",
        );
        assert.deepEqual(await evaluate("desktopFixture.sent.map(x=>x.id)"), [
          "desktop-a",
        ]);
        assert.ok(
          (
            await evaluate(
              "localStorage.getItem('showpilot.desktop-notifications.v1:smoke-operator:display-smoke')",
            )
          ).includes("desktop-a"),
        );
        await evaluate(
          "desktopFixture.heldRegistrations.splice(0).forEach(r=>r());true",
        );
        await check(
          "desktopFixture.removed.length===1",
          "retire late native listener",
        );
        await evaluate(
          "desktopFixture.emit(0,{notificationId:'desktop-a',orgSlug:'display-smoke',actionUrl:'schedule'});true",
        );
        assert.equal(
          await evaluate("desktopFixture.focusCount"),
          0,
          "Retired listener cannot navigate",
        );
        await evaluate(
          "desktopFixture.permissionMode='hold';desktopFixture.sendMode='normal';true",
        );
        await retry();
        await check(
          "desktopFixture.heldPermissions.length===1",
          "permission request held",
        );
        const reads = await evaluate("desktopFixture.readCount");
        await evaluate(
          "for(let i=0;i<3;i++)dispatchEvent(new Event('showpilot-desktop-notification-poll'));true",
        );
        assert.equal(
          await evaluate("desktopFixture.readCount"),
          reads,
          "Poll retries coalesce",
        );
        await check(
          "document.body.innerText.includes('could not be delivered')&&!document.body.innerText.includes('Retrying alerts')",
          "native permission deadline",
        );
        await evaluate(
          "desktopFixture.permissionMode='normal';desktopFixture.heldPermissions.splice(0).forEach(r=>r());Storage.prototype.setItem=function(){throw new Error('Fixture storage full')};true",
        );
        assert.equal(
          await evaluate("desktopFixture.sent.length"),
          1,
          "Late permission cannot send expired alert",
        );
        await retry();
        await check(
          "desktopFixture.sent.length===3&&!document.body.innerText.includes('Retry desktop alerts')",
          "native alert recovery",
        );
        assert.deepEqual(await evaluate("desktopFixture.sent.map(x=>x.id)"), [
          "desktop-a",
          "desktop-b",
          "desktop-c",
        ]);
        const checked = await evaluate("desktopFixture.readCount");
        await evaluate(
          "dispatchEvent(new Event('showpilot-desktop-notification-poll'));true",
        );
        await check(
          `desktopFixture.readCount>${checked}`,
          "recheck after storage failure",
        );
        await check(
          "!document.body.innerText.includes('Retry desktop alerts')",
          "memory history recheck finished",
        );
        assert.equal(await evaluate("desktopFixture.sent.length"), 3);
        assert.deepEqual(await evaluate("desktopFixture.errors"), []);
        assert.equal(await evaluate("desktopFixture.document"), "same");
        const rows = await queryFixture(
          "SELECT id,readAt FROM notification WHERE id LIKE 'desktop-%'",
        );
        assert.equal(rows.length, 4);
        assert.ok(
          rows.every((row) => row.readAt === null),
          "Delivery never marks the inbox read",
        );
        // Native focus may hang; the validated action must still navigate after its deadline.
        await evaluate(
          "desktopFixture.emit(1,{notificationId:'desktop-b',orgSlug:'display-smoke',actionUrl:'schedule'});true",
        );
        await check(
          "location.pathname==='/display-smoke/schedule'",
          "notification action survives native focus timeout",
        );
      },
    );
    console.log(
      JSON.stringify({
        passed: true,
        realAuthDatabase: true,
        nativeTransport: "simulated IPC and Notification constructor",
        moduleReadAndPermissionDeadlines: true,
        listenerCleanup: true,
        partialDeliveryCheckpoint: true,
        memoryFallback: true,
        widths: [320, 768, 1440],
      }),
    );
  },
  { desktopNotificationRecovery: true },
);
