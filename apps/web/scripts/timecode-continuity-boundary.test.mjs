import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("timecode engine is owned by the persistent organization layout", () => {
  const layout = read("../src/routes/$slug.tsx");
  const timecodeRoute = read("../src/routes/$slug/timecode.tsx");
  const songRoute = read("../src/routes/$slug/songs.$songId.tsx");
  const provider = read("../src/components/timecode/TimecodeContext.tsx");

  assert.match(layout, /<TimecodeProvider/);
  assert.match(provider, /useTimecode\(\{ orgId, enabled \}\)/);
  assert.doesNotMatch(timecodeRoute, /useTimecode\(/);
  assert.doesNotMatch(songRoute, /useTimecode\(/);
  assert.match(timecodeRoute, /useOrgTimecode\(\)/);
  assert.match(songRoute, /useOrgTimecode\(\)/);
});
