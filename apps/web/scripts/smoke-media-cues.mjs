// Built editor -> authenticated relay -> R2 -> actual browser playback/stop.
// Disposable accounts and silent audio only. No production data or speakers needed.
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll } from "./real-browser-fixture.mjs";

const directory = await mkdtemp(join(tmpdir(), "showpilot-media-cues-"));
const wav = Buffer.alloc(44 + 8000 * 2 * 120);
wav.write("RIFF", 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(wav.length - 44, 40);
const audioName = "Silent rehearsal.wav";
const audioPath = join(directory, audioName);
await writeFile(audioPath, wav);

try {
  await withLocalSmokeFixture(
    async ({
      origin,
      orgId,
      browser,
      operatorEmail,
      operatorPassword,
      operatorCookie,
      stopServer,
      startServer,
    }) => {
      const click = (name) =>
        browser("find", "role", "button", "click", "--name", name, "--exact");
      const read = async (path) => {
        const response = await fetch(`${origin}${path}`, {
          headers: { Cookie: operatorCookie },
        });
        assert.equal(response.status, 200);
        return response.json();
      };
      const events = () =>
        read(`/api/timecode/${orgId}/events?showId=smoke-show`);
      const state = () =>
        read(`/api/timecode/${orgId}/state?showId=smoke-show`);
      const command = async (action, payload) => {
        const result = (
          await browser(
            "eval",
            `fetch(${JSON.stringify(`/api/timecode/${orgId}/command?showId=smoke-show`)}, {method:'POST',headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify({ action, payload }))}}).then(async r => ({status:r.status,body:await r.text()}))`,
          )
        ).result;
        assert.equal(result.status, 200, result.body);
      };
      const videoState = () =>
        browser(
          "eval",
          "(() => { const v=document.querySelector('video'); return {paused:v.paused,src:v.currentSrc,time:v.currentTime,width:v.videoWidth,volume:v.volume,ready:v.readyState,network:v.networkState,source:v.getAttribute('src')}; })()",
        );
      await browser("open", `${origin}/login`);
      await browser("fill", "#email", operatorEmail);
      await browser("fill", "#password", operatorPassword);
      await click("Sign in");
      await browser("wait", "--url", `**/${orgId}/**`);
      await browser("open", `${origin}/${orgId}/timecode`);
      await browser("wait", "text=Start Internal Generator");
      await click("Take control");
      await browser("wait", "text=You control this show");
      const library = 'section[aria-label="Media library"]';
      await browser("scrollintoview", library);
      await browser("upload", `${library} input[type=file]`, audioPath);
      await click("Upload media");
      await browser(
        "wait",
        `button[aria-label=${JSON.stringify(`Preview ${audioName}`)}]`,
      );
      const asset = (await read(`/api/media/${orgId}`)).assets[0];
      const form = 'form:has(input[placeholder="00:05:00:00"])';
      for (const [action, seconds, label] of [
        ["media-play", "02", "Opening media"],
        ["media-stop", "20", "Stop opening media"],
      ]) {
        await browser("select", `${form} select >> nth=0`, action);
        await browser(
          "fill",
          `${form} input[placeholder="00:05:00:00"]`,
          `00:00:${seconds}:00`,
        );
        await browser("fill", `${form} input[placeholder^="e.g."]`, label);
        if (action === "media-play") {
          await browser(
            "wait",
            "--fn",
            `!!document.querySelector('option[value="${asset.id}"]')`,
          );
          await browser("select", `${form} select[id$="-file"]`, asset.id);
          await browser("find", "label", "Media volume (%)", "fill", "60");
          await browser("set", "viewport", "320", "780");
          await browser("scrollintoview", form);
          assert.equal(
            (
              await browser(
                "eval",
                `document.querySelector(${JSON.stringify(form)}).scrollWidth <= document.querySelector(${JSON.stringify(form)}).clientWidth + 1`,
              )
            ).result,
            true,
          );
          await browser(
            "screenshot",
            "/tmp/showpilot-media-cue-editor-320.png",
          );
          await browser("set", "viewport", "1440", "900");
        }
        await click("Add Event");
        await browser(
          "wait",
          "--fn",
          `document.querySelector(${JSON.stringify(`${form} input[placeholder="00:05:00:00"]`)}).value === ''`,
        );
      }
      const [play, stop] = await events();
      assert.equal(play.action, "media-play");
      assert.equal(stop.action, "media-stop");
      assert.deepEqual(play.payload, {
        output: "Program",
        mediaId: asset.id,
        etag: asset.etag,
        volume: 0.6,
      });
      const outputUrl = (
        await browser(
          "eval",
          "document.querySelector('section[aria-label=\"Media outputs\"] a').href",
        )
      ).result;
      assert.equal(new URL(outputUrl).searchParams.get("showId"), "smoke-show");
      await browser("tab", "new", outputUrl);
      await browser("wait", '[data-media-output-status="disabled"]');
      await click("Enable output");
      await browser("wait", '[data-media-output-status="enabled"]');
      await browser("wait", "text=1 upcoming clip prepared.");
      assert.equal(
        (await videoState()).result.paused,
        true,
        "Enabling never starts a cue",
      );
      await browser("set", "viewport", "320", "780");
      assert.equal(
        (
          await browser(
            "eval",
            "document.documentElement.scrollWidth <= innerWidth + 1",
          )
        ).result,
        true,
      );
      await browser("screenshot", "/tmp/showpilot-media-output-320.png");
      await browser("set", "viewport", "1440", "900");
      await browser("tab", "new", outputUrl);
      await browser("wait", '[data-media-output-status="disabled"]');
      await click("Enable output");
      await browser(
        "wait",
        "--fn",
        "document.querySelector('[data-media-output-status]')?.textContent.includes('already')",
      );
      assert.equal(
        (await videoState()).result.paused,
        true,
        "Duplicate output must not play",
      );
      await browser("tab", "0");
      await click("Start Internal Generator");
      await poll(
        async () => (await events())[0].fired,
        "timed media play acknowledgement",
      );
      await browser("tab", "1");
      await browser(
        "wait",
        "--fn",
        "document.querySelector('video').currentTime > 0.1 && !document.querySelector('video').paused",
      );
      assert.equal((await videoState()).result.volume, 0.6);
      try {
        await poll(
          async () => (await events())[1].fired,
          "timed media stop acknowledgement",
          30_000,
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            events: await events(),
            state: await state(),
            player: await videoState(),
          }),
        );
        throw error;
      }
      const stopped = (await videoState()).result;
      assert.equal(stopped.paused, true);
      assert.equal(stopped.ready, 0);
      assert.equal(stopped.network, 0);
      assert.equal(stopped.source, null);
      console.log("Timed Play and Stop confirmed by the actual media element.");
      await browser("tab", "0");
      await click("Stop Generator");
      await browser(
        "click",
        'div:has(> button[aria-label="Re-arm Opening media"]) > button:text-is("Re-fire")',
      );
      await click("Fire again");
      await browser("tab", "1");
      await browser(
        "wait",
        "--fn",
        "document.querySelector('video').currentTime > 0.1 && !document.querySelector('video').paused",
      );
      await click("Disable output and stop");
      assert.equal((await videoState()).result.paused, true);
      await browser("tab", "0");
      await command("add-event", {
        id: "disabled-play",
        action: "media-play",
        label: "Disabled output test",
        triggerTimecode: { hours: 0, minutes: 1, seconds: 0, frames: 0 },
        toleranceFrames: 0,
        payload: play.payload,
      });
      await command("fire-event", { id: "disabled-play" });
      assert.equal(
        (await events()).find((event) => event.id === "disabled-play")
          .executionStatus,
        "failed",
      );
      await browser("tab", "1");
      await click("Enable output");
      await browser("wait", '[data-media-output-status="enabled"]');
      await browser("tab", "0");
      await command("retry-event", { id: "disabled-play" });
      assert.equal(
        (await events()).find((event) => event.id === "disabled-play").fired,
        true,
      );
      // Encode actual moving pictures locally, then exercise video decoding and black after Stop.
      const encoded = (
        await browser(
          "eval",
          `new Promise(resolve => {
      const canvas=document.createElement('canvas'); canvas.width=320; canvas.height=180;
      const context=canvas.getContext('2d'); const stream=canvas.captureStream(10);
      const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'}); const chunks=[]; let frame=0;
      recorder.ondataavailable=event=>chunks.push(event.data);
      const draw=setInterval(()=>{context.fillStyle='#2244aa';context.fillRect(0,0,320,180);context.fillStyle='white';context.font='24px sans-serif';context.fillText('Cue '+(++frame),40,95);},100);
      recorder.onstop=async()=>{clearInterval(draw);stream.getTracks().forEach(track=>track.stop());const bytes=new Uint8Array(await new Blob(chunks).arrayBuffer());resolve(btoa(String.fromCharCode(...bytes)));};
      recorder.start();setTimeout(()=>recorder.stop(),10000);
    })`,
        )
      ).result;
      const videoPath = join(directory, "Countdown bumper.webm");
      await writeFile(videoPath, Buffer.from(encoded, "base64"));
      await browser("scrollintoview", library);
      await browser("upload", `${library} input[type=file]`, videoPath);
      await click("Upload media");
      await browser(
        "wait",
        'button[aria-label="Preview Countdown bumper.webm"]',
      );
      const videoAsset = (await read(`/api/media/${orgId}`)).assets.find(
        (item) => item.name === "Countdown bumper.webm",
      );
      const manualCue = {
        triggerTimecode: { hours: 0, minutes: 2, seconds: 0, frames: 0 },
        toleranceFrames: 0,
      };
      await command("add-event", {
        ...manualCue,
        id: "video-play",
        action: "media-play",
        label: "Video test",
        payload: {
          ...play.payload,
          mediaId: videoAsset.id,
          etag: videoAsset.etag,
        },
      });
      await command("add-event", {
        ...manualCue,
        id: "video-stop",
        action: "media-stop",
        label: "Video stop test",
        payload: stop.payload,
      });
      await command("fire-event", { id: "video-play" });
      assert.equal(
        (await events()).find((event) => event.id === "video-play").fired,
        true,
      );
      await browser("tab", "1");
      await browser(
        "wait",
        "--fn",
        "document.querySelector('video').videoWidth === 320 && document.querySelector('video').currentTime > 0.1 && !document.querySelector('video').paused",
      );
      await click("Fullscreen output");
      await browser(
        "wait",
        "--fn",
        "document.fullscreenElement === document.querySelector('[data-media-screen]')",
      );
      await browser("screenshot", "/tmp/showpilot-media-video-playing.png");
      await browser("eval", "document.exitFullscreen()");
      await browser("tab", "0");
      await command("fire-event", { id: "video-stop" });
      assert.equal(
        (await events()).find((event) => event.id === "video-stop").fired,
        true,
      );
      await browser("tab", "1");
      const cleared = (await videoState()).result;
      assert.equal(cleared.paused, true);
      assert.equal(cleared.ready, 0);
      assert.equal(cleared.width, 0);
      await browser("screenshot", "/tmp/showpilot-media-video-stopped.png");
      await browser("tab", "0");
      await command("add-event", {
        ...manualCue,
        id: "outage-play",
        action: "media-play",
        label: "Outage test",
        payload: play.payload,
      });
      await command("fire-event", { id: "outage-play" });
      await browser("tab", "1");
      await browser("wait", "--fn", "!document.querySelector('video').paused");
      await stopServer();
      await browser("wait", '[data-media-output-status="disconnected"]');
      assert.equal((await videoState()).result.paused, true);
      assert.equal((await videoState()).result.ready, 0);
      assert.equal((await videoState()).result.source, null);
      await startServer();
      await click("Reconnect output");
      await browser("wait", '[data-media-output-status="disabled"]');
      assert.equal((await videoState()).result.paused, true);
      assert.equal((await state()).mediaOutputs?.length ?? 0, 0);
      await click("Enable output");
      await browser("wait", '[data-media-output-status="enabled"]');
      console.log(
        JSON.stringify({
          passed: true,
          timedPlayStop: true,
          actualAudioAndVideoDecodeProgress: true,
          fullscreenVideo: true,
          videoClearedAfterStop: true,
          reviewedRefire: true,
          duplicateOutputRejected: true,
          disableStops: true,
          failedCueRetry: true,
          disconnectStops: true,
          reconnectRequiresEnable: true,
          narrowEditorAndOutput: true,
        }),
      );
    },
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
