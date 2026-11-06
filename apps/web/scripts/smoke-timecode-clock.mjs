// Real built app, authentication, module worker, WebSocket and relay. Only a
// disposable local organization is used. No production commands or equipment.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";

await withLocalSmokeFixture(
  async ({
    origin,
    orgId,
    browser,
    operatorCookie,
    operatorEmail,
    operatorPassword,
  }) => {
    await browser("open", `${origin}/login`);
    await browser("fill", "#email", operatorEmail);
    await browser("fill", "#password", operatorPassword);
    await browser(
      "find",
      "role",
      "button",
      "click",
      "--name",
      "Sign in",
      "--exact",
    );
    await browser("wait", "--url", `**/${orgId}/**`);
    await browser("close");
    await withRealBrowser(
      { origin, cookie: operatorCookie },
      async ({ evaluate, page, browser: command, targetId }) => {
        const text = (value) =>
          poll(
            () =>
              evaluate(
                `document.body?.textContent.includes(${JSON.stringify(value)})`,
              ),
            value,
          );
        const click = (name) =>
          poll(
            () =>
              evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(name)});
    if (!button || button.matches(':disabled')) return false;
    button.click(); return true;
  })()`),
            `enabled button: ${name}`,
          );
        await page("Page.navigate", { url: `${origin}/${orgId}/timecode` });
        await text("Start Internal Generator");
        await evaluate(`(() => {
    window.clockProbe = { feeds: [], workers: [], errors: [], visibility: [] };
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) {
      const msg = JSON.parse(data);
      if (msg.action === 'feed-tc') window.clockProbe.feeds.push({ at: performance.now(), frame: msg.payload.totalFrames, hidden: document.hidden });
      return send.call(this, data);
    };
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        window.clockProbe.workers.push(this);
        this.addEventListener('error', event => window.clockProbe.errors.push(event.message));
      }
    };
    document.addEventListener('visibilitychange', () => window.clockProbe.visibility.push(document.visibilityState));
    // A stopped rendering loop reproduces the old clock failure even on a
    // browser configuration that does not suspend background animation frames.
    window.requestAnimationFrame = () => 0;
    return true;
  })()`);
        await click("Start Internal Generator");
        await text("Stop Generator");
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const before = await evaluate(
          "({ feeds: window.clockProbe.feeds, workers: window.clockProbe.workers.length, errors: window.clockProbe.errors })",
        );
        assert.equal(
          before.workers,
          1,
          "The internal generator did not create its module worker",
        );
        assert.deepEqual(before.errors, [], "Module worker failed to load");
        const rate = (feeds) =>
          ((feeds.length - 1) * 1_000) / (feeds.at(-1).at - feeds[0].at);
        assert.ok(
          rate(before.feeds) >= 26 && rate(before.feeds) <= 32,
          `Feed rate was ${rate(before.feeds)} Hz`,
        );

        const other = await command("Target.createTarget", {
          url: "about:blank",
        });
        await command("Target.activateTarget", { targetId: other.targetId });
        await poll(() => evaluate("document.hidden"), "operator tab hidden");
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        const stateUrl = `${origin}/api/timecode/${orgId}/state?showId=smoke-show`;
        const readState = async () => {
          const response = await fetch(stateUrl, {
            headers: { Cookie: operatorCookie },
          });
          assert.equal(response.status, 200);
          return response.json();
        };
        const background = await readState();
        assert.equal(background.running, true);
        assert.equal(background.signal.status, "live");
        assert.ok(
          background.totalFrames > before.feeds.at(-1).frame + 60,
          "Relay clock stopped in the background",
        );
        await command("Target.activateTarget", { targetId });
        const probe = await evaluate(
          "({ feeds: window.clockProbe.feeds, errors: window.clockProbe.errors, visibility: window.clockProbe.visibility })",
        );
        assert.deepEqual(probe.errors, []);
        assert.ok(
          probe.visibility.includes("hidden"),
          "Browser did not background the operator tab",
        );
        const hiddenFeeds = probe.feeds.filter((feed) => feed.hidden);
        assert.ok(
          hiddenFeeds.length >= 60,
          "Background tab did not supply fresh frames",
        );
        assert.ok(
          rate(hiddenFeeds) >= 26 && rate(hiddenFeeds) <= 32,
          `Background feed rate was ${rate(hiddenFeeds)} Hz`,
        );
        assert.equal(
          new Set(probe.feeds.map((feed) => feed.frame)).size,
          probe.feeds.length,
          "Clock repeated frames",
        );

        // Kill the actual ticker, leaving the UI and socket alive. The relay must
        // hold timecode and automation; a fresh timer cannot hide a dead source.
        await evaluate(
          "window.clockProbe.workers.forEach(worker => worker.terminate()); true",
        );
        await text("Signal lost");
        const stalled = await readState();
        assert.equal(stalled.running, false);
        assert.ok(
          ["timecode-stalled", "timecode-lost"].includes(stalled.signal.status),
        );
        const held = await poll(
          async () => {
            const state = await readState();
            return state.signal.status === "timecode-lost" ? state : null;
          },
          "relay signal-lost alarm",
          5_000,
        );
        assert.equal(held.running, false);
        assert.equal(held.totalFrames, stalled.totalFrames);
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.equal((await readState()).totalFrames, held.totalFrames);
        await click("Stop Generator");
        await text("Resume Internal Generator");
        console.log(
          JSON.stringify(
            {
              foregroundHz: rate(before.feeds),
              backgroundHz: rate(hiddenFeeds),
              animationCallbacks: "disabled",
              bundledWorker: "passed",
              backgroundRelay: "passed",
              lostSourceHold: "passed",
            },
            null,
            2,
          ),
        );
      },
    );
  },
);
