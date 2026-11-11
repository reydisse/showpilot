import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";

async function clickTarget(page, evaluate, selector) {
  const point = await poll(
    () =>
      evaluate(
        `(async()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled||!Object.keys(el).some(key=>key.startsWith('__reactProps')))return null;el.scrollIntoView({block:'center'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))?{x:r.x+r.width/2,y:r.y+r.height/2}:null;})()`,
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
}

async function checkBreadcrumb(
  { page, evaluate, origin, orgId },
  { path, current, parent, heading, active },
) {
  for (const [width, height] of [
    [320, 480],
    [768, 900],
    [1440, 600],
  ]) {
    await page("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page("Page.navigate", { url: `${origin}/${orgId}/${path}` });
    await poll(
      () =>
        evaluate(
          `document.querySelector('[aria-label="Breadcrumb"] [aria-current="page"]')?.textContent === ${JSON.stringify(current)}`,
        ),
      `${path} breadcrumb`,
    ).catch(async (error) => {
      console.log(
        JSON.stringify({
          path,
          width,
          location: await evaluate("location.href"),
          body: await evaluate("document.body.innerText"),
          runtimeErrors,
        }),
      );
      await writeFile(
        "/tmp/showpilot-navigation-failure.png",
        Buffer.from(
          (await page("Page.captureScreenshot", { format: "png" })).data,
          "base64",
        ),
      );
      throw error;
    });
    const selector = '[aria-label="Breadcrumb"] a';
    const bounds = await poll(
      () =>
        evaluate(`(async () => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!Object.keys(el).some(key => key.startsWith('__reactProps'))) return null;
      el.scrollIntoView({block:'center'});
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const r = el.getBoundingClientRect();
      if (!el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))) return null;
      return {height:r.height, width:r.width, left:r.left, right:r.right, reachable:true, pageWidth:document.documentElement.scrollWidth};
    })()`),
      `${path} hydrated and reachable breadcrumb`,
    );
    assert.ok(
      bounds.height >= 44 &&
        bounds.width >= 44 &&
        bounds.left >= 0 &&
        bounds.right <= width &&
        bounds.reachable &&
        bounds.pageWidth <= width,
      JSON.stringify({ path, width, bounds }),
    );
    if (active)
      assert.equal(
        await evaluate(
          `!!document.querySelector('aside a[title=${JSON.stringify(active)}][aria-current="page"]')`,
        ),
        true,
      );
    if (width === 320)
      await writeFile(
        `/tmp/showpilot-breadcrumb-${path.replaceAll("/", "-")}-320.png`,
        Buffer.from(
          (await page("Page.captureScreenshot", { format: "png" })).data,
          "base64",
        ),
      );
    await evaluate("window.breadcrumbDocument='same';true");
    await clickTarget(page, evaluate, selector);
    await poll(
      () =>
        evaluate(
          `location.pathname === ${JSON.stringify(`/${orgId}/${parent}`)} && [...document.querySelectorAll('h1,h2')].some(el => el.textContent.trim() === ${JSON.stringify(heading)})`,
        ),
      `${path} parent renders`,
    );
    assert.equal(
      await evaluate("window.breadcrumbDocument"),
      "same",
      `${path} back should preserve the document`,
    );
  }
}

const runtimeErrors = [];
if (!process.argv.includes("--hidden-only"))
  await withLocalSmokeFixture(
    async ({ origin, orgId, operatorCookie, operatorPassword }) => {
      await withRealBrowser(
        { origin, cookie: operatorCookie },
        async ({ page, evaluate, onPageEvent }) => {
          await page("Page.enable");
          await page("Runtime.enable");
          onPageEvent((event) => {
            if (event.method === "Runtime.exceptionThrown")
              runtimeErrors.push(event.params.exceptionDetails.text);
          });
          await page("Page.bringToFront");
          await page("Emulation.setFocusEmulationEnabled", { enabled: true });
          await page("Emulation.setDeviceMetricsOverride", {
            width: 1440,
            height: 600,
            deviceScaleFactor: 1,
            mobile: false,
          });
          await page("Page.navigate", { url: `${origin}/${orgId}/show` });
          const click = (selector) => clickTarget(page, evaluate, selector);
          await click('aside button[title="Fullscreen"]');
          await poll(
            () =>
              evaluate(
                `!document.querySelector('aside') && !!document.querySelector('button[aria-label="Exit fullscreen"]')`,
              ),
            "fullscreen hides the sidebar",
          );
          await click('button[aria-label="Exit fullscreen"]');
          await poll(
            () =>
              evaluate(
                `!!document.querySelector('aside button[title="Fullscreen"]')`,
              ),
            "sidebar returns from fullscreen",
          );
          await click('summary[aria-label="Unavailable pages"]');
          await poll(
            () =>
              evaluate(
                `document.querySelector('details[open]')?.textContent.includes('Turned off in this workspace')`,
              ),
            "disabled feature explained to owner",
          );
          assert.equal(
            await evaluate(
              `!!document.querySelector('aside a[title="Songs"]')`,
            ),
            false,
          );
          assert.equal(
            await evaluate(
              `!!document.querySelector('details[open] a[href*="settings"]')`,
            ),
            true,
            "Owner can reach workspace settings",
          );
          await click('summary[aria-label="Unavailable pages"]');
          await click('aside button[title="Collapse"]');
          await click('summary[aria-label="Unavailable pages"]');
          await poll(
            () =>
              evaluate(
                `!!document.querySelector('aside button[title="Collapse"]')&&!!document.querySelector('details[open]')`,
              ),
            "opening access expands the collapsed sidebar",
          );
          await click('summary[aria-label="Unavailable pages"]');
          await click('aside button[title="Account menu"]');
          await poll(
            () =>
              evaluate(
                `!!document.querySelector('[role="dialog"] a[href="/${orgId}/assignments"]')`,
              ),
            "My assignments entry",
          );
          await evaluate("window.navDocument='same';true");
          await click(`[role="dialog"] a[href="/${orgId}/assignments"]`);
          await poll(
            () =>
              evaluate(
                `location.pathname==='/${orgId}/assignments'&&document.body.innerText.includes('My assignments')&&!document.querySelector('[role="dialog"]')`,
              ),
            "assignments renders from account menu",
          );
          assert.equal(await evaluate("window.navDocument"), "same");
          await page("Page.navigate", {
            url: `${origin}/${orgId}/crew-chat?name=Old%20crew%20name`,
          });
          await poll(
            () =>
              evaluate(
                `location.pathname==='/${orgId}/chat'&&location.search.includes('room=production')&&!!document.querySelector('aside a[title="Chat"][aria-current="page"]')`,
              ),
            "legacy crew chat resolves to canonical Production Chat",
          );
          assert.equal(
            await evaluate("location.search.includes('name=')"),
            false,
          );
          await page("Page.navigate", {
            url: `${origin}/${orgId}/streaming/lt-preview`,
          });
          await poll(
            () =>
              evaluate(
                `!!document.querySelector('aside a[title="Lower Thirds"][aria-current="page"]')`,
              ),
            "Template Studio highlights Lower Thirds",
          );
          await checkBreadcrumb(
            { page, evaluate, origin, orgId },
            {
              path: "streaming/lt-preview",
              current: "Template Studio",
              parent: "streaming/graphics",
              heading: "Lower Thirds",
              active: "Lower Thirds",
            },
          );
          await page("Page.navigate", { url: `${origin}/${orgId}/show` });
          await poll(
            () =>
              evaluate(
                `!!document.querySelector('[aria-label="Workspace navigation"]')`,
              ),
            "workspace navigation",
          );
          const scrollbar = await evaluate(
            `(()=>{const el=document.querySelector('[aria-label="Workspace navigation"]');el.focus();return {overflow:getComputedStyle(el).overflowY,bar:getComputedStyle(el).scrollbarWidth,scrollable:el.scrollHeight>el.clientHeight};})()`,
          );
          assert.ok(
            scrollbar.overflow === "scroll" &&
              scrollbar.bar !== "none" &&
              scrollbar.scrollable,
            JSON.stringify(scrollbar),
          );
          await page("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "PageDown",
            code: "PageDown",
            windowsVirtualKeyCode: 34,
          });
          await page("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "PageDown",
            code: "PageDown",
            windowsVirtualKeyCode: 34,
          });
          await poll(
            () =>
              evaluate(
                `document.querySelector('[aria-label="Workspace navigation"]').scrollTop>0`,
              ),
            "keyboard scroll exposes more pages",
          );
          for (const [width, height] of [
            [320, 480],
            [768, 900],
            [1440, 600],
          ]) {
            await page("Emulation.setDeviceMetricsOverride", {
              width,
              height,
              deviceScaleFactor: 1,
              mobile: false,
            });
            if (width < 1024) await click('button[aria-label="Open menu"]');
            await click('aside button[title="Account menu"]');
            const selector = `[role="dialog"] a[href="/${orgId}/assignments"]`;
            await poll(
              () =>
                evaluate(
                  `!!document.querySelector(${JSON.stringify(selector)})`,
                ),
              "mobile account assignments",
            );
            const target = await evaluate(
              `(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {height:r.height,left:r.left,right:r.right};})()`,
            );
            assert.ok(
              target.height >= 44 && target.left >= 0 && target.right <= width,
              JSON.stringify({ width, target }),
            );
            if (width === 320)
              await writeFile(
                "/tmp/showpilot-navigation-account-320.png",
                Buffer.from(
                  (await page("Page.captureScreenshot", { format: "png" }))
                    .data,
                  "base64",
                ),
              );
            await click(selector);
            await poll(
              () =>
                evaluate(
                  `location.pathname==='/${orgId}/assignments'&&!document.querySelector('[role="dialog"]')`,
                ),
              "account navigation closes",
            );
            // Leave the same route so each mobile transition can close its drawer.
            await page("Page.navigate", { url: `${origin}/${orgId}/show` });
          }
          assert.deepEqual(runtimeErrors, []);
        },
      );
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
          await page("Runtime.enable");
          onPageEvent((event) => {
            if (event.method === "Runtime.exceptionThrown")
              runtimeErrors.push(event.params.exceptionDetails.text);
          });
          const click = (selector) => clickTarget(page, evaluate, selector);
          await page("Emulation.setDeviceMetricsOverride", {
            width: 1440,
            height: 600,
            deviceScaleFactor: 1,
            mobile: false,
          });
          await page("Page.navigate", { url: `${origin}/${orgId}/show` });
          await poll(
            () =>
              evaluate(
                `!!document.querySelector('summary[aria-label="Unavailable pages"]')`,
              ),
            "limited member sees access explanation",
          );
          await click('summary[aria-label="Unavailable pages"]');
          await poll(
            () =>
              evaluate(
                `document.querySelector('details[open]')?.textContent.includes('Requires additional access')`,
              ),
            "access reasons visible",
          );
          assert.equal(
            await evaluate(
              `!!document.querySelector('aside a[title="Devices"]')`,
            ),
            false,
            "No permission bypass link",
          );
          await page("Emulation.setDeviceMetricsOverride", {
            width: 320,
            height: 480,
            deviceScaleFactor: 1,
            mobile: false,
          });
          await poll(
            () =>
              evaluate(
                `!!document.querySelector('button[aria-label="Open menu"]')`,
              ),
            "mobile menu ready",
          );
          await click('button[aria-label="Open menu"]');
          await poll(
            () =>
              evaluate(
                `!!document.querySelector('aside[aria-hidden="false"]')`,
              ),
            "mobile sidebar visible",
          );
          await click('summary[aria-label="Unavailable pages"]');
          await evaluate(
            `document.querySelector('summary[aria-label="Unavailable pages"]').scrollIntoView({block:'start'});true`,
          );
          await poll(
            () =>
              evaluate(
                `document.querySelector('details[open]')?.textContent.includes('Requires additional access')`,
              ),
            "mobile permission explanation",
          );
          await poll(
            () =>
              evaluate(
                `(()=>{const el=document.querySelector('aside[aria-hidden="false"]');return el.getBoundingClientRect().left>=0;})()`,
              ),
            "drawer animation completes",
          );
          await writeFile(
            "/tmp/showpilot-navigation-access-320.png",
            Buffer.from(
              (await page("Page.captureScreenshot", { format: "png" })).data,
              "base64",
            ),
          );
          assert.equal(
            await evaluate("document.documentElement.scrollWidth<=innerWidth"),
            true,
          );
        },
      );
      assert.deepEqual(runtimeErrors, []);
      console.log(
        JSON.stringify({
          passed: true,
          assignmentsEntry: true,
          crewChatRedirect: true,
          lowerThirdsActive: true,
          visibleScrollbar: true,
          keyboardScroll: true,
          accessReasons: true,
          disabledFeatureReason: true,
          widths: [320, 768, 1440],
        }),
      );
    },
    {
      secondOperator: true,
      secondOperatorMember: true,
      navigationDiscovery: true,
    },
  );

await withLocalSmokeFixture(
  async ({ origin, orgId, operatorCookie, operatorPassword }) => {
    await withRealBrowser(
      { origin, cookie: operatorCookie },
      async ({ page, evaluate, onPageEvent }) => {
        await page("Runtime.enable");
        onPageEvent((event) => {
          if (event.method === "Runtime.exceptionThrown")
            runtimeErrors.push(event.params.exceptionDetails.text);
        });
        for (const route of [
          {
            path: "dashboard/devices/navigation-device",
            current: "Device details",
            parent: "dashboard/devices",
            heading: "Devices",
            active: "Devices",
          },
          {
            path: "songs/navigation-song",
            current: "Song studio",
            parent: "songs",
            heading: "Songs",
            active: "Songs",
          },
          {
            path: "production/incidents-history",
            current: "History",
            parent: "production/incidents",
            heading: "Incident Log",
            active: "Incidents",
          },
          // Enter the protected graphics route, not the explainer directly: prove the guard produces it.
          {
            path: "streaming/graphics",
            current: "Lower Thirds unavailable",
            parent: "show",
            heading: "Show Flow",
            active: "Lower Thirds",
          },
        ])
          await checkBreadcrumb({ page, evaluate, origin, orgId }, route);
      },
    );
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
        await page("Runtime.enable");
        onPageEvent((event) => {
          if (event.method === "Runtime.exceptionThrown")
            runtimeErrors.push(event.params.exceptionDetails.text);
        });
        await checkBreadcrumb(
          { page, evaluate, origin, orgId },
          {
            path: "rundown-pin",
            current: "Unlock changes",
            parent: "rundown",
            heading: "Display test show",
            active: "Rundown",
          },
        );
      },
    );
    assert.deepEqual(runtimeErrors, []);
    console.log(
      JSON.stringify({
        passed: true,
        hiddenPageBreadcrumbs: process.argv.includes("--hidden-only") ? 5 : 6,
        cloudDisabledGuard: true,
        backNavigationWithoutReload: true,
        widths: [320, 768, 1440],
      }),
    );
  },
  { hiddenNavigation: true, secondOperator: true, paidPlan: true },
);
