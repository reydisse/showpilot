// Opt-in OS-store probe. Only creates and deletes a random fixture entry.
// Run after `pnpm --filter @showpilot/bridge build`.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { deleteCredential, readCredential, writeCredential } from "../dist/credential-store.js";

const reference = `showpilot-smoke-${randomUUID()}`;
const firstKey = `sp_${randomUUID()}`;
const rotatedKey = `sp_${randomUUID()}`;
try {
  writeCredential(reference, firstKey);
  assert.equal(readCredential(reference), firstKey);
  // A second process must recover the value, ruling out an in-memory backend.
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
    import { readCredential } from ${JSON.stringify(new URL("../dist/credential-store.js", import.meta.url).href)};
    if (readCredential(process.env.SHOWPILOT_SMOKE_REFERENCE) !== process.env.SHOWPILOT_SMOKE_EXPECTED) throw new Error('Credential did not persist across processes');
  `], { env: { ...process.env, SHOWPILOT_SMOKE_REFERENCE: reference, SHOWPILOT_SMOKE_EXPECTED: firstKey }, timeout: 15_000 });
  writeCredential(reference, rotatedKey);
  assert.equal(readCredential(reference), rotatedKey);
} finally {
  deleteCredential(reference);
}
assert.throws(() => readCredential(reference), /Secure credential storage is unavailable/);
console.log("Standalone Bridge OS credential save, process restart, rotation, and cleanup passed.");
