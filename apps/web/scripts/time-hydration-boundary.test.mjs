import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = (name) => readFile(new URL(`../src/routes/$slug/${name}`, import.meta.url), "utf8");

test("moving clocks hydrate from the server-provided reference instant", async () => {
  const [board, show, rundown] = await Promise.all([
    route("board.tsx"),
    route("show.tsx"),
    route("rundown.tsx"),
  ]);

  assert.match(board, /initialNow: Date\.now\(\)/);
  assert.match(board, /useClock\(initialNow\)/);
  assert.match(board, /formatTime\(time, clockFormat, timeZone\)/);
  assert.match(show, /initialNow: Date\.now\(\)/);
  assert.match(show, /useLiveNow\(initialNow\)/);
  assert.doesNotMatch(show, /statusClock=\{formatTime\(new Date\(\)/);
  assert.match(rundown, /initialNow: Date\.now\(\)/);
  assert.match(rundown, /useState\(initialNow\)/);
});

test("service and incident times have a deterministic timezone fallback", async () => {
  const [picker, incidents] = await Promise.all([
    readFile(new URL("../src/lib/service-picker.ts", import.meta.url), "utf8"),
    route("production/incidents.tsx"),
  ]);
  assert.match(picker, /timeZone: timeZone \|\| "UTC"/);
  assert.match(incidents, /orgTimezone: settings\["org-timezone"\] \|\| "UTC"/);
});
