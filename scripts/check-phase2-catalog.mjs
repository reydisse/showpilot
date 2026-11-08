// Run after the production web build. Every browser case owns disposable data;
// device traffic goes to loopback simulators, never an organization or venue.
import { spawn } from "node:child_process";
import { mkdtemp, open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(join(tmpdir(), "showpilot-catalog-gate-"));
const results = [];
const steps = [
  ["bridge-build", "pnpm", ["--filter", "@showpilot/bridge", "build"]],
  ...[
    "catalog-targets", // Named rundown jump and actual loopback Art-Net blackout.
    "propresenter-cues", // Previous, Clear Props, resolve/clear/delay/trigger.
    "lyrics-steps", // Next/Previous through operator and protected display.
    "named-timers", // Start/Stop, countdown output and reload.
    "media-cues", // Real browser playback, output acknowledgments and recovery.
    "crew-message", // Production Chat output and safe sender identity.
    "trigger-controls", // Cue pause/resume versus the separate safety kill switch.
  ].map(name => [name, process.execPath, [`apps/web/scripts/smoke-${name}.mjs`]]),
];
console.log(`Catalog acceptance logs: ${directory}`);
// Rerun only a failed slice after inspection; omitted steps stay unverified by
// that run. A full invocation always runs every case and reports the full gate.
const selected = process.argv.slice(2);
for (const name of selected) {
  if (!steps.some(step => step[0] === name)) throw new Error(`Unknown catalog check: ${name}`);
}
for (const [name, command, args] of steps) {
  if (selected.length && !selected.includes(name)) continue;
  const log = join(directory, `${name}.log`);
  const file = await open(log, "w");
  const startedAt = new Date().toISOString();
  console.log(`Running ${name}`);
  let exitCode;
  try {
    exitCode = await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: root,
        env: { ...process.env, SHOWPILOT_SMOKE_RUNTIME: "miniflare" },
        stdio: ["ignore", file.fd, file.fd],
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(signal ?? code));
    });
  } finally {
    await file.close();
  }
  results.push({ name, startedAt, finishedAt: new Date().toISOString(), exitCode, log });
  await writeFile(join(directory, "results.json"), JSON.stringify(results, null, 2) + "\n");
  if (exitCode !== 0) throw new Error(`${name} failed (${exitCode}); inspect ${log}`);
  console.log(`Passed ${name}`);
}
console.log(`${selected.length ? "Selected catalog checks" : "Catalog browser acceptance"} passed. Evidence: ${directory}/results.json`);
