import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";

const assets = resolve(import.meta.dirname, "../dist/server/assets");
let endpoint;
for (const file of (await readdir(assets)).filter(
  (file) => file.startsWith("rbac-") && file.endsWith(".js"),
)) {
  const source = await readFile(resolve(assets, file), "utf8");
  endpoint ??= source.match(
    /const validateRundownPin_createServerFn_handler = createServerRpc\(\{\s*id: "([^"]+)"/,
  )?.[1];
}
assert.ok(endpoint, "Find actual compiled PIN endpoint");
await withLocalSmokeFixture(
  async ({ origin, orgId, operatorPassword }) => {
    const login = await fetch(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "second@display-smoke.invalid",
        password: operatorPassword,
      }),
    });
    assert.equal(login.status, 200);
    await login.arrayBuffer();
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    await withRealBrowser(
      { origin, cookie },
      async ({ page, evaluate, onPageEvent }) => {
        const errors = [];
        await page("Page.enable");
        await page("Runtime.enable");
        await page("Emulation.setFocusEmulationEnabled", { enabled: true });
        onPageEvent((event) => {
          if (event.method === "Runtime.exceptionThrown")
            errors.push(event.params.exceptionDetails.text);
        });
        await page("Page.navigate", { url: `${origin}/${orgId}/rundown-pin` });
        await poll(
          () =>
            evaluate(
              `(()=>{const el=document.querySelector('#rundown-pin');return el&&Object.keys(el).some(key=>key.startsWith('__reactProps'));})()`,
            ),
          "PIN page hydrated",
        );
        const installFaults = () =>
          evaluate(
            `(()=>{const original=window.fetch;window.pinDocument='same';window.heldPins=[];window.holdPin=true;window.fetch=(input,init)=>{const url=input instanceof Request?input.url:String(input);if(window.holdPin&&url.includes('/_serverFn/${endpoint}')){const response=original(input,{...init,signal:new AbortController().signal}).then(async r=>new Response(await r.arrayBuffer(),{status:r.status,headers:r.headers}));return new Promise(resolve=>window.heldPins.push(async()=>resolve(await response)));}return original(input,init);};return true;})()`,
          );
        await installFaults();
        const fill = (pin) =>
          evaluate(
            `(()=>{const el=document.querySelector('#rundown-pin, #rundown-unlock-pin');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(pin)});el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`,
          );
        const submit = () =>
          evaluate(
            `(document.querySelector('[role=dialog] form button[type=submit]')??document.querySelector('form button[type=submit]')).click();true`,
          );
        await fill("1842");
        await submit();
        await poll(
          () => evaluate("window.heldPins.length===1"),
          "real valid reply held",
        );
        await poll(
          () =>
            evaluate(
              `!!document.querySelector('[role=alert] time')&&!document.querySelector('form button[type=submit]').disabled`,
            ),
          "verification timeout has timestamp and retry",
          20_000,
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
          await poll(
            () =>
              evaluate(
                `(()=>{const el=document.querySelector('form button[type=submit]');el.scrollIntoView({block:'center'});const b=el.getBoundingClientRect();return b.width>=44&&b.height>=44&&b.left>=0&&b.right<=innerWidth&&el.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))&&document.documentElement.scrollWidth<=innerWidth;})()`,
              ),
            `retry reachable at ${width}`,
          );
          if (width === 320)
            await writeFile(
              "/tmp/showpilot-rundown-pin-recovery-320.png",
              Buffer.from(
                (await page("Page.captureScreenshot", { format: "png" })).data,
                "base64",
              ),
            );
        }
        await evaluate(
          "window.holdPin=false;Promise.all(window.heldPins.splice(0).map(release=>release())).then(()=>true)",
        );
        assert.equal(
          await evaluate(
            `location.pathname==='/${orgId}/rundown-pin'&&!document.cookie.includes('1842')`,
          ),
          true,
          "Late success cannot unlock after timeout",
        );
        await fill("0000");
        await submit();
        await poll(
          () =>
            evaluate(
              `document.querySelector('[role=alert]')?.textContent.includes('Incorrect PIN')&&!document.querySelector('form button[type=submit]').disabled`,
            ),
          "invalid PIN is recoverable",
        );
        await fill("1842");
        await submit();
        await poll(
          () =>
            evaluate(
              `location.pathname==='/${orgId}/rundown'&&!!document.querySelector('.rundown-page')`,
            ),
          "valid retry opens rundown",
        );
        assert.equal(
          await evaluate("window.pinDocument"),
          "same",
          "Unlock uses app navigation",
        );
        const buttonNamed = (name) =>
          `[...document.querySelectorAll('button')].find(el=>el.textContent.trim()===${JSON.stringify(name)})`;
        const clickButton = async (name) => {
          const point = await poll(
            () =>
              evaluate(
                `(async()=>{const el=${buttonNamed(name)};if(!el||el.disabled||!Object.keys(el).some(k=>k.startsWith('__reactProps')))return null;el.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=el.getBoundingClientRect();return el.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))?{x:b.x+b.width/2,y:b.y+b.height/2}:null;})()`,
              ),
            name,
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
        await clickButton("Lock changes");
        await poll(
          () =>
            evaluate(
              `window.pinDocument===undefined&&!!(${buttonNamed("Unlock changes")})`,
            ),
          "Lock reconnects without write authority",
        );
        await installFaults();
        await clickButton("Unlock changes");
        await poll(
          () => evaluate(`!!document.querySelector('#rundown-unlock-pin')`),
          "inline PIN dialog",
        );
        await fill("1842");
        await submit();
        await poll(
          () =>
            evaluate(
              `!!document.querySelector('[role=dialog] [role=alert] time')&&!document.querySelector('[role=dialog] button[type=submit]').disabled`,
            ),
          "inline verification has timeout and Retry",
          20_000,
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
          await poll(
            () =>
              evaluate(
                `(()=>{const el=document.querySelector('[role=dialog] button[type=submit]');el.scrollIntoView({block:'center'});const b=el.getBoundingClientRect(),d=el.closest('[role=dialog]').getBoundingClientRect();return b.width>=44&&b.height>=44&&d.left>=0&&d.right<=innerWidth&&d.top>=0&&d.bottom<=innerHeight&&el.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))&&[...el.closest('[role=dialog]').querySelectorAll('button,input')].every(control=>{const r=control.getBoundingClientRect();return r.width>=44&&r.height>=44;});})()`,
              ),
            `inline recovery fits at ${width}`,
          );
          if (width === 320)
            await writeFile(
              "/tmp/showpilot-rundown-pin-dialog-320.png",
              Buffer.from(
                (await page("Page.captureScreenshot", { format: "png" })).data,
                "base64",
              ),
            );
        }

        await evaluate(
          "window.holdPin=false;Promise.all(window.heldPins.splice(0).map(release=>release())).then(()=>true)",
        );
        assert.equal(
          await evaluate(
            `!document.cookie.includes('1842')&&!!document.querySelector('[role=dialog]')`,
          ),
          true,
          "Inline late success stays locked",
        );
        await evaluate("window.holdPin=true;true");
        await submit();
        await poll(
          () => evaluate("window.heldPins.length===1"),
          "second inline reply held",
        );
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
        await poll(
          () => evaluate(`!document.querySelector('[role=dialog]')`),
          "Escape closes pending verification",
        );
        await evaluate(
          "window.holdPin=false;Promise.all(window.heldPins.splice(0).map(release=>release())).then(()=>true)",
        );
        assert.equal(
          await evaluate(
            `!document.cookie.includes('1842')&&window.pinDocument==='same'`,
          ),
          true,
          "Closing prevents late unlock or reload",
        );
        await clickButton("Unlock changes");
        await poll(
          () => evaluate(`!!document.querySelector('#rundown-unlock-pin')`),
          "dialog reopens",
        );
        await fill("1842");
        await submit();
        await poll(
          () =>
            evaluate(
              `window.pinDocument===undefined&&!!(${buttonNamed("Lock changes")})`,
            ),
          "inline success reconnects with write authority",
        );
        assert.deepEqual(errors, []);
      },
    );
    console.log(
      JSON.stringify({
        passed: true,
        timeout: true,
        lateSuccessIgnored: true,
        wrongPin: true,
        successfulRetry: true,
        inlineTimeout: true,
        escapeCancels: true,
        inlineReconnect: true,
        widths: [320, 768, 1440],
      }),
    );
  },
  { hiddenNavigation: true, secondOperator: true, paidPlan: true },
);
