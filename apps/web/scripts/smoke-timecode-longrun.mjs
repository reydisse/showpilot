// Actual 45-minute browser clock -> compiled Worker -> rundown automation.
// No clock acceleration, production data, or physical equipment. Build first;
// keep this checkout and its dist unchanged for the entire rehearsal.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";

process.env.SHOWPILOT_SMOKE_RUNTIME ??= "miniflare";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await withLocalSmokeFixture(
  async ({ origin, orgId, date, operatorCookie }) => {
    const query = `showId=smoke-show&serviceDate=${date}`;
    const headers = {
      Cookie: operatorCookie,
      Origin: origin,
      "Content-Type": "application/json",
    };
    const read = async (path) => {
      const response = await fetch(
        `${origin}/api/${path}/${orgId}/state?${query}`,
        { headers, signal: AbortSignal.timeout(10_000) },
      );
      assert.equal(response.status, 200, `${path} state`);
      return response.json();
    };
    const events = async () => {
      const response = await fetch(
        `${origin}/api/timecode/${orgId}/events?${query}`,
        { headers, signal: AbortSignal.timeout(10_000) },
      );
      assert.equal(response.status, 200);
      return response.json();
    };
    const rundownCommand = async (action, payload) => {
      const response = await fetch(
        `${origin}/api/rundown/${orgId}/command?${query}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ id: crypto.randomUUID(), action, payload }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      assert.equal(response.status, 200, await response.text());
    };
    for (const id of ["opening", "minute-35", "minute-45"]) {
      await rundownCommand("add-item", {
        id,
        title: id,
        type: "segment",
        duration: 3_600_000,
        notes: "Long-run fixture",
        assignee: "",
        cue: "",
        hardStop: false,
      });
    }
    await rundownCommand("timer-start", { itemId: "opening" });
    assert.equal((await read("rundown")).timer.currentItemId, "opening");

    await withRealBrowser(
      { origin, cookie: operatorCookie },
      async ({ evaluate, page, onPageEvent }) => {
        const errors = [];
        onPageEvent((event) => {
          if (event.method === "Runtime.exceptionThrown")
            errors.push(event.params.exceptionDetails.text);
        });
        await page("Runtime.enable");
        await page("Page.enable");
        await page("Page.bringToFront");
        await page("Emulation.setFocusEmulationEnabled", { enabled: true });
        const click = (name) =>
          poll(
            () =>
              evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(name)});
      if (!button || button.disabled) return false;
      button.click(); return true;
    })()`),
            `enabled ${name}`,
          );
        await page("Page.navigate", { url: `${origin}/${orgId}/timecode` });
        await click("Take control");
        await poll(
          () =>
            evaluate(
              `document.body.textContent.includes("You control this show's timecode.")`,
            ),
          "timecode control claimed",
        );
        const initial = await read("timecode");
        assert.equal(initial.totalFrames, 0);
        assert.equal(initial.format.frameRate, 30);
        assert.equal(initial.triggersEnabled, true);
        const cues = [35, 45].map((minutes) => ({
          id: `advance-${minutes}`,
          label: `Advance at minute ${minutes}`,
          action: "rundown-advance",
          enabled: true,
          triggerTimecode: { hours: 0, minutes, seconds: 0, frames: 0 },
          toleranceFrames: 30,
          payload: {},
        }));
        for (const cue of cues) {
          const result =
            await evaluate(`fetch(${JSON.stringify(`/api/timecode/${orgId}/command?${query}`)}, {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: ${JSON.stringify(JSON.stringify({ action: "add-event", payload: cue }))}
      }).then(async response => ({status:response.status,body:await response.text()}))`);
          assert.equal(result.status, 200, result.body);
        }
        assert.equal((await events()).length, 2);
        const startWall = Date.now();
        const startMonotonic = performance.now();
        await click("Start Internal Generator");
        await poll(
          async () => (await read("timecode")).running,
          "generator running",
        );
        console.log(
          JSON.stringify({
            stage: "started",
            at: new Date(startWall).toISOString(),
            requiredMinutes: 45,
            accelerated: false,
          }),
        );
        const acknowledged = new Map();
        let previousFrames = 0,
          previousMinute = -1,
          samples = 0,
          maxDriftSeconds = 0;
        while (performance.now() - startMonotonic < 46 * 60_000) {
          const state = await read("timecode");
          const elapsedSeconds = (performance.now() - startMonotonic) / 1000;
          const clockSeconds = state.totalFrames / 30;
          const drift = Math.abs(clockSeconds - elapsedSeconds);
          maxDriftSeconds = Math.max(maxDriftSeconds, drift);
          assert.equal(state.running, true, JSON.stringify(state.signal));
          assert.equal(state.signal.status, "live");
          assert.equal(state.triggersEnabled, true);
          assert.ok(
            state.totalFrames >= previousFrames,
            "Clock moved backward",
          );
          assert.ok(
            drift < 5,
            `Clock drift ${drift}s at ${elapsedSeconds}s wall time`,
          );
          previousFrames = state.totalFrames;
          samples++;
          const currentEvents = await events();
          for (const cue of currentEvents) {
            assert.notEqual(cue.executionStatus, "failed", JSON.stringify(cue));
            if (!cue.fired) continue;
            assert.equal(cue.executionStatus, "acknowledged");
            assert.equal(cue.executionAttempts, 1);
            assert.ok(cue.executionId);
            const expectedMinutes = Number(cue.id.slice("advance-".length));
            assert.ok([35, 45].includes(expectedMinutes));
            const firedAfterSeconds =
              (cue.executionStartedAt - startWall) / 1000;
            assert.ok(
              Math.abs(firedAfterSeconds - expectedMinutes * 60) < 5,
              `Cue fired at wrong wall time: ${firedAfterSeconds}`,
            );
            if (acknowledged.has(cue.id)) {
              assert.equal(
                cue.executionId,
                acknowledged.get(cue.id),
                "Cue executed again",
              );
            } else {
              await poll(
                async () =>
                  (await read("rundown")).timer.currentItemId ===
                  `minute-${expectedMinutes}`,
                `rundown advance ${expectedMinutes}`,
              );
              acknowledged.set(cue.id, cue.executionId);
              console.log(
                JSON.stringify({
                  stage: "acknowledged",
                  cue: cue.id,
                  firedAfterSeconds,
                  executionId: cue.executionId,
                  attempts: cue.executionAttempts,
                }),
              );
            }
          }
          const expectedItem = acknowledged.has("advance-45")
            ? "minute-45"
            : acknowledged.has("advance-35")
              ? "minute-35"
              : "opening";
          // Only compare between thresholds, so independent HTTP reads cannot race a valid advance.
          if (
            ![35, 45].some(
              (minute) => Math.abs(clockSeconds - minute * 60) < 10,
            )
          ) {
            assert.equal(
              (await read("rundown")).timer.currentItemId,
              expectedItem,
            );
          }
          const minute = Math.floor(elapsedSeconds / 60);
          if (minute !== previousMinute) {
            previousMinute = minute;
            console.log(
              JSON.stringify({
                stage: "progress",
                minute,
                clockSeconds,
                elapsedSeconds,
                acknowledged: acknowledged.size,
                samples,
              }),
            );
          }
          if (acknowledged.size === 2 && clockSeconds >= 45 * 60 + 5) break;
          assert.deepEqual(errors, [], "Browser runtime error");
          await delay(5_000);
        }
        assert.equal(
          acknowledged.size,
          2,
          "Both long-run cues must acknowledge",
        );
        await click("Stop Generator");
        await poll(
          async () => !(await read("timecode")).running,
          "generator stopped",
        );
        assert.equal((await read("rundown")).timer.currentItemId, "minute-45");
        for (const cue of await events()) {
          assert.equal(cue.executionId, acknowledged.get(cue.id));
          assert.equal(cue.executionAttempts, 1);
          assert.equal(cue.fired, true);
        }
        assert.deepEqual(errors, []);
        console.log(
          JSON.stringify({
            passed: true,
            actualElapsedSeconds: (performance.now() - startMonotonic) / 1000,
            maxDriftSeconds,
            samples,
            rundownAdvances: ["00:35:00:00", "00:45:00:00"],
            physicalEquipmentConnected: false,
          }),
        );
      },
    );
  },
  { paidPlan: true },
);
