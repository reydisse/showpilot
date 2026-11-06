import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  UNSIGNED_WINDOWS_NOTICE,
  platformReleaseSecrets,
  releaseSecretReport,
  requiredReleaseSecrets,
  windowsSigningDecision,
  windowsSigningSecrets,
} from "./native-release-secrets.mjs";

const scriptPath = new URL("./native-release-secrets.mjs", import.meta.url).pathname;
const certificate = Buffer.from("not-a-real-certificate").toString("base64");

function platformEnvironment() {
  return Object.fromEntries(platformReleaseSecrets.map((name) => [name, `private-value-for-${name}`]));
}

function signedWindowsEnvironment() {
  return {
    ...platformEnvironment(),
    WINDOWS_CERTIFICATE: certificate,
    WINDOWS_CERTIFICATE_PASSWORD: "private-value-for-WINDOWS_CERTIFICATE_PASSWORD",
    WINDOWS_TIMESTAMP_URL: "https://timestamp.example/rfc3161",
  };
}

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
  for (const name of requiredReleaseSecrets) assert.match(preflight, new RegExp(`${name}: \\$\\{\\{ secrets\\.${name} \\}\\}`));
});

test("unsigned workflows produce expiring artifacts without release publishing or signing secrets", () => {
  for (const file of ["test-build.yml", "desktop-windows-test.yml"]) {
    const workflow = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(workflow, /secrets\.|gh release|publish_prerelease|contents: write/);
    assert.match(workflow, /actions\/upload-artifact@v4/);
    assert.match(workflow, /retention-days: 14/);
  }
});

test("release workflows disclose an entirely absent Windows configuration and still verify signatures", () => {
  for (const product of ["desktop", "bridge"]) {
    const workflow = readFileSync(new URL(`../.github/workflows/${product}-release.yml`, import.meta.url), "utf8");
    assert.match(workflow, /node scripts\/native-release-secrets\.mjs --windows-mode/);
    assert.match(workflow, /UNSIGNED Windows build: Windows signing credentials are entirely absent\./);
    assert.match(workflow, /partial or invalid Windows signing configuration/);
    assert.match(workflow, /NotSigned/);
    assert.match(workflow, /Import-PfxCertificate/);
  }
});

test("an entirely absent Windows configuration is unsigned and does not block when other signing values exist", () => {
  const report = releaseSecretReport(platformEnvironment());
  assert.deepEqual(report.missing, []);
  assert.equal(report.windows.mode, "unsigned");
  assert.equal(report.blocked, false);
  assert.ok(report.message.includes(UNSIGNED_WINDOWS_NOTICE));
  assert.equal(report.message.includes("private-value-for"), false);
});

test("missing Apple or updater values still block and every absent name is reported", () => {
  const report = releaseSecretReport({});
  assert.deepEqual(report.missing, [...platformReleaseSecrets]);
  assert.equal(report.windows.mode, "unsigned");
  assert.equal(report.blocked, true);
  for (const name of requiredReleaseSecrets) assert.ok(report.message.includes(name), name);
});

test("a partial Windows configuration fails and is not described as unsigned or signed", () => {
  const report = releaseSecretReport({
    ...platformEnvironment(),
    WINDOWS_CERTIFICATE: certificate,
  });
  assert.equal(report.windows.mode, "invalid");
  assert.equal(report.blocked, true);
  assert.deepEqual(report.windows.problems.map((problem) => problem.split(" ")[0]).sort(), [
    "WINDOWS_CERTIFICATE_PASSWORD",
    "WINDOWS_TIMESTAMP_URL",
  ]);
  assert.equal(report.message.includes("entirely absent"), false);
  assert.equal(report.message.includes("must be Authenticode signed"), false);
  assert.equal(report.message.includes(certificate), false);
});

test("malformed Windows values fail closed without echoing them", () => {
  const badCertificate = "not base64!!!";
  const badUrl = "ftp://timestamp.example/stamp";
  const report = releaseSecretReport({
    ...signedWindowsEnvironment(),
    WINDOWS_CERTIFICATE: badCertificate,
    WINDOWS_TIMESTAMP_URL: badUrl,
  });
  assert.equal(report.windows.mode, "invalid");
  assert.ok(report.windows.problems.some((problem) => problem.includes("WINDOWS_CERTIFICATE is not valid base64")));
  assert.ok(report.windows.problems.some((problem) => problem.includes("WINDOWS_TIMESTAMP_URL must use HTTP or HTTPS")));
  assert.equal(report.message.includes(badCertificate), false);
  assert.equal(report.message.includes(badUrl), false);
  assert.equal(windowsSigningDecision({
    WINDOWS_CERTIFICATE: certificate,
    WINDOWS_CERTIFICATE_PASSWORD: "secret",
    WINDOWS_TIMESTAMP_URL: "%%%",
  }).mode, "invalid");
});

test("complete Windows credentials select the signed path and the report contains no credential values", () => {
  const environment = signedWindowsEnvironment();
  const report = releaseSecretReport(environment);
  assert.equal(report.windows.mode, "signed");
  assert.equal(report.blocked, false);
  assert.match(report.message, /Authenticode signed/);
  for (const value of Object.values(environment)) assert.equal(report.message.includes(value), false);
});

test("the CLI blocks a partial Windows configuration and passes an entirely absent one", () => {
  const directory = mkdtempSync(join(tmpdir(), "showpilot-release-check-"));
  try {
    const summary = join(directory, "summary.md");
    const output = join(directory, "output.txt");
    const blocked = spawnSync(process.execPath, [scriptPath, "--windows-mode"], {
      encoding: "utf8",
      env: {
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_OUTPUT: output,
        WINDOWS_CERTIFICATE: certificate,
        WINDOWS_CERTIFICATE_PASSWORD: "fixture-private-password",
      },
    });
    assert.equal(blocked.status, 1);
    assert.equal(blocked.stderr, "");
    assert.equal(readFileSync(summary, "utf8"), blocked.stdout);
    assert.match(blocked.stdout, /partial or invalid Windows signing configuration/);
    assert.match(readFileSync(output, "utf8"), /^mode=invalid\n$/);
    assert.equal(blocked.stdout.includes("fixture-private-password"), false);
    assert.equal(blocked.stdout.includes(certificate), false);

    const unsigned = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: platformEnvironment(),
    });
    assert.equal(unsigned.status, 0);
    assert.match(unsigned.stdout, /UNSIGNED Windows build/);
    assert.equal(unsigned.stdout.includes("private-value-for"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the actual CLI passes only for a complete signed Windows fixture", () => {
  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    env: signedWindowsEnvironment(),
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Authenticode signed/);
  assert.equal(result.stdout.includes(certificate), false);
  assert.equal(windowsSigningSecrets.length, 3);
});
