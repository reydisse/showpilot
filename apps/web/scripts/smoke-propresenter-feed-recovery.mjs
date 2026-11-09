// Built browser/Worker and protocol-compatible Bridge fixture; no physical ProPresenter or production data.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createBridgeSettingsRecipient } from "../../../packages/shared/src/bridge-settings.mjs";
import { ProPresenterReservations } from "../../bridge/dist/propresenter-reservations.js";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
const { WebSocket } = createRequire(
  new URL("../../bridge/package.json", import.meta.url),
)("ws");
await withLocalSmokeFixture(
  async ({
    origin,
    orgId,
    date,
    browser,
    operatorEmail,
    operatorPassword,
    queryFixture,
  }) => {
    const recipient = await createBridgeSettingsRecipient();
    const target = "propresenter:192.0.2.99:50001";
    const evaluate = async (expression) =>
      (await browser("eval", expression)).result;
    const click = (name) =>
      browser("find", "role", "button", "click", "--name", name, "--exact");
    const bridgeMessages = [];
    const commands = [];
    const reservations = new ProPresenterReservations();
    let bridge;
    let heartbeat;
    let currentText = "Opening fixture lyric";
    let connected = false;
    const publish = (text) =>
      bridge.send(
        JSON.stringify({
          type: "device-event",
          target,
          eventName: "slide",
          data:
            text === null
              ? "null"
              : JSON.stringify({
                  text,
                  nextText: "Upcoming fixture lyric",
                  slideId: text,
                  presentationName: "Fixture service",
                }),
        }),
      );
    try {
      await browser("open", `${origin}/login`);
      await browser("fill", "#email", operatorEmail);
      await browser("fill", "#password", operatorPassword);
      await click("Sign in");
      await browser("wait", "--url", `**/${orgId}/**`);
      await browser("open", `${origin}/${orgId}/settings?section=integrations`);
      await browser("wait", 'h3:text-is("ProPresenter")');
      await evaluate(
        `(() => { const heading = [...document.querySelectorAll('h3')].find(el => el.textContent === 'ProPresenter'); [...heading.parentElement.parentElement.querySelectorAll('button')].find(el => el.textContent.trim() === 'Connect').click(); return true; })()`,
      );
      await browser("fill", 'input[placeholder="192.168.1.100"]', "192.0.2.99");
      await browser("press", "Tab");
      await browser("fill", 'input[placeholder="1025"]', "1025");
      await browser("press", "Tab");
      await browser(
        "click",
        '[role="switch"][aria-label="Allow SP to send cues to ProPresenter"]',
      );
      await browser(
        "wait",
        '[role="switch"][aria-label="Allow SP to send cues to ProPresenter"][aria-checked="true"]',
      );
      await browser("open", `${origin}/${orgId}/settings?section=api`);
      await browser("wait", 'input[placeholder="Main room computer"]');
      await browser(
        "fill",
        'input[placeholder="Main room computer"]',
        "ProPresenter recovery fixture",
      );
      await click("Create key");
      await browser("wait", "text=Copy this key into the Bridge now.");
      const key = await evaluate(
        "[...document.querySelectorAll('code')].map(el => el.textContent).find(text => /^sp_[a-f0-9]{64}$/.test(text))",
      );
      assert.match(key, /^sp_[a-f0-9]{64}$/);
      await click("Dismiss key");
      for (const port of [50001, 1025]) {
        await browser(
          "find",
          "label",
          "Destination name",
          "fill",
          `Fixture ProPresenter ${port}`,
        );
        await browser(
          "find",
          "label",
          "Host or IP address",
          "fill",
          "192.0.2.99",
        );
        await browser("find", "label", "Port", "fill", String(port));
        await browser(
          "select",
          'label:has-text("Protocol") select',
          "propresenter",
        );
        await click("Approve destination");
        await browser("wait", `text=192.0.2.99:${port}`);
      }
      const openBridge = async () => {
        connected = false;
        reservations.clear();
        bridge = new WebSocket(
          `${origin.replace("http:", "ws:")}/api/bridge/${orgId}/ws?role=bridge`,
          {
            headers: {
              "x-showpilot-api-key": key,
              "x-showpilot-bridge-policy": "3",
              "x-showpilot-settings-key": recipient.publicKey,
            },
          },
        );
        await new Promise((resolve, reject) => {
          const deadline = setTimeout(
            () => reject(new Error("Fixture Bridge activation timed out")),
            10000,
          );
          bridge.on("error", reject);
          bridge.on("message", (data) => {
            const message = JSON.parse(String(data));
            bridgeMessages.push({
              type: message.type,
              target: message.target,
              role: message.role,
              error: message.error,
            });
            if (message.type === "bridge-role") {
              if (message.selectionId)
                bridge.send(
                  JSON.stringify({
                    type: "bridge-role-applied",
                    role: message.role,
                    selectionId: message.selectionId,
                  }),
                );
              clearTimeout(deadline);
              resolve();
            }
            if (message.type === "bridge-policy")
              bridge.send(
                JSON.stringify({
                  type: "bridge-policy-applied",
                  policyId: message.policyId,
                }),
              );
            if (message.type === "prepare-propresenter-command") {
              reservations.reserve(
                message.reservationId,
                message.target,
                message.command,
              );
              bridge.send(
                JSON.stringify({
                  type: "command-response",
                  id: message.id,
                  success: true,
                }),
              );
            }
            if (message.type === "execute-propresenter-command") {
              try {
                reservations.take(
                  message.reservationId,
                  message.target,
                  message.command,
                )();
                commands.push(message.command);
                currentText =
                  message.command === "clear"
                    ? null
                    : `Confirmed command lyric ${commands.length}`;
                publish(currentText);
                bridge.send(
                  JSON.stringify({
                    type: "command-response",
                    id: message.id,
                    success: message.command !== "clear",
                  }),
                );
              } catch (error) {
                bridge.send(
                  JSON.stringify({
                    type: "command-response",
                    id: message.id,
                    success: false,
                    notExecuted: true,
                    error: String(error),
                  }),
                );
              }
            }
            if (message.type === "command") {
              commands.push(message.command);
              currentText =
                message.command === "clear"
                  ? null
                  : `Confirmed command lyric ${commands.length}`;
              publish(currentText);
              bridge.send(
                JSON.stringify({
                  type: "command-response",
                  id: message.id,
                  success: true,
                  response: "Fixture applied",
                }),
              );
            }
            if (message.type === "connect-device") {
              assert.equal(message.target, target);
              connected = true;
              bridge.send(
                JSON.stringify({
                  type: "device-status",
                  target,
                  connected: true,
                }),
              );
              publish(currentText);
            }
          });
        });
      };
      await openBridge();
      heartbeat = setInterval(() => {
        if (bridge.readyState === WebSocket.OPEN)
          bridge.send(
            JSON.stringify({
              type: "bridge-status",
              devices: connected ? 1 : 0,
              targets: connected ? [target] : [],
              version: "fixture",
            }),
          );
      }, 2000);
      await browser("open", `${origin}/${orgId}/streaming/graphics`);
      await click("Connect ProPresenter");
      await browser("wait", "text=Opening fixture lyric");
      // Imported slides share the library receipt: lose the reply after the real save.
      await evaluate(`(() => {
      window.__beforeImportFetch = window.fetch; window.__loseImport = true; window.__importPosts = [];
      window.fetch = async (input, init) => {
        const post = init?.method === 'POST';
        if (post) window.__importPosts.push(init.body);
        const response = await window.__beforeImportFetch(input, init);
        if (post && window.__loseImport && response.ok) { window.__loseImport = false; await response.text(); throw new TypeError('Fixture lost imported graphic reply'); }
        return response;
      }; return true;
    })()`);
      await browser(
        "click",
        'section:has(h2:text-is("ProPresenter import")) button:text-is("Title")',
      );
      await browser(
        "wait",
        '[aria-label="Graphics library confirmation"] time',
      );
      const imported = () =>
        queryFixture(
          `SELECT id FROM graphic_template WHERE orgId='${orgId}' AND title='Opening fixture lyric'`,
        );
      assert.equal((await imported()).length, 1);
      await click("Retry library change");
      await browser(
        "wait",
        "--fn",
        "!document.querySelector('[aria-label=\"Graphics library confirmation\"]')",
      );
      assert.equal((await imported()).length, 1);
      const importPosts = await evaluate("window.__importPosts");
      assert.equal(importPosts.at(-1), importPosts.at(-2));
      await evaluate("window.fetch = window.__beforeImportFetch; true");
      currentText = "Retained fixture lyric";
      publish(currentText);
      await browser("wait", "text=Retained fixture lyric");
      bridge.terminate();
      await browser(
        "wait",
        '[role="alert"][aria-label="Reconnect ProPresenter feed"] time',
      );
      assert.equal(
        await evaluate(
          "document.body.textContent.includes('Retained fixture lyric')",
        ),
        true,
      );
      const section = 'section:has(h2:text-is("ProPresenter import"))';
      assert.equal(
        await evaluate(
          "[...document.querySelectorAll('section')].find(el => el.querySelector('h2')?.textContent === 'ProPresenter import').textContent.includes('Connected through')",
        ),
        false,
      );
      await browser("set", "viewport", "320", "740");
      await browser(
        "scrollintoview",
        'button[aria-label="Reconnect ProPresenter feed"]',
      );
      const bounds = await evaluate(
        "(() => { const el = document.querySelector('button[aria-label=\"Reconnect ProPresenter feed\"]'); const r = el.getBoundingClientRect(); return {left:r.left,right:r.right,height:r.height,reachable:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('button')===el}; })()",
      );
      assert.ok(
        bounds.left >= 0 &&
          bounds.right <= 320 &&
          bounds.height >= 44 &&
          bounds.reachable,
        JSON.stringify(bounds),
      );
      assert.equal(
        await evaluate("document.documentElement.scrollWidth <= innerWidth"),
        true,
      );
      assert.ok(
        await evaluate(
          "document.querySelector('[aria-label=\"ProPresenter slide text\"]').getBoundingClientRect().width >= 180",
        ),
        "Mobile preview must retain space for readable lyrics",
      );
      await browser("screenshot", "/tmp/showpilot-pp-feed-recovery-320.png");
      await browser("scrollintoview", '[aria-label="ProPresenter slide text"]');
      await browser("screenshot", "/tmp/showpilot-pp-feed-slide-320.png");
      const beforeRetry = await evaluate(
        'document.querySelector(\'[role="alert"][aria-label="Reconnect ProPresenter feed"] time\').dateTime',
      );
      await click("Reconnect ProPresenter feed");
      await browser(
        "wait",
        "--fn",
        `document.querySelector('[role="alert"][aria-label="Reconnect ProPresenter feed"] time')?.dateTime !== ${JSON.stringify(beforeRetry)} && !document.querySelector('button[aria-label="Reconnect ProPresenter feed"]')?.disabled`,
      );
      await openBridge();
      await browser(
        "wait",
        `${section} >> text=Connected through venue Bridge`,
      );
      await browser(
        "wait",
        "--fn",
        '!document.querySelector(\'[role="alert"][aria-label="Reconnect ProPresenter feed"]\')',
      );
      assert.equal(
        await evaluate(
          "document.body.textContent.includes('Retained fixture lyric')",
        ),
        true,
      );
      currentText = null;
      publish(null);
      await browser(
        "wait",
        "--fn",
        "!document.body.textContent.includes('Retained fixture lyric')",
      );
      currentText = "Rundown fixture lyric";
      publish(currentText);
      await browser("set", "viewport", "1440", "900");
      await browser(
        "open",
        `${origin}/${orgId}/rundown?show=smoke-show&date=${date}`,
      );
      await browser("wait", 'button:text-is("Off")');
      if (
        await evaluate(
          "[...document.querySelectorAll('button')].some(el => el.textContent.trim() === 'Dismiss shortcuts')",
        )
      )
        await click("Dismiss shortcuts");
      await click("Off");
      await browser("wait", "text=Rundown fixture lyric");
      bridge.terminate();
      await browser(
        "wait",
        '[role="alert"][aria-label="Reconnect ProPresenter feed"] time',
      );
      assert.equal(
        await evaluate(
          "document.body.textContent.includes('Rundown fixture lyric')",
        ),
        true,
      );
      assert.equal(
        await evaluate(
          "[...document.querySelectorAll('button')].some(el=>el.textContent.trim()==='Streaming')",
        ),
        false,
      );
      await click("Reconnect ProPresenter feed");
      await openBridge();
      await browser("wait", 'button:text-is("Streaming")');
      await browser(
        "wait",
        "--fn",
        '!document.querySelector(\'[role="alert"][aria-label="Reconnect ProPresenter feed"]\')',
      );
      // Lose the execute acknowledgement after real receipt persistence. Preparation
      // has no physical effect; status checks must never create another mutation.
      await evaluate(`(() => {
      const original = window.fetch;
      window.__ppLoseMode = null; window.__ppHoldPrepare = false; window.__ppRelease = null;
      window.__ppFailChecks = false; window.__ppOperations = [];
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        const body = String(init?.body ?? '');
        const post = init?.method === 'POST' && url.includes('/_serverFn/');
        const mode = !post ? null : body.includes('prepare') ? 'prepare' : body.includes('execute') ? 'execute' : body.includes('check') ? 'check' : 'output';
        if (mode) window.__ppOperations.push({mode, body});
        if (mode === 'check' && window.__ppFailChecks) throw new TypeError('Fixture status read failed');
        const lose = mode && mode === window.__ppLoseMode;
        if (lose) window.__ppLoseMode = null;
        const response = await original(input, init);
        if (mode === 'prepare' && window.__ppHoldPrepare) await new Promise(done => { window.__ppRelease = done; });
        if (lose && response.ok) { await response.text(); throw new TypeError('Fixture lost confirmation after execution'); }
        return response;
      }; return true;
    })()`);
      const responsive = async (kind, labels) => {
        for (const [width, height] of [
          [320, 480],
          [768, 1024],
          [1440, 900],
        ]) {
          await browser("set", "viewport", String(width), String(height));
          for (const label of labels) {
            await browser(
              "scrollintoview",
              `button:text-is(${JSON.stringify(label)})`,
            );
            const bounds = await evaluate(
              `(() => { const el = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(label)}); const r = el.getBoundingClientRect(); return {left:r.left,right:r.right,height:r.height,reachable:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('button')===el}; })()`,
            );
            assert.ok(
              bounds.left >= 0 &&
                bounds.right <= width &&
                bounds.height >= 44 &&
                bounds.reachable,
              JSON.stringify({ label, width, ...bounds }),
            );
          }
          assert.equal(
            await evaluate(
              "document.documentElement.scrollWidth <= innerWidth",
            ),
            true,
          );
          await browser(
            "screenshot",
            `/tmp/showpilot-web-pp-${kind}-${width}.png`,
          );
        }
      };
      await browser("wait", 'button[title="Next slide"]:not(:disabled)');
      await evaluate("window.__ppLoseMode = 'execute'");
      await browser("click", 'button[title="Next slide"]');
      await browser("wait", "text=Next slide was not confirmed.");
      assert.deepEqual(commands, ["next"]);
      await browser("wait", "text=Confirmed command lyric 1");
      assert.equal(
        await evaluate(
          "document.querySelector('button[title=\"Next slide\"]').disabled",
        ),
        true,
      );
      assert.ok(
        await evaluate(
          "document.querySelector('[aria-label=\"ProPresenter command confirmation\"] time')?.dateTime",
        ),
      );
      await responsive("lost-reply", ["Check command status"]);
      // Use client-side navigation: a page reload intentionally ends this in-memory session.
      await evaluate(
        `document.querySelector('a[href="/${orgId}/schedule"]').click(); true`,
      );
      await browser("wait", "--url", `**/${orgId}/schedule*`);
      await evaluate(
        `document.querySelector('a[href="/${orgId}/rundown"]').click(); true`,
      );
      await browser("wait", "--url", `**/${orgId}/rundown*`);
      await browser("wait", "text=Next slide was not confirmed.");
      await evaluate("window.__ppFailChecks = true");
      await click("Check command status");
      await browser("wait", "text=Command status could not be checked.");
      assert.deepEqual(commands, ["next"]);
      await evaluate("window.__ppFailChecks = false");
      await click("Check command status");
      await browser("wait", "text=Next slide confirmed.");
      assert.deepEqual(
        commands,
        ["next"],
        "Status checking must never resend the command",
      );
      await click("Off");
      await browser("wait", 'button:text-is("Streaming")');
      await browser("click", 'button[title="Previous slide"]');
      await browser("wait", "text=Previous slide confirmed.");
      assert.deepEqual(commands, ["next", "previous"]);
      await browser("click", 'button[title="Clear slide layer"]');
      await browser("wait", '[role="dialog"]');
      assert.deepEqual(commands, ["next", "previous"]);
      await click("Cancel");
      assert.deepEqual(commands, ["next", "previous"]);
      await browser("click", 'button[title="Clear slide layer"]');
      await responsive("clear-review", ["Clear ProPresenter slide", "Cancel"]);
      await click("Clear ProPresenter slide");
      await browser("wait", 'button:text-is("I\'ve checked the output")');
      assert.deepEqual(commands, ["next", "previous", "clear"]);
      await click("Check command status");
      await browser("wait", 'button:text-is("I\'ve checked the output")');
      assert.deepEqual(commands, ["next", "previous", "clear"]);
      await responsive("uncertain", [
        "Check command status",
        "I've checked the output",
      ]);
      await click("I've checked the output");
      // A preparation that finishes after the 20-second UI deadline is not executed.
      await evaluate("window.__ppHoldPrepare = true");
      await browser("click", 'button[title="Next slide"]');
      await browser("wait", "--fn", "typeof window.__ppRelease === 'function'");
      await browser("wait", "text=Next slide was not confirmed.");
      await evaluate(
        "window.__ppHoldPrepare = false; window.__ppRelease(); true",
      );
      await click("Check command status");
      await browser("wait", 'button:text-is("I\'ve checked the output")');
      assert.deepEqual(commands, ["next", "previous", "clear"]);
      await click("I've checked the output");
      // Kiosk failure must be visible with the feed switched off.
      await click("Streaming");
      await browser("wait", 'button:text-is("Off")');
      await evaluate("window.__ppLoseMode = 'output'");
      await click("Kiosk Off");
      await browser("wait", "text=Kiosk output change was not confirmed.");
      const [savedOutput] = await queryFixture(
        `SELECT value FROM app_setting WHERE orgId='${orgId}' AND key='propresenter-stage-display'`,
      );
      assert.equal(
        savedOutput.value,
        "true",
        "Kiosk change committed before the response was lost",
      );
      assert.equal(
        await evaluate(
          "document.querySelector('[aria-label=\"ProPresenter command confirmation\"]') !== null",
        ),
        true,
      );
      await click("I've checked the output");
      await browser("wait", 'button:text-is("On Kiosk")');
      const afterReview = await queryFixture(
        `SELECT value FROM app_setting WHERE orgId='${orgId}' AND key='propresenter-stage-display'`,
      );
      assert.equal(afterReview[0].value, "true");
      await click("On Kiosk");
      await browser("wait", "text=Kiosk output change confirmed.");
      await browser("wait", 'button:text-is("Kiosk Off")');
      assert.deepEqual(commands, ["next", "previous", "clear"]);
      console.log(
        JSON.stringify({
          passed: true,
          graphicsDisconnectHonesty: true,
          retainedSlide: true,
          timestampedRetry: true,
          manualReconnect: true,
          explicitClear: true,
          rundownRecovery: true,
          fits320: true,
          physicalProPresenter: false,
          importRetryNoDuplicate: true,
          lostCommandResponseAfterExecution: true,
          commandsNeverReplayed: true,
          reviewDoesNotSend: true,
          kioskErrorVisibleWithFeedOff: true,
          commandNavigationRetention: true,
          receiptChecksNeverExecute: true,
          clearConfirmation: true,
          latePreparationBlocked: true,
          widths: [320, 768, 1440],
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          bridgeMessages,
          page: await evaluate("document.body.innerText"),
        }),
      );
      await browser("screenshot", "/tmp/showpilot-pp-feed-diagnostic.png");
      throw error;
    } finally {
      clearInterval(heartbeat);
      bridge?.terminate();
    }
  },
  { paidPlan: true },
);
