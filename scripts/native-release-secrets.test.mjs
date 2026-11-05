import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { releaseSecretReport, requiredReleaseSecrets } from "./native-release-secrets.mjs";

test("the report covers required release secrets and is wired to each supplied value", () => {
  const references = new Set();
  for (const product of ["desktop", "bridge"]) {
    const workflow = readFileSync(new URL(`../.github/workflows/${product}-release.yml`, import.meta.url), "utf8");
    for (const match of workflow.matchAll(/\$\{\{\s*secrets\.(\w+)\s*\}\}/g)) references.add(match[1]);
  }
  references.delete("GITHUB_TOKEN");
  references.delete("TAURI_SIGNING_PRIVATE_KEY_PASSWORD");
  assert.deepEqual([...references].sort(), [...requiredReleaseSecrets].sort());
  const preflight = readFileSync(new URL("../.github/workflows/native-release-preflight.yml", import.meta.url), "utf8");
  for (const name of requiredReleaseSecrets) assert.ok(preflight.includes(name + ": ${{ secrets." + name + " }}"));
});

test("unsigned workflows produce expiring artifacts without release publishing or signing secrets", () => {
  for (const file of ["test-build.yml", "desktop-windows-test.yml"]) {
    const workflow = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(workflow, /secrets\.|gh release|publish_prerelease|contents: write/);
    assert.match(workflow, /actions\/upload-artifact@v4/);
    assert.match(workflow, /retention-days: 14/);
  }
});

test("names every absent signing value without requiring secrets to test the checker", () => {
  const report = releaseSecretReport({});
  assert.equal(report.missing.length, 10);
  assert.deepEqual(report.missing, requiredReleaseSecrets);
  for (const name of requiredReleaseSecrets) assert.ok(report.message.includes(name));
});

test("reports only missing values and never emits provided credentials", () => {
  const available = Object.fromEntries(requiredReleaseSecrets.map(name => [name, `private-value-for-${name}`]));
  available.WINDOWS_CERTIFICATE = "  \n";
  const report = releaseSecretReport(available);
  assert.deepEqual(report.missing, ["WINDOWS_CERTIFICATE"]);
  assert.ok(!report.message.includes("private-value-for"));
  assert.ok(!report.message.includes("APPLE_PASSWORD"));
});

test("a missing value fails the actual CLI and writes the same names-only job summary", () => {
  const directory = mkdtempSync(join(tmpdir(), "showpilot-release-check-"));
  try {
    const summary = join(directory, "summary.md");
    const result = spawnSync(process.execPath, [new URL("./native-release-secrets.mjs", import.meta.url).pathname], {
      encoding: "utf8", env: { GITHUB_STEP_SUMMARY: summary, APPLE_PASSWORD: "fixture-private-password" },
    });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    assert.equal(readFileSync(summary, "utf8"), result.stdout);
    assert.ok(result.stdout.includes("WINDOWS_CERTIFICATE"));
    assert.ok(!result.stdout.includes("fixture-private-password"));
    assert.ok(!result.stdout.includes("APPLE_PASSWORD"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the actual CLI passes with required fixture values and no optional updater password", () => {
  const environment = Object.fromEntries(requiredReleaseSecrets.map(name => [name, "fixture-only"]));
  const result = spawnSync(process.execPath, [new URL("./native-release-secrets.mjs", import.meta.url).pathname], { encoding: "utf8", env: environment });
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes("Certificate validity"));
  assert.ok(!result.stdout.includes("fixture-only"));
});
