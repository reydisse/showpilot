// Built UI -> authenticated Worker -> real local R2 -> browser decoder.
// All accounts, files and storage are disposable. Preview audio stays muted.
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";

const directory = await mkdtemp(join(tmpdir(), "showpilot-media-fixtures-"));
const wav = Buffer.alloc(44 + 8000 * 2 * 12);
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
for (let sample = 0; sample < (wav.length - 44) / 2; sample++)
  wav.writeInt16LE(
    Math.round(100 * Math.sin((sample / 8000) * Math.PI * 880)),
    44 + sample * 2,
  );
const audioName = "Opening sting – choir rehearsal.wav";
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
      const library = 'section[aria-label="Media library"]';
      const read = async () => {
        const response = await fetch(`${origin}/api/media/${orgId}`, {
          headers: { Cookie: operatorCookie },
        });
        assert.equal(response.status, 200);
        return response.json();
      };
      await browser("open", `${origin}/login`);
      await browser("fill", "#email", operatorEmail);
      await browser("fill", "#password", operatorPassword);
      await click("Sign in");
      await browser("wait", "--url", `**/${orgId}/**`);
      await browser("open", `${origin}/${orgId}/timecode`);
      await browser("wait", "text=No media uploaded yet.");
      await browser("scrollintoview", library);
      await browser("upload", `${library} input[type=file]`, audioPath);
      await click("Upload media");
      await browser(
        "wait",
        `button[aria-label=${JSON.stringify(`Preview ${audioName}`)}]`,
      );
      const page = await read();
      assert.equal(page.assets.length, 1);
      const asset = page.assets[0];
      assert.equal(asset.name, audioName);
      assert.equal(asset.size, wav.length);
      const mediaUrl = `${origin}/api/media/${orgId}/${asset.id}`;
      assert.equal(
        (await fetch(mediaUrl)).status,
        403,
        "Media must not be public",
      );
      assert.equal(
        (
          await fetch(mediaUrl, {
            method: "DELETE",
            headers: { Cookie: operatorCookie, Origin: "https://evil.example" },
          })
        ).status,
        403,
      );
      const ranged = await fetch(mediaUrl, {
        headers: { Cookie: operatorCookie, Range: "bytes=100-199" },
      });
      assert.equal(ranged.status, 206);
      assert.deepEqual(
        Buffer.from(await ranged.arrayBuffer()),
        wav.subarray(100, 200),
      );
      await click(`Preview ${audioName}`);
      await browser(
        "wait",
        "--fn",
        "document.querySelector('video')?.readyState >= 2",
      );
      assert.equal(
        (await browser("eval", "document.querySelector('video').paused"))
          .result,
        true,
        "Preview never autoplays",
      );
      const duration = (
        await browser("eval", "document.querySelector('video').duration")
      ).result;
      assert.ok(Math.abs(duration - 12) < 0.1);
      await browser(
        "eval",
        "document.querySelector('video').muted = true; document.querySelector('video').play()",
      );
      await browser(
        "wait",
        "--fn",
        "document.querySelector('video').currentTime > 0.3",
      );
      await browser("eval", "document.querySelector('video').currentTime = 8");
      await browser(
        "wait",
        "--fn",
        "document.querySelector('video').currentTime >= 8 && !document.querySelector('video').seeking",
      );
      await click("Close preview");
      assert.equal(
        (await browser("eval", "!!document.querySelector('video')")).result,
        false,
      );

      // Produce a real WebM using Chrome's encoder, without a network fixture or codec executable.
      const encoded = (
        await browser(
          "eval",
          `new Promise(resolve => {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
      const context = canvas.getContext('2d'); const stream = canvas.captureStream(10);
      const recorder = new MediaRecorder(stream, {mimeType:'video/webm;codecs=vp8'}); const chunks = [];
      recorder.ondataavailable = event => chunks.push(event.data);
      const draw = setInterval(() => {context.fillStyle='#2244aa'; context.fillRect(0,0,320,180); context.fillStyle='white'; context.font='24px sans-serif'; context.fillText('ShowPilot media test',30,95);},100);
      recorder.onstop = async () => {clearInterval(draw); stream.getTracks().forEach(track => track.stop()); const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer()); resolve(btoa(String.fromCharCode(...bytes)));};
      recorder.start(); setTimeout(() => recorder.stop(), 2200);
    })`,
        )
      ).result;
      const videoPath = join(directory, "Countdown bumper.webm");
      await writeFile(videoPath, Buffer.from(encoded, "base64"));
      await browser("upload", `${library} input[type=file]`, videoPath);
      await click("Upload media");
      await browser(
        "wait",
        'button[aria-label="Preview Countdown bumper.webm"]',
      );
      await click("Preview Countdown bumper.webm");
      await browser(
        "wait",
        "--fn",
        "document.querySelector('video')?.videoWidth === 320 && document.querySelector('video').readyState >= 2",
      );
      await browser(
        "eval",
        "document.querySelector('video').muted = true; document.querySelector('video').play()",
      );
      await browser(
        "wait",
        "--fn",
        "document.querySelector('video').currentTime > 0.3",
      );
      await browser("eval", "document.querySelector('video').pause()");
      await browser("set", "viewport", "320", "780");
      await browser("scrollintoview", library);
      assert.equal(
        (
          await browser(
            "eval",
            `document.querySelector(${JSON.stringify(library)}).scrollWidth <= document.querySelector(${JSON.stringify(library)}).clientWidth + 1`,
          )
        ).result,
        true,
      );
      await browser("screenshot", "/tmp/showpilot-media-library-320.png");
      await browser("set", "viewport", "1440", "1000");
      await browser("scrollintoview", `${library} video`);
      await browser("screenshot", "/tmp/showpilot-media-library-preview.png");

      await click(`Delete ${audioName}`);
      await browser("wait", '[role="dialog"]');
      await click("Cancel");
      assert.equal((await read()).assets.length, 2);
      // A failed refresh must stop loading, preserve an explicit error and provide Retry.
      await stopServer();
      await click("Refresh media");
      await browser("wait", "text=Retry loading media");
      assert.equal(
        (
          await browser(
            "eval",
            `document.querySelector(${JSON.stringify(library)}).textContent.includes('No media uploaded yet.')`,
          )
        ).result,
        false,
      );
      await startServer();
      await click("Retry loading media");
      await browser(
        "wait",
        `button[aria-label=${JSON.stringify(`Delete ${audioName}`)}]`,
      );
      assert.equal(
        (await read()).assets.length,
        2,
        "Uploads survive Worker restart",
      );
      await click(`Delete ${audioName}`);
      await click("Delete media");
      await browser(
        "wait",
        "--fn",
        `!document.querySelector('button[aria-label=${JSON.stringify(`Preview ${audioName}`)}]')`,
      );
      assert.equal(
        (await fetch(mediaUrl, { headers: { Cookie: operatorCookie } })).status,
        404,
      );
      await click("Delete Countdown bumper.webm");
      await click("Delete media");
      await browser("wait", "text=No media uploaded yet.");
      assert.equal((await read()).assets.length, 0);
      console.log(
        JSON.stringify({
          passed: true,
          audioDecodedAndSeeked: true,
          videoDecodedAndPlayed: true,
          authenticatedRanges: true,
          noAutoplay: true,
          confirmedDeletion: true,
          offlineRetry: true,
          persistedThroughRestart: true,
          narrowLibraryFits: true,
        }),
      );
    },
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
