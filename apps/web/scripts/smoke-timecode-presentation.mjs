// Built UI + real relay at 10 Hz. Proves intermediate rendering and bounded
// holds without substituting relay frames or connecting production equipment.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";
const { WebSocket } = createRequire(
  new URL("../../bridge/package.json", import.meta.url),
)("ws");

await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie }) => {
  const command = async (action, payload) => {
    const response = await fetch(
      `${origin}/api/timecode/${orgId}/command?showId=smoke-show`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: operatorCookie,
          Origin: origin,
        },
        body: JSON.stringify({ action, payload }),
      },
    );
    assert.equal(response.status, 200, `${action}: ${await response.text()}`);
  };
  const timecode = (frame) => ({
    hours: 0,
    minutes: 0,
    seconds: Math.floor(frame / 30),
    frames: frame % 30,
  });
  const feed = (frame) =>
    command("feed-tc", {
      timecode: timecode(frame),
      format: { frameRate: 30, dropFrame: "ndf" },
    });
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const results = {};
  const controller = new WebSocket(
    `${origin.replace("http:", "ws:")}/api/timecode/${orgId}/ws?showId=smoke-show`,
    { headers: { Cookie: operatorCookie, Origin: origin } },
  );
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Fixture controller was not granted control")),
        5000,
      );
      controller.on("error", reject);
      controller.on("message", (data) => {
        const message = JSON.parse(String(data));
        if (message.type === "hydrate")
          controller.send(
            JSON.stringify({ type: "command", action: "claim-control" }),
          );
        if (message.type === "control-status" && message.control === "yours") {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    await withRealBrowser(
      { origin, cookie: operatorCookie },
      async ({ page, evaluate, browser, targetId }) => {
        await page("Page.enable");
        // This checks visible rendering. Keep OS focus changes from throttling its
        // timers; smoke-timecode-clock.mjs separately proves real hidden-tab feeds.
        await page("Emulation.setFocusEmulationEnabled", { enabled: true });
        await page("Page.addScriptToEvaluateOnNewDocument", {
          source: `
      window.presentationProbe = { sockets: [], updates: [], renders: [], commands: [], latest: null };
      const NativeSocket = WebSocket;
      window.WebSocket = class extends NativeSocket {
        constructor(...args) {
          super(...args);
          if (!String(args[0]).includes('/api/timecode/')) return;
          presentationProbe.sockets.push(this);
          this.addEventListener('message', event => {
            const msg = JSON.parse(event.data);
            if ((msg.type === 'hydrate' || msg.type === 'tc-update') && msg.state) {
              presentationProbe.latest = msg.state;
              presentationProbe.updates.push(msg.state);
            }
          });
        }
        send(data) { presentationProbe.commands.push(JSON.parse(data)); return super.send(data); }
      };
      setInterval(() => {
        const latest = presentationProbe.latest;
        if (!latest || latest.signal?.status !== 'live') return;
        for (const element of document.querySelectorAll('[data-timecode-display]')) {
          presentationProbe.renders.push({ display: element.textContent, authoritative: latest.totalFrames });
        }
      }, 8);
    `,
        });

        for (const surface of ["operator", "confidence"]) {
          await command("stop");
          await command("set-timecode", { timecode: timecode(300) });
          await command("set-lyrics", {
            songId: "probe",
            songTitle: "Presentation fixture",
            sectionId: "verse",
            sectionLabel: "Verse",
            lyrics: "Known relay frames",
            nextLabel: "Next verse",
          });
          await page("Page.navigate", {
            url:
              surface === "operator"
                ? `${origin}/${orgId}/timecode`
                : `${origin}/timer/${orgId}?showId=smoke-show`,
          });
          await poll(
            () =>
              evaluate(
                "window.presentationProbe?.latest?.showId === 'smoke-show' && document.querySelector('[data-timecode-display]') !== null",
              ),
            `${surface} hydrate`,
          );
          await browser("Target.activateTarget", { targetId });
          await page("Page.bringToFront");
          await poll(() => evaluate("!document.hidden"), `${surface} visible`);
          await command("start");
          await feed(300);
          for (let step = 1; step <= 15; step++) {
            await pause(100);
            await feed(300 + step * 3);
          }
          await pause(700);
          const proof = await evaluate(
            "({ renders: presentationProbe.renders, commands: presentationProbe.commands, updates: presentationProbe.updates, hidden: document.hidden, displays: [...document.querySelectorAll('[data-timecode-display]')].map(e => e.textContent) })",
          );
          await writeFile(
            `/tmp/showpilot-presentation-${surface}-proof.json`,
            JSON.stringify(proof, null, 2),
          );
          const frames = proof.renders.map((render) => {
            const [hours, minutes, seconds, frame] = render.display
              .split(/[:;]/)
              .map(Number);
            return {
              frame: ((hours * 60 + minutes) * 60 + seconds) * 30 + frame,
              authoritative: render.authoritative,
            };
          });
          assert.ok(
            frames.length > 30,
            `${surface} did not render enough frames`,
          );
          assert.ok(
            frames.every((frame) => frame.frame <= frame.authoritative),
            `${surface} predicted beyond the relay`,
          );
          const intermediate = new Set(
            frames
              .filter(
                (frame) =>
                  frame.frame >= 300 &&
                  frame.frame <= 345 &&
                  frame.frame % 3 !== 0,
              )
              .map((frame) => frame.frame),
          );
          assert.ok(
            intermediate.size >= 10,
            `${surface} only rendered ${intermediate.size} intermediate frames`,
          );
          assert.ok(
            proof.displays.every((display) => display === "00:00:11:15"),
            `${surface} failed to hold the last real frame`,
          );
          assert.equal(
            proof.commands.some((command) => command.action === "feed-tc"),
            false,
            "Presentation generated an authoritative feed",
          );

          // Drop real sockets while an interpolation is in progress. The view must
          // snap to the latest known frame, then hold through the disconnect.
          await command("start");
          await feed(345);
          await pause(100);
          await feed(348);
          await poll(
            () => evaluate("presentationProbe.latest?.totalFrames === 348"),
            "last real frame",
          );
          await evaluate(
            "presentationProbe.sockets.forEach(socket => socket.close()); true",
          );
          await pause(150);
          assert.deepEqual(
            await evaluate(
              "[...document.querySelectorAll('[data-timecode-display]')].map(e => e.textContent)",
            ),
            proof.displays.map(() => "00:00:11:18"),
          );
          results[surface] = {
            visibility: "foreground emulation",
            intermediateFrames: intermediate.size,
            neverAheadOfRelay: "passed",
            staleHold: "passed",
            disconnectHold: "passed",
            generatedFeeds: 0,
          };
        }

        await command("stop");
        await page("Emulation.setDeviceMetricsOverride", {
          width: 320,
          height: 780,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await page("Page.navigate", { url: `${origin}/${orgId}/timecode` });
        await poll(
          () =>
            evaluate(
              "document.querySelector('[data-timecode-display=large]') !== null",
            ),
          "320px clock",
        );
        const fit = await evaluate(`(() => {
      const clock = document.querySelector('[data-timecode-display=large]');
      const range = document.createRange(); range.selectNodeContents(clock);
      return { textWidth: range.getBoundingClientRect().width, availableWidth: clock.clientWidth, viewport: innerWidth };
    })()`);
        assert.ok(fit.textWidth <= fit.availableWidth, JSON.stringify(fit));
        const screenshot = await page("Page.captureScreenshot", {
          format: "png",
        });
        await writeFile(
          "/tmp/showpilot-timecode-presentation-320.png",
          Buffer.from(screenshot.data, "base64"),
        );
        results.clock320px = fit;
      },
    );
  } finally {
    controller.close();
  }
  console.log(JSON.stringify(results, null, 2));
});
