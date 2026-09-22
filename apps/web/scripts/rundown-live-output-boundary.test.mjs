import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../src/routes/$slug/rundown.tsx", import.meta.url), "utf8");

test("browsing a rundown does not publish the venue output target", () => {
  const loadStart = source.indexOf("const loadDate = async");
  const loadEnd = source.indexOf("const handleCreateShow", loadStart);
  assert.ok(loadStart >= 0 && loadEnd > loadStart, "loadDate boundary not found");
  assert.doesNotMatch(source.slice(loadStart, loadEnd), /publishTarget\s*\(/);
});

test("venue output switching remains an explicit confirmed action", () => {
  assert.match(source, /Take live/);
  assert.match(source, /Timer, lyrics, kiosk, Show Flow, and other venue outputs will switch/);
  assert.match(source, /onConfirm=\{\(\) => void takeSelectedShowLive\(\)\}/);
});

test("taking a different show live clears the previous show's lyrics", () => {
  const serverSource = readFileSync(new URL("../src/lib/rundown.ts", import.meta.url), "utf8");
  const start = serverSource.indexOf("export const setActiveServiceDate");
  const end = serverSource.indexOf("export const getProPresenterStageDisplay", start);
  const boundary = serverSource.slice(start, end);
  assert.match(boundary, /targetChanged/);
  assert.match(boundary, /TIMECODE_RELAY/);
  assert.match(boundary, /action:\s*"clear-lyrics"/);
});
