// Built login/UI -> real relay -> real module-worker first frame. Disposable
// local data only; no device cues or production equipment are connected.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";

await withLocalSmokeFixture(
  async ({
    origin,
    orgId,
    browser,
    operatorCookie,
    operatorEmail,
    operatorPassword,
  }) => {
    const button = (name) =>
      browser("find", "role", "button", "click", "--name", name, "--exact");
    const readState = async () => {
      const response = await fetch(
        `${origin}/api/timecode/${orgId}/state?showId=smoke-show`,
        { headers: { Cookie: operatorCookie } },
      );
      assert.equal(response.status, 200);
      return response.json();
    };
    const feeds = async () =>
      (await browser("eval", "window.startProbe.feeds")).result;
    const clearFeeds = () =>
      browser("eval", "window.startProbe.feeds = []; true");
    const choose = async (text) => {
      await button("Choose start position");
      await browser("find", "label", "Internal start position", "fill", text);
    };
    await browser("open", `${origin}/login`);
    await browser("fill", "#email", operatorEmail);
    await browser("fill", "#password", operatorPassword);
    await button("Sign in");
    await browser("wait", "--url", `**/${orgId}/**`);
    await browser("open", `${origin}/${orgId}/timecode`);
    await browser("wait", "text=Start Internal Generator");
    await browser(
      "eval",
      `(() => {
    window.startProbe = { feeds: [], starts: [] };
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) {
      const message = JSON.parse(data);
      if (message.action === 'feed-tc') window.startProbe.feeds.push(message.payload);
      if (message.action === 'start') window.startProbe.starts.push(message.payload);
      return send.call(this, data);
    };
    return true;
  })()`,
    );
    await choose("00:00:10:00");
    await button("Start at 00:00:10:00");
    assert.deepEqual(
      (await browser("eval", "window.startProbe.starts")).result,
      [],
    );
    await button("Cancel");
    assert.equal(
      (
        await browser(
          "eval",
          "[...document.querySelectorAll('input')].find(input => input.value === '00:00:10:00') !== undefined",
        )
      ).result,
      true,
    );
    await button("Start at 00:00:10:00");
    await button("Start from position");
    await browser("wait", "text=Stop Generator");
    const first = (await feeds())[0];
    assert.equal(first.totalFrames, 300);
    assert.deepEqual(first.timecode, {
      hours: 0,
      minutes: 0,
      seconds: 10,
      frames: 0,
    });
    const started = await readState();
    assert.equal(started.running, true);
    assert.equal(started.triggersEnabled, false);
    assert.equal(started.automationHold.reason, "timecode-jump");

    await button("Pause clock");
    await browser("wait", "text=Resume clock");
    const paused = await readState();
    assert.equal(paused.signal.status, "paused");
    await clearFeeds();
    await button("Resume clock");
    await browser("wait", "text=Pause clock");
    assert.equal((await feeds())[0].totalFrames, paused.totalFrames);

    await button("Stop Generator");
    await browser("wait", "text=Resume Internal Generator");
    const stopped = await readState();
    assert.equal(stopped.running, false);
    assert.equal(
      (
        await browser(
          "eval",
          "document.querySelector('[role=\"dialog\"]') !== null",
        )
      ).result,
      false,
    );
    await clearFeeds();
    await button("Resume Internal Generator");
    await browser("wait", "text=Stop Generator");
    assert.equal((await feeds())[0].totalFrames, stopped.totalFrames);
    await button("Stop Generator");
    await browser("wait", "text=Resume Internal Generator");

    assert.equal((await browser("eval", 'document.querySelectorAll("#timecode-frame-rate").length')).result, 1);
    await browser("select", "select#timecode-frame-rate", "29.97-df");
    await button("Reformat timeline");
    await browser(
      "wait",
      "--fn",
      'document.querySelector("#timecode-frame-rate").value === "29.97-df"',
    );
    await choose("00:01:00;00");
    assert.equal(
      (
        await browser(
          "eval",
          "[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Start at timecode').disabled",
        )
      ).result,
      true,
    );
    await browser(
      "find",
      "label",
      "Internal start position",
      "fill",
      "00:01:00;02",
    );
    await clearFeeds();
    await button("Start at 00:01:00;02");
    await button("Start from position");
    await browser("wait", "text=Stop Generator");
    const dropFrame = (await feeds())[0];
    assert.equal(dropFrame.totalFrames, 1800);
    assert.deepEqual(dropFrame.timecode, {
      hours: 0,
      minutes: 1,
      seconds: 0,
      frames: 2,
    });
    assert.deepEqual(dropFrame.format, { frameRate: 29.97, dropFrame: "df" });
    await button("Stop Generator");
    await browser("wait", "text=Resume Internal Generator");
    await choose("00:01:00;02");
    await browser("set", "viewport", "320", "780");
    await browser(
      "scrollintoview",
      'input[aria-describedby$="-help"][type="text"]',
    );
    const fits = (
      await browser(
        "eval",
        `(() => {
    const input = [...document.querySelectorAll('input[type=text]')].find(input => input.value === '00:01:00;02');
    const bounds = input.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= innerWidth;
  })()`,
      )
    ).result;
    assert.equal(fits, true);
    await browser("screenshot", "/tmp/showpilot-start-position-320.png");
    console.log(
      JSON.stringify(
        {
          login: "passed",
          confirmationAndCancel: "passed",
          exact30fpsStart: first.totalFrames,
          pausedResume: "exact held frame",
          stoppedResume: "exact held frame",
          jumpReview: "retained",
          invalidDropFrame: "blocked",
          exactDropFrameStart: dropFrame.totalFrames,
          input320px: "passed",
          equipmentCommands: "none",
        },
        null,
        2,
      ),
    );
  },
);
