import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";

await withLocalSmokeFixture(
  async ({ origin, orgId, operatorCookie, capturedEmails }) => {
    await withRealBrowser(
      { origin, cookie: operatorCookie },
      async ({ page, evaluate, onPageEvent }) => {
        const errors = [];
        await page("Runtime.enable");
        await page("Page.enable");
        onPageEvent((event) => {
          if (event.method === "Runtime.exceptionThrown")
            errors.push(
              event.params.exceptionDetails.exception?.description ??
                event.params.exceptionDetails.text,
            );
        });
        await page("Emulation.setFocusEmulationEnabled", { enabled: true });
        const check = (fn, label) =>
          poll(fn, label).catch(async (error) => {
            console.log(
              JSON.stringify({
                label,
                body: await evaluate("document.body?.innerText"),
                errors,
              }),
            );
            await writeFile(
              "/tmp/showpilot-schedule-calendar-failure.png",
              Buffer.from(
                (await page("Page.captureScreenshot", { format: "png" })).data,
                "base64",
              ),
            );
            throw error;
          });
        const click = async (selector) => {
          const point = await check(
            () =>
              evaluate(
                `(async()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled||!Object.keys(el).some(key=>key.startsWith('__reactProps')))return null;el.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=el.getBoundingClientRect();return el.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))?{x:b.x+b.width/2,y:b.y+b.height/2}:null;})()`,
              ),
            selector,
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
          await page("Page.navigate", {
            url: `${origin}/${orgId}/schedule?month=2099-01`,
          });
          await check(
            () =>
              evaluate(
                `document.querySelector('input[aria-label="Calendar month"]')?.value==='2099-01'`,
              ),
            "calendar loads the requested month",
          );
          const header = await evaluate(
            `(()=>{const heading=[...document.querySelectorAll('h1')].find(el=>el.textContent.trim()==='Schedule');const h=heading.getBoundingClientRect();return [...heading.closest('header').querySelectorAll('button')].map(el=>{const b=el.getBoundingClientRect();return {text:el.textContent.trim(),height:b.height,width:b.width,overlap:b.left<h.right&&b.right>h.left&&b.top<h.bottom&&b.bottom>h.top};});})()`,
          );
          assert.ok(
            header.every(
              (button) =>
                !button.overlap && button.height >= 44 && button.width >= 44,
            ),
            JSON.stringify({ width, header }),
          );
          if (width < 1024)
            await click('button[aria-controls="schedule-calendar"]');
          await check(
            () =>
              evaluate(
                `document.querySelector('h2')?.textContent.trim()==='Assignment keyboard fixture'`,
              ),
            "future show outside the default window loads",
          );
          const sizes = await evaluate(
            `(()=>{const controls=[...document.querySelectorAll('#schedule-calendar button,#schedule-calendar input')];return controls.filter(el=>{const r=el.getBoundingClientRect();return r.width<44||r.height<44}).map(el=>({text:el.textContent,label:el.getAttribute('aria-label'),width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height}));})()`,
          );
          assert.deepEqual(sizes, [], JSON.stringify({ width, sizes }));
          const overlaps = await evaluate(
            `(()=>{const days=[...document.querySelectorAll('#schedule-calendar button[data-date]')];return days.flatMap((a,i)=>days.slice(i+1).filter(b=>{const x=a.getBoundingClientRect(),y=b.getBoundingClientRect();return x.left<y.right-1&&x.right>y.left+1&&x.top<y.bottom-1&&x.bottom>y.top+1}).map(b=>[a.dataset.date,b.dataset.date]));})()`,
          );
          assert.deepEqual(overlaps, [], "Calendar days never overlap");

          assert.equal(
            await evaluate("document.documentElement.scrollWidth<=innerWidth"),
            true,
          );
          await evaluate("window.calendarDocument='same';true");
          await click('#schedule-calendar button[aria-label="Next month"]');
          await check(
            () =>
              evaluate(
                `new URL(location.href).searchParams.get('month')==='2099-02'&&document.querySelector('input[aria-label="Calendar month"]')?.value==='2099-02'`,
              ),
            "next month reloads calendar data",
          );
          assert.equal(
            await evaluate(
              `document.querySelector('#schedule-calendar button[data-date="2099-02-09"]')?.disabled`,
            ),
            false,
            "February shows are fetched when the month changes",
          );
          assert.equal(
            await evaluate(`document.querySelector('h2')?.textContent.trim()`),
            "Assignment keyboard fixture",
            "Month browsing retains the selected show",
          );
          await evaluate("history.back();true");
          await check(
            () =>
              evaluate(
                `new URL(location.href).searchParams.get('month')==='2099-01'&&document.querySelector('input[aria-label="Calendar month"]')?.value==='2099-01'`,
              ),
            "Back restores the viewed month",
          );
          assert.equal(await evaluate("window.calendarDocument"), "same");
          await click('#schedule-calendar button[aria-label="Next month"]');
          await check(
            () =>
              evaluate(
                `document.querySelector('input[aria-label="Calendar month"]')?.value==='2099-02'`,
              ),
            "February loaded",
          );
          await evaluate(
            `(()=>{const el=document.querySelector('input[aria-label="Calendar month"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'2099-01');el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`,
          );
          await check(
            () =>
              evaluate(
                `new URL(location.href).searchParams.get('month')==='2099-01'`,
              ),
            "month picker supports a direct jump",
          );
          await click('#schedule-calendar button[data-date="2099-01-01"]');
          await check(
            () =>
              evaluate(
                `new URL(location.href).searchParams.get('show')==='assignment-show'&&new URL(location.href).searchParams.get('date')==='2099-01-01'`,
              ),
            "calendar day selects the actual show",
          );
          if (width === 320)
            await page("Emulation.setDeviceMetricsOverride", {
              width: 320,
              height: 740,
              deviceScaleFactor: 1,
              mobile: false,
            });
          if (width === 320)
            await evaluate(
              `document.querySelector('#schedule-calendar').scrollIntoView({block:'start'});true`,
            );
          if (width === 320)
            await writeFile(
              "/tmp/showpilot-schedule-calendar-320.png",
              Buffer.from(
                (await page("Page.captureScreenshot", { format: "png" })).data,
                "base64",
              ),
            );
        }
        assert.deepEqual(errors, []);
      },
    );
    assert.equal((await capturedEmails()).length, 0);
    console.log(
      JSON.stringify({
        passed: true,
        widths: [320, 768, 1440],
        futureMonth: true,
        monthPicker: true,
        history: true,
        selectedShowPreserved: true,
        calendarDaySelectsShow: true,
        externalEmails: 0,
      }),
    );
  },
  {
    personalAssignments: true,
    calendarNavigation: true,
    paidPlan: true,
    captureEmail: true,
  },
);
