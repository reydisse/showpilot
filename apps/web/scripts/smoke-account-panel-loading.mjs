import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";

await withLocalSmokeFixture(
  async ({ origin, orgId, operatorCookie, capturedEmails }) => {
    for (const [label, chunk, ready, fault = "hold"] of [
      [
        "Profile and account",
        "ProfileModal",
        `!!document.querySelector('#profile-account-heading')`,
      ],
      [
        "Notifications",
        "NotificationCenter",
        `document.querySelector('[role=dialog]')?.textContent.includes('Nothing waiting for you.')`,
      ],
      [
        "Profile and account",
        "AccountPanels",
        `!!document.querySelector('#profile-account-heading')`,
      ],
      [
        "Profile and account",
        "ProfileModal",
        `!!document.querySelector('#profile-account-heading')`,
        "network",
      ],
    ]) {
      if (process.argv.includes("--network-only") && fault !== "network")
        continue;
      await withRealBrowser(
        { origin, cookie: operatorCookie },
        async ({ page, evaluate, onPageEvent }) => {
          const errors = [];
          await page("Runtime.enable");
          onPageEvent((event) => {
            if (event.method === "Runtime.exceptionThrown")
              errors.push(event.params.exceptionDetails.text);
          });
          if (fault === "network")
            onPageEvent((event) => {
              if (event.method === "Fetch.requestPaused")
                void page("Fetch.failRequest", {
                  requestId: event.params.requestId,
                  errorReason: "Failed",
                }).catch((error) => errors.push(String(error)));
            });
          await page("Page.enable");
          await page("Emulation.setFocusEmulationEnabled", { enabled: true });
          await page("Emulation.setDeviceMetricsOverride", {
            width: 1440,
            height: 900,
            deviceScaleFactor: 1,
            mobile: false,
          });
          if (chunk === "AccountPanels") await page("Fetch.enable", {
            patterns: [{ urlPattern: `*/assets/${chunk}-*.js`, requestStage: "Request" }],
          });
          await page("Page.navigate", { url: `${origin}/${orgId}/show` });
          const button = (text) =>
            `[...document.querySelectorAll('button')].find(el=>el.textContent.trim()===${JSON.stringify(text)})`;
          const click = async (expression) => {
            const point = await poll(
              () =>
                evaluate(
                  `(async()=>{const el=${expression};if(!el||el.disabled||!Object.keys(el).some(key=>key.startsWith('__reactProps')))return null;el.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=el.getBoundingClientRect();return el.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))?{x:b.x+b.width/2,y:b.y+b.height/2}:null;})()`,
                ),
              "account control ready",
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
          await click(`document.querySelector('button[title="Account menu"]')`);
          await evaluate("window.accountDocument='same';true");
          if (chunk !== "AccountPanels") await page("Fetch.enable", {
            patterns: [
              { urlPattern: `*/assets/${chunk}-*.js`, requestStage: "Request" },
            ],
          });
          await click(button(label));
          if (fault === "hold")
            await poll(
              () =>
                evaluate(
                  `!!document.querySelector('[aria-label="Loading account view"]')`,
                ),
              "account view begins loading",
            );
          await poll(
            () =>
              evaluate(
                `!!document.querySelector('[role=alert][aria-label="Account view unavailable"] time')`,
              ),
            "stalled account view offers recovery",
            20_000,
          );
          assert.equal(
            await evaluate(
              `!!document.querySelector('[aria-label="Loading account view"]')`,
            ),
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
            await poll(
              () =>
                evaluate(
                  `(()=>{const el=${button("Retry account view")};if(!el)return false;el.scrollIntoView({block:'center'});const b=el.getBoundingClientRect();return b.width>=44&&b.height>=44&&b.left>=0&&b.right<=innerWidth&&el.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2));})()`,
                ),
              `Retry fits ${width}`,
            );
            if (width === 320)
              await writeFile(
                `/tmp/showpilot-account-${chunk}-320.png`,
                Buffer.from(
                  (await page("Page.captureScreenshot", { format: "png" }))
                    .data,
                  "base64",
                ),
              );
          }
          await page("Fetch.disable");
          assert.equal(
            await evaluate(
              `!!document.querySelector('[aria-label="Account view unavailable"]')`,
            ),
            true,
            "A late module cannot hide the failed attempt",
          );
          await click(button("Retry account view"));
          await poll(() => evaluate(ready), `${label} recovers`);
          assert.equal(await evaluate("window.accountDocument"), "same");
          if (label === "Profile and account") {
            await evaluate(
              `(()=>{const el=document.querySelector('#profile-display-name');window.accountDraftNode=el;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'Unsubmitted account draft');el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`,
            );
            for (const width of [320, 768, 1440]) {
              await page("Emulation.setDeviceMetricsOverride", {
                width,
                height: 900,
                deviceScaleFactor: 1,
                mobile: false,
              });
              assert.equal(
                await evaluate(
                  `(async()=>{await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return document.querySelector('#profile-display-name')===window.accountDraftNode&&window.accountDraftNode.value==='Unsubmitted account draft';})()`,
                ),
                true,
                `profile draft survives ${width}`,
              );
            }
          }

          await click(
            `document.querySelector('button[aria-label="Back to account"]')`,
          );
          assert.deepEqual(errors, []);
          console.log(
            JSON.stringify({
              passed: true,
              chunk,
              fault,
              profileDraftPreserved: label === "Profile and account",
              realDownloadTimeout: fault === "hold",
              networkFailure: fault === "network",
              retryWithoutReload: true,
              widths: [320, 768, 1440],
            }),
          );
        },
      );
    }
    assert.equal((await capturedEmails()).length, 0);
  },
  { captureEmail: true },
);
