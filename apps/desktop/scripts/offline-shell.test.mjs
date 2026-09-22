import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("release desktop boots from a bundled offline shell", async () => {
  const config = JSON.parse(await readFile(new URL("src-tauri/tauri.conf.json", root), "utf8"));
  assert.equal(config.build.frontendDist, "../offline");
  assert.equal(config.build.devUrl, "http://localhost:3001");
  const html = await readFile(new URL("offline/index.html", root), "utf8");
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /offline\.js/);
});

test("offline shell consumes the cache and labels local-only limitations", async () => {
  const source = await readFile(new URL("offline/offline.js", root), "utf8");
  assert.match(source, /invoke\("get_cached_service"\)/);
  assert.match(source, /Local rehearsal mode/);
  assert.match(source, /do not update ShowPilot Cloud, venue devices, kiosks, lyrics, or teammates/);
  assert.match(source, /window\.location\.replace\(CLOUD_ORIGIN\)/);
  assert.doesNotMatch(source, /innerHTML/);
});
