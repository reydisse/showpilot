// Phase 2's Timecode UI gate. Build web first. Each child uses disposable
// auth/D1/relay/browser fixtures, and failures stop the gate immediately.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const scripts = [
  "smoke-timecode-timeline.mjs", // sorting, next/countdown, missed/failed, targets, sticky transport
  "smoke-cue-editing.mjs", // inline timecode validation, editing with identity/history preserved
  "smoke-cue-fields.mjs", // structured saved song/section choices and actual outputs
  "smoke-timecode-latency.mjs", // device/action/tolerance fields and authoritative cue timing
  "smoke-lyrics-steps.mjs", // operator/confidence Next, Previous and Clear with stable lyric nodes
];
for (const script of scripts) {
  console.log(JSON.stringify({ gate: "phase2-timecode-ui", script, status: "starting" }));
  const child = spawn(process.execPath, [resolve(import.meta.dirname, script)], {
    stdio: "inherit",
    env: { ...process.env, SHOWPILOT_SMOKE_RUNTIME: process.env.SHOWPILOT_SMOKE_RUNTIME ?? "miniflare" },
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => signal ? reject(new Error(`${script} stopped by ${signal}`)) : resolve(code));
  });
  assert.equal(code, 0, `${script} failed the Phase 2 Timecode UI gate`);
  console.log(JSON.stringify({ gate: "phase2-timecode-ui", script, status: "passed" }));
}
console.log(JSON.stringify({ gate: "phase2-timecode-ui", passed: true, rehearsals: scripts.length }));
