// Opt-in OS-store probe. Only creates and deletes a random fixture entry.
// Run after `pnpm --filter @showpilot/bridge build`.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteCredential, readCredential, writeCredential } from "../dist/credential-store.js";
import { loadConfigFile, saveConfigFile } from "../dist/setup-server.js";

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

const directory = mkdtempSync(join(tmpdir(), "showpilot-vault-probe-"));
const configPath = join(directory, "showpilot-bridge.config.json");
const references = new Set();
function remember() {
  const saved = JSON.parse(readFileSync(configPath, "utf8"));
  references.add(saved.credentialReference);
  assert.equal(saved.credentialFormat, "showpilot-bridge-v1");
  assert.equal("key" in saved, false);
  assert.equal("propresenterPassword" in saved, false);
  return saved.credentialReference;
}
const stagePassword = `stage-秘密-${randomUUID()}`;
const config = { site: "https://fixture.invalid", org: "fixture", key: firstKey, propresenterPassword: stagePassword };
try {
  saveConfigFile(config, directory);
  const initial = remember();
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
    import { loadConfigFile } from ${JSON.stringify(new URL("../dist/setup-server.js", import.meta.url).href)};
    const config = loadConfigFile(process.env.SHOWPILOT_SMOKE_DIRECTORY);
    if (config?.key !== process.env.SHOWPILOT_SMOKE_EXPECTED || config?.propresenterPassword !== process.env.SHOWPILOT_SMOKE_PASSWORD) throw new Error('Configuration secrets did not survive process restart');
  `], { env: { ...process.env, SHOWPILOT_SMOKE_DIRECTORY: directory, SHOWPILOT_SMOKE_EXPECTED: firstKey, SHOWPILOT_SMOKE_PASSWORD: stagePassword }, timeout: 15_000 });
  saveConfigFile({ ...config, key: rotatedKey, propresenterPassword: "replacement" }, directory);
  remember();
  assert.throws(() => readCredential(initial), /Secure credential storage is unavailable/);
  assert.equal(loadConfigFile(directory)?.propresenterPassword, "replacement");
  saveConfigFile({ ...config, propresenterPassword: undefined }, directory);
  remember();
  assert.equal(loadConfigFile(directory)?.propresenterPassword, undefined);
  const oldReference = `showpilot-key-only-${randomUUID()}`;
  references.add(oldReference);
  writeCredential(oldReference, firstKey);
  const { key, ...oldConfig } = config;
  writeFileSync(configPath, JSON.stringify({ ...oldConfig, credentialReference: oldReference }), { mode: 0o600 });
  assert.equal(loadConfigFile(directory)?.propresenterPassword, stagePassword);
  remember();
  assert.throws(() => readCredential(oldReference), /Secure credential storage is unavailable/);
  const migrated = readFileSync(configPath, "utf8");
  loadConfigFile(directory);
  assert.equal(readFileSync(configPath, "utf8"), migrated);
} finally {
  for (const entry of references) deleteCredential(entry);
  rmSync(directory, { recursive: true, force: true });
}
console.log("Standalone Bridge OS vault and configuration: restart, password replacement/clearing, key-only migration and cleanup passed.");
