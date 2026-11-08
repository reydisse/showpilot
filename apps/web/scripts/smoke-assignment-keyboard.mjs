// Compiled app, authenticated personal assignments and disposable D1.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";

await withLocalSmokeFixture(
  async ({ origin, orgId, operatorCookie, queryFixture, capturedEmails }) => {
    await withRealBrowser(
      { origin, cookie: operatorCookie },
      async ({ evaluate, page }) => {
        await page("Page.enable");
        await page("Page.bringToFront");
        await page("Emulation.setFocusEmulationEnabled", { enabled: true });
        const press = async (key, code) => {
          await page("Input.dispatchKeyEvent", {
            type: "keyDown",
            key,
            code: key,
            windowsVirtualKeyCode: code,
            ...(key === "Enter" ? { text: "\r" } : {}),
          });
          await page("Input.dispatchKeyEvent", {
            type: "keyUp",
            key,
            code: key,
            windowsVirtualKeyCode: code,
          });
        };
        const focus = (name, role = "Audio operator") =>
          poll(
            () =>
              evaluate(`(() => {
      const row = [...document.querySelectorAll('article')].find(row => row.querySelector('h2')?.textContent === ${JSON.stringify(role)});
      const button = [...(row?.querySelectorAll('button') ?? [])].find(el => el.textContent.trim() === ${JSON.stringify(name)});
      if (!button || button.disabled || !Object.keys(button).some(key => key.startsWith("__reactProps"))) return false;
      button.focus(); return true;
    })()`),
            `${role}: ${name}`,
          );
        await page("Page.navigate", { url: `${origin}/${orgId}/assignments` });
        await focus("Decline");
        await press("Enter", 13);
        await poll(
          () => evaluate("!!document.querySelector('textarea')"),
          "decline note",
        );
        const baseline = await evaluate(`(() => {
      const note = document.querySelector('textarea');
      return { noteFocused: document.activeElement === note, buttons: [...note.closest('article').querySelectorAll('button')].map(button => ({ name: button.textContent.trim(), height: button.getBoundingClientRect().height })) };
    })()`);
        console.log(JSON.stringify({ stage: "decline-controls", ...baseline }));
        assert.equal(
          baseline.noteFocused,
          true,
          "Decline must move keyboard focus to its note",
        );
        assert.ok(
          baseline.buttons.every((button) => button.height >= 44),
          "Decline controls need 44px targets",
        );
        await page("Input.insertText", { text: "Fixture decline note" });
        await press("Tab", 9);
        assert.equal(
          await evaluate("document.activeElement.textContent.trim()"),
          "Cancel",
        );
        const focused = await evaluate(
          `(() => { const el=document.activeElement,s=getComputedStyle(el);return {visible:el.matches(':focus-visible'),outline:s.outlineStyle,width:s.outlineWidth,shadow:s.boxShadow}; })()`,
        );
        assert.ok(
          focused.visible &&
            ((focused.outline !== "none" && focused.width !== "0px") ||
              focused.shadow !== "none"),
          JSON.stringify(focused),
        );
        await press("Enter", 13);
        await poll(
          () =>
            evaluate(
              "document.activeElement?.textContent.trim() === 'Decline'",
            ),
          "Cancel restores Decline focus",
        );
        assert.equal(
          await evaluate("document.querySelector('textarea')"),
          null,
        );
        await press("Enter", 13);
        await poll(
          () => evaluate("document.activeElement?.tagName === 'TEXTAREA'"),
          "note focus on reopen",
        );
        await page("Input.insertText", {
          text: "Unavailable for this fixture",
        });
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
          const layout = await evaluate(`(() => {
        const row = document.querySelector('textarea').closest('article');
        return { fits: document.documentElement.scrollWidth <= innerWidth && row.scrollWidth <= row.clientWidth + 1,
          controls: [...row.querySelectorAll('button')].map(el => {const r=el.getBoundingClientRect();return {name:el.textContent.trim(),width:r.width,height:r.height,left:r.left,right:r.right};}) };
      })()`);
          assert.ok(layout.fits, JSON.stringify({ width, ...layout }));
          assert.ok(
            layout.controls.every(
              (el) =>
                el.width >= 44 &&
                el.height >= 44 &&
                el.left >= 0 &&
                el.right <= width,
            ),
            JSON.stringify(layout),
          );
        }
        await page("Emulation.setDeviceMetricsOverride", {
          width: 320,
          height: 480,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await focus("Confirm decline");
        await evaluate(
          "document.activeElement.scrollIntoView({block:'center'}); true",
        );
        const shot = await page("Page.captureScreenshot", { format: "png" });
        const { writeFile } = await import("node:fs/promises");
        await writeFile(
          "/tmp/showpilot-assignment-decline-320.png",
          Buffer.from(shot.data, "base64"),
        );
        await press("Enter", 13);
        await poll(
          () => evaluate("!document.querySelector('textarea')"),
          "decline acknowledged",
        );
        await focus("Accept", "Camera operator");
        await press("Enter", 13);
        await poll(
          () =>
            evaluate(
              "[...document.querySelectorAll('article')].find(row=>row.querySelector('h2')?.textContent==='Camera operator')?.textContent.includes('confirmed')",
            ),
          "accept acknowledged",
        );
        assert.equal(
          await evaluate(
            "document.body.textContent.includes('Private other assignment')",
          ),
          false,
        );
      },
    );
    const rows = await queryFixture(
      "SELECT id,status,responseNote FROM service_assignment ORDER BY id",
    );
    assert.deepEqual(
      rows.map((row) => ({
        id: row.id,
        status: row.status,
        responseNote: row.responseNote,
      })),
      [
        { id: "assignment-accept", status: "confirmed", responseNote: "" },
        {
          id: "assignment-decline",
          status: "declined",
          responseNote: "Unavailable for this fixture",
        },
        { id: "assignment-other", status: "assigned", responseNote: "" },
      ],
    );
    assert.deepEqual(await capturedEmails(), []);
    console.log(
      JSON.stringify({
        passed: true,
        keyboardAcceptAndDecline: true,
        cancelFocusRestored: true,
        minimum44pxTargets: true,
        narrowLongLabels: true,
        otherCrewUnchanged: true,
      }),
    );
  },
  { personalAssignments: true, captureEmail: true },
);
