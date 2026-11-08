// Real Schedule dialogs: no writes, emails, or production data.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";

const audit = process.argv.includes("--audit");
const findings = [];
await withLocalSmokeFixture(
  async ({ origin, orgId, operatorCookie, capturedEmails }) => {
    await withRealBrowser(
      { origin, cookie: operatorCookie },
      async ({ page, evaluate, onPageEvent }) => {
        const errors = [];
        await page("Runtime.enable");
        onPageEvent((event) => {
          if (event.method === "Runtime.exceptionThrown")
            errors.push(
              event.params.exceptionDetails.exception?.description ??
                event.params.exceptionDetails.text,
            );
        });
        await page("Page.enable");
        await page("Page.bringToFront");
        await page("Emulation.setFocusEmulationEnabled", { enabled: true });
        const button = (name) =>
          `[...document.querySelectorAll('button')].find(el => (el.getAttribute('aria-label') === ${JSON.stringify(name)} || el.textContent.trim() === ${JSON.stringify(name)}) && el.getBoundingClientRect().height > 0 && !el.disabled && !el.closest('[inert]'))`;
        const click = async (name) => {
          const point = await poll(
            () =>
              evaluate(`(async()=>{
        const el=${button(name)};if(!el||!Object.keys(el).some(key=>key.startsWith('__reactProps')))return null;
        el.scrollIntoView({block:'center'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))?{x:r.x+r.width/2,y:r.y+r.height/2}:null;
      })()`),
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
        const key = async (name, code, modifiers = 0) => {
          await page("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: name,
            code: name,
            windowsVirtualKeyCode: code,
            modifiers,
          });
          await page("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: name,
            code: name,
            windowsVirtualKeyCode: code,
            modifiers,
          });
        };
        const dialogs = [
          ["Manage source", "Scheduling source"],
          ["Inventory", "Show inventory"],
          ["New service", "New service"],
          ["Edit Assignment keyboard fixture", "Show details"],
          ["Build a team", "Build a team"],
          ["Add position", "Add position"],
          ["Edit Camera operator", "Edit assignment"],
        ];
        for (const [width, height] of [
          [320, 480],
          [768, 900],
          [1440, 900],
        ]) {
          await page("Emulation.setLocaleOverride", {
            locale: width === 320 ? "en-GB" : width === 768 ? "en-US" : "en-CA",
          });
          await page("Emulation.setDeviceMetricsOverride", {
            width,
            height,
            deviceScaleFactor: 1,
            mobile: false,
          });
          await page("Page.navigate", {
            url: `${origin}/${orgId}/schedule?show=assignment-show&date=2099-01-01`,
          });
          await poll(
            () => evaluate(`!!${button("Manage source")}`),
            "Schedule ready",
          );
          await poll(
            () =>
              evaluate(
                `document.querySelector('main').innerText.includes(new Date('2099-01-01T12:00:00').toLocaleDateString([], {weekday:'long',month:'long',day:'numeric',year:'numeric'}))`,
              ),
            "Schedule uses the browser locale after hydration",
          );
          for (const [opener, title] of dialogs) {
            await click(opener);
            await poll(
              () => evaluate(`!!document.querySelector('[role="dialog"]')`),
              title,
            );
            await new Promise((resolve) => setTimeout(resolve, 250));
            const metrics = await evaluate(`(()=>{
          const dialog=document.querySelector('[role="dialog"]'),r=dialog.getBoundingClientRect();
          const controls=[...dialog.querySelectorAll('button,input:not([type=checkbox]),select,textarea')].filter(el=>el.getBoundingClientRect().height>0);
          const fields=controls.filter(el=>el.tagName!=='BUTTON');
          const label=el=>el.getAttribute('aria-label')||[...el.labels??[]].map(label=>label.textContent.trim()).join(' ')||(el.getAttribute('aria-labelledby')||'').split(' ').map(id=>document.getElementById(id)?.textContent||'').join(' ').trim();
          return {focusInside:dialog.contains(document.activeElement),fits:r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth&&document.documentElement.scrollWidth<=innerWidth,
            unlabeled:fields.filter(el=>!label(el)).map(el=>({tag:el.tagName,placeholder:el.getAttribute('placeholder')})),
            small:controls.filter(el=>el.getBoundingClientRect().height<44).map(el=>({label:label(el)||el.textContent.trim(),height:el.getBoundingClientRect().height}))};
        })()`);
            await evaluate(
              `(()=>{const controls=[...document.querySelector('[role="dialog"]').querySelectorAll('button,input,select,textarea,a[href]')].filter(el=>!el.disabled&&el.getBoundingClientRect().height>0&&el.tabIndex>=0);controls.at(-1).focus();return true;})()`,
            );
            await key("Tab", 9);
            metrics.forwardTrap = await evaluate(
              `document.querySelector('[role="dialog"]').contains(document.activeElement)`,
            );
            await key("Tab", 9, 8);
            metrics.reverseTrap = await evaluate(
              `document.querySelector('[role="dialog"]').contains(document.activeElement)`,
            );
            if (width === 320)
              await writeFile(
                `/tmp/showpilot-schedule-${title.replaceAll(" ", "-")}-320.png`,
                Buffer.from(
                  (await page("Page.captureScreenshot", { format: "png" }))
                    .data,
                  "base64",
                ),
              );
            await key("Escape", 27);
            await new Promise((resolve) => setTimeout(resolve, 300));
            metrics.escapeClosed = await evaluate(
              `!document.querySelector('[role="dialog"]')`,
            );
            if (!metrics.escapeClosed) await click(`Close ${title}`);
            await poll(
              () => evaluate(`!document.querySelector('[role="dialog"]')`),
              "dialog closed",
            );
            metrics.focusReturned = await evaluate(
              `document.activeElement===${button(opener)}`,
            );
            findings.push({ title, width, ...metrics });
            console.log(JSON.stringify(findings.at(-1)));
            if (!audit)
              assert.deepEqual(
                {
                  ...metrics,
                  unlabeled: metrics.unlabeled,
                  small: metrics.small,
                },
                {
                  focusInside: true,
                  fits: true,
                  unlabeled: [],
                  small: [],
                  forwardTrap: true,
                  reverseTrap: true,
                  escapeClosed: true,
                  focusReturned: true,
                },
              );
          }
        }
        assert.deepEqual(errors, []);
      },
    );
    assert.equal((await capturedEmails()).length, 0);
    console.log(
      JSON.stringify({
        passed: !audit,
        dialogs: 7,
        widths: [320, 768, 1440],
        externalEmails: 0,
        findings,
      }),
    );
  },
  { personalAssignments: true, captureEmail: true, paidPlan: true },
);
