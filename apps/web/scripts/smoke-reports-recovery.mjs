// Compiled Reports with real auth/D1. Faults withhold actual replies, so retries
// are checked against committed data rather than mocked success responses.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";

const require = createRequire(new URL("../package.json", import.meta.url));
const router = createRequire(require.resolve("@tanstack/react-router"));
const core = createRequire(router.resolve("@tanstack/router-core"));
const { toJSONAsync, fromJSON, fromCrossJSON } = core("seroval");
const { defaultSerovalPlugins } = router("@tanstack/router-core");
const ids = {},
  names = ["exportShowReport", "saveShowReportNote"];
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
assert.ok(
  names.every((name) => ids[name]),
  "build web before running this rehearsal",
);

await withLocalSmokeFixture(
  async ({
    origin,
    orgId,
    date,
    operatorCookie,
    stopServer,
    queryFixture,
    capturedEmails,
  }) => {
    const rpc = async (name, data) => {
      const response = await fetch(`${origin}/_serverFn/${ids[name]}`, {
        method: "POST",
        headers: {
          Cookie: operatorCookie,
          Origin: origin,
          "Sec-Fetch-Site": "same-origin",
          "x-tsr-serverFn": "true",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(await toJSONAsync({ data: { orgId, ...data } })),
        signal: AbortSignal.timeout(15_000),
      });
      assert.equal(response.status, 200);
      const reply = fromCrossJSON(await response.json(), {
        refs: new Map(),
        plugins: defaultSerovalPlugins,
      });
      assert.equal(reply.error, undefined);
      assert.equal(reply instanceof Error, false);
      return reply.result;
    };
    const report = () =>
      rpc("exportShowReport", { showId: "smoke-show", serviceDate: date });
    const downloads = await mkdtemp(
      join(tmpdir(), "showpilot-report-exports-"),
    );
    try {
      await withRealBrowser(
        { origin, cookie: operatorCookie },
        async ({ page, evaluate, browser }) => {
          await page("Page.enable");
          await page("Page.bringToFront");
          await page("Emulation.setFocusEmulationEnabled", { enabled: true });
          await browser("Browser.setDownloadBehavior", {
            behavior: "allow",
            downloadPath: downloads,
          });
          await page("Page.addScriptToEvaluateOnNewDocument", {
            source: `
        window.reportErrors=[];window.noteCalls=[];window.heldReads=[];window.heldSaves=[];
        window.holdReport=false;window.holdNote=false;window.rejectReport=false;
        addEventListener('error',e=>window.reportErrors.push(e.message));
        addEventListener('unhandledrejection',e=>window.reportErrors.push(String(e.reason)));
        const original=fetch;
        window.fetch=async(input,options)=>{
          const url=input instanceof Request?input.url:String(input);
          const read=url.includes('/_serverFn/${ids.exportShowReport}');
          const save=url.includes('/_serverFn/${ids.saveShowReportNote}');
          if(save)window.noteCalls.push(options.body);
          if(read&&window.rejectReport)throw new TypeError('Fixture report connection failed');
          const hold=(read&&window.holdReport)||(save&&window.holdNote);
          const response=await original(input,hold?{...options,signal:new AbortController().signal}:options);
          if(hold){
            const body=await response.text();
            return new Promise(resolve=>(read?window.heldReads:window.heldSaves).push(()=>resolve(new Response(body,{status:response.status,headers:response.headers}))));
          }
          return response;
        };
      `,
          });
          const check = (expression, label) =>
            poll(() => evaluate(expression), label).catch(async (error) => {
              console.log(
                JSON.stringify({
                  failed: label,
                  ui: await evaluate(
                    `({url:location.href,focus:document.activeElement?.outerHTML.slice(0,400),text:document.body?.innerText,errors:window.reportErrors})`,
                  ),
                }),
              );
              throw error;
            });
          const button = (name) =>
            `[...document.querySelectorAll('button')].find(n=>(n.textContent.trim()===${JSON.stringify(name)}||n.getAttribute('aria-label')===${JSON.stringify(name)})&&n.getBoundingClientRect().width>0)`;
          const roleButton = (role) =>
            `[...document.querySelectorAll('[aria-label="Manager note role"] button')].find(n=>n.textContent.startsWith(${JSON.stringify(role)}))`;
          const field = `document.querySelector('[aria-label="Manager notes"] textarea')`;
          const click = async (expression) => {
            const point = await check(
              `(async()=>{const n=${expression};if(!n||n.disabled)return null;n.scrollIntoView({block:'center',inline:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`,
              "pointer target reachable",
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
          const key = async (value) => {
            const windowsVirtualKeyCode = { Enter: 13, Escape: 27, Tab: 9 }[
              value
            ];
            await page("Input.dispatchKeyEvent", {
              type: "keyDown",
              key: value,
              code: value,
              windowsVirtualKeyCode,
              ...(value === "Enter" ? { text: "\r" } : {}),
            });
            await page("Input.dispatchKeyEvent", {
              type: "keyUp",
              key: value,
              code: value,
              windowsVirtualKeyCode,
            });
          };
          const fill = async (expression, value, textarea = false) => {
            await click(expression);
            await evaluate(
              `(()=>{const n=${expression};Object.getOwnPropertyDescriptor(${textarea ? "HTMLTextAreaElement" : "HTMLInputElement"}.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`,
            );
          };
          const width = (value, height = 900) =>
            page("Emulation.setDeviceMetricsOverride", {
              width: value,
              height,
              deviceScaleFactor: 1,
              mobile: false,
            });
          const search = `document.querySelector('input[type="search"]')`;
          const openButton = `[...document.querySelectorAll('button[aria-label^="Open report:"]')].find(n=>n.getBoundingClientRect().width>0)`;
          const searchFor = async (name) => {
            await fill(search, name);
            await check(
              `document.querySelectorAll('tbody tr').length===1`,
              "search isolates one report",
            );
          };
          const opened = () => check(`!!(${field})`, "report details loaded");
          const closed = () =>
            check(
              `!document.querySelector('[role="dialog"]')`,
              "report closed",
            );
          const screenshot = async (name) =>
            writeFile(
              `/tmp/showpilot-reports-${name}.png`,
              Buffer.from(
                (await page("Page.captureScreenshot", { format: "png" })).data,
                "base64",
              ),
            );

          await width(1440);
          await page("Page.navigate", { url: `${origin}/${orgId}/reports` });
          await check(
            `document.body?.textContent.includes('12 reports')&&Object.keys(${search}??{}).some(k=>k.startsWith('__reactProps'))`,
            "hydrated report index",
          );
          for (const viewport of [1440, 1024, 768, 320]) {
            await width(viewport);
            await check(`innerWidth===${viewport}`, "viewport applied");
            assert.equal(
              await evaluate(
                "document.documentElement.scrollWidth<=innerWidth+1",
              ),
              true,
              `index must fit at ${viewport}`,
            );
            assert.equal(
              await evaluate(
                `document.querySelector('table').getBoundingClientRect().width>0`,
              ),
              viewport >= 1280,
            );
            assert.equal(
              await evaluate(
                `[...document.querySelectorAll('article')].filter(n=>n.getBoundingClientRect().width>0).length`,
              ),
              viewport < 1280 ? 10 : 0,
            );
            for (const name of ["Previous page", "Next page"]) {
              assert.equal(
                await evaluate(
                  `(()=>{const b=(${button(name)}).getBoundingClientRect();return b.width>=44&&b.height>=44})()`,
                ),
                true,
              );
            }
            await click(button("Next page"));
            await check(
              `document.body.textContent.includes('Page 2 of 2')`,
              "pagination advances",
            );
            await click(button("Previous page"));
            await check(
              `document.body.textContent.includes('Page 1 of 2')`,
              "pagination returns",
            );
            if (viewport === 320) await screenshot("list-320");
          }
          console.log(
            JSON.stringify({
              stage: "responsive list and pagination",
              passed: true,
            }),
          );
          await width(1440);
          await searchFor("LongShowTitle");
          await evaluate(`(${openButton}).focus();true`);
          await key("Enter");
          await opened();
          await width(320);
          await check(
            `(()=>{const n=document.querySelector('[role="dialog"]'),b=n.getBoundingClientRect();return b.left>=0&&b.right<=innerWidth&&n.scrollWidth<=n.clientWidth+1;})()`,
            "long-name dialog fits phone",
          );
          await click(button("Export CSV"));
          await poll(
            async () =>
              (await readdir(downloads)).some((name) => name.endsWith(".csv")),
            "long-name report export accessible",
          );
          await screenshot("long-name-320");
          await width(320, 480);
          await check(
            `(()=>{const n=document.querySelector('[role="dialog"]'),b=n.getBoundingClientRect(),close=(${button("Close report")}).getBoundingClientRect();return b.top>=0&&b.bottom<=innerHeight&&b.left>=0&&b.right<=innerWidth&&close.top>=0&&close.bottom<=innerHeight;})()`,
            "long-name dialog and Close fit a short phone window",
          );
          await screenshot("long-name-320-short");
          await click(button("Close report"));
          await closed();
          await check(
            `document.activeElement?.getAttribute('aria-label')?.startsWith('Open report:')`,
            "closing restores report button focus",
          );
          for (const name of await readdir(downloads))
            await rm(join(downloads, name));

          await width(1440);
          console.log(
            JSON.stringify({
              stage: "keyboard dialog and responsive focus",
              passed: true,
            }),
          );
          await searchFor("Display test show");
          // A real read finishes, but its response never reaches the operator.
          await evaluate("window.holdReport=true");
          await click(openButton);
          await check("window.heldReads.length===1", "detail response held");
          await check(
            `!!(${button("Retry report details")})`,
            "read deadline offers Retry",
          );
          assert.equal(
            await evaluate(`!!(${field})`),
            false,
            "unknown notes must not appear empty/editable",
          );
          await evaluate("window.holdReport=false");
          await click(button("Retry report details"));
          await opened();
          await click(button("Close report"));
          await closed();
          await searchFor("Report fixture 2 ");
          await click(openButton);
          await opened();
          await evaluate(
            "window.heldReads.splice(0).forEach(release=>release())",
          );
          await check(
            `document.querySelector('[role="dialog"] h2')?.textContent.startsWith('Report fixture 2 ')`,
            "late previous-show response cannot replace selected report",
          );
          await click(button("Close report"));
          await closed();
          await searchFor("Display test show");
          await click(openButton);
          await opened();

          console.log(
            JSON.stringify({
              stage: "detail timeout and stale reply",
              passed: true,
            }),
          );
          await fill(field, "Production draft kept across roles", true);
          await click(roleButton("Technical Manager"));
          await fill(field, "Technical draft kept across roles", true);
          await click(roleButton("Production Manager"));
          assert.equal(
            await evaluate(`(${field}).value`),
            "Production draft kept across roles",
          );
          await key("Escape");
          await check(
            `!!(${button("Leave report")})`,
            "Escape confirms draft discard",
          );
          await click(button("Cancel"));
          assert.equal(
            await evaluate(`(${field}).value`),
            "Production draft kept across roles",
          );
          await evaluate("history.back();true");
          await check(
            `!!(${button("Keep editing")})`,
            "browser Back confirms draft discard",
          );
          await click(button("Keep editing"));
          await check(
            `!!(${field})&&location.search.includes('smoke-show')`,
            "Back cancellation retains report",
          );
          assert.equal(
            await evaluate("window.noteCalls.length"),
            0,
            "editing and cancelling do not save",
          );

          console.log(
            JSON.stringify({
              stage: "role drafts and discard guards",
              passed: true,
            }),
          );
          await evaluate("window.holdNote=true");
          await click(button("Save my notes"));
          await check(
            "window.heldSaves.length===1",
            "committed save response held",
          );
          const firstNote = (await report()).managerNotes.find(
            (note) => note.role === "pm",
          );
          assert.equal(firstNote.summary, "Production draft kept across roles");
          assert.equal(firstNote.revision, 0);
          // Simulate the same manager saving from a second authenticated window.
          const newer = await rpc("saveShowReportNote", {
            showId: "smoke-show",
            requestId: crypto.randomUUID(),
            expectedRevision: 0,
            role: "pm",
            summary: "Newer note from another window",
            wins: "",
            issues: "",
            followUps: "",
          });
          assert.equal(newer.outcome, "applied");
          assert.equal(newer.currentNote.revision, 1);
          await check(
            `!!(${button("Retry note save")})`,
            "save timeout offers exact Retry",
          );
          assert.equal(
            await evaluate(`(${field}).matches(':disabled')`),
            true,
            "unconfirmed save freezes further edits",
          );
          await evaluate("window.holdNote=false");
          await click(button("Retry note save"));
          await check(
            `!!(${button("Keep my draft for review")})`,
            "replay shows newer note conflict",
          );
          const calls = await evaluate("window.noteCalls");
          assert.equal(calls.length, 2);
          assert.equal(
            calls[0],
            calls[1],
            "Retry must resend the exact original request",
          );
          assert.equal(
            fromJSON(JSON.parse(calls[0])).data.expectedRevision,
            null,
          );
          assert.equal(
            (await report()).managerNotes.find((note) => note.role === "pm")
              .revision,
            1,
            "retry did not increment revision or overwrite newer text",
          );
          await evaluate(
            "window.heldSaves.splice(0).forEach(release=>release())",
          );
          await click(button("Keep my draft for review"));
          assert.equal(
            await evaluate(`(${field}).value`),
            "Production draft kept across roles",
          );
          await fill(field, "Reviewed final production note", true);
          await click(button("Save my notes"));
          await check(
            `document.body.textContent.includes('Production Manager note saved and included in exports.')`,
            "reviewed draft saved",
          );
          await click(roleButton("Technical Manager"));
          assert.equal(
            await evaluate(`(${field}).value`),
            "Technical draft kept across roles",
          );
          await click(button("Save my notes"));
          await check(
            `document.body.textContent.includes('Technical Manager note saved and included in exports.')`,
            "other manager draft saved separately",
          );

          console.log(
            JSON.stringify({
              stage: "exact save retry and conflict recovery",
              passed: true,
            }),
          );
          // Exports must fetch fresh saved notes, rather than the detail's old snapshot.
          const latest = (await report()).managerNotes.find(
            (note) => note.role === "pm",
          );
          await rpc("saveShowReportNote", {
            showId: "smoke-show",
            requestId: crypto.randomUUID(),
            expectedRevision: latest.revision,
            role: "pm",
            summary: "Newest saved text for exports",
            wins: "",
            issues: "",
            followUps: "",
          });
          await evaluate("window.rejectReport=true");
          await click(button("Export PDF"));
          await check(
            `!!(${button("Retry PDF export")})`,
            "export failure has persistent Retry",
          );
          assert.equal((await readdir(downloads)).length, 0);
          await evaluate("window.rejectReport=false");
          await click(button("Retry PDF export"));
          const pdf = await poll(
            async () =>
              (await readdir(downloads)).find((name) => name.endsWith(".pdf")),
            "actual PDF download",
          );
          assert.equal(
            (await readFile(join(downloads, pdf))).subarray(0, 5).toString(),
            "%PDF-",
          );
          await click(button("Export CSV"));
          const csv = await poll(
            async () =>
              (await readdir(downloads)).find((name) => name.endsWith(".csv")),
            "actual CSV download",
          );
          const csvText = await readFile(join(downloads, csv), "utf8");
          assert.match(csvText, /Newest saved text for exports/);
          assert.match(csvText, /Technical draft kept across roles/);
          assert.doesNotMatch(csvText, /Reviewed final production note/);
          for (const viewport of [1440, 768, 320]) {
            await width(viewport);
            const bounds = await evaluate(
              `(()=>{const d=document.querySelector('[role="dialog"]'),r=d.getBoundingClientRect();return {fits:r.left>=0&&r.right<=innerWidth&&d.scrollWidth<=d.clientWidth+1,controls:[...d.querySelectorAll('button,textarea')].map(n=>{const b=n.getBoundingClientRect();return {width:b.width,height:b.height,left:b.left,right:b.right};})}})()`,
            );
            assert.ok(
              bounds.fits &&
                bounds.controls.every(
                  (b) =>
                    b.width >= 44 &&
                    b.height >= 44 &&
                    b.left >= 0 &&
                    b.right <= viewport,
                ),
              JSON.stringify(bounds),
            );
            if (viewport === 320) await screenshot("notes-320");
          }
          await evaluate("window.holdReport=true");
          await click(button("Export CSV"));
          await check("window.heldReads.length===1", "export read held");
          await click(button("Close report"));
          await closed();
          await evaluate(
            "window.holdReport=false;window.heldReads.splice(0).forEach(release=>release())",
          );
          // Flush both the fetch continuation and the dynamically imported export.
          await evaluate("new Promise(resolve=>setTimeout(resolve,500))");
          assert.deepEqual(
            (await readdir(downloads)).sort(),
            [pdf, csv].sort(),
            "closing cancels a late export",
          );
          assert.deepEqual(await evaluate("window.reportErrors"), []);
        },
      );
    } finally {
      await rm(downloads, { recursive: true, force: true });
    }
    await stopServer();
    const notes = await queryFixture(
      `SELECT role,summary,revision FROM show_report_note WHERE orgId='${orgId}' ORDER BY role`,
    );
    assert.deepEqual(notes, [
      { role: "pm", summary: "Newest saved text for exports", revision: 3 },
      { role: "tm", summary: "Technical draft kept across roles", revision: 0 },
    ]);
    assert.equal(
      (
        await queryFixture(
          `SELECT requestId FROM report_note_write_receipt WHERE orgId='${orgId}'`,
        )
      ).length,
      5,
    );
    assert.equal(
      (
        await queryFixture(
          `SELECT id FROM show_report_note WHERE orgId!='${orgId}'`,
        )
      ).length,
      0,
    );
    assert.equal((await capturedEmails()).length, 0);
    console.log(
      JSON.stringify({
        passed: true,
        widths: [320, 768, 1024, 1440],
        pagination: true,
        detailDeadlineAndLateReply: true,
        roleDraftsAndDiscardGuards: true,
        exactSaveRetry: true,
        newerNotePreserved: true,
        pdfAndFreshCsv: true,
        lateExportCancelled: true,
        receipts: 5,
        externalEmails: 0,
      }),
    );
  },
  { reportRecovery: true, captureEmail: true },
);
