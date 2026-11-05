import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Match the values required by both signed native release workflows.
// The updater key's password is optional, and GITHUB_TOKEN is runner-provided.
export const requiredReleaseSecrets = Object.freeze([
  "TAURI_SIGNING_PRIVATE_KEY",
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "KEYCHAIN_PASSWORD",
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_TEAM_ID",
  "WINDOWS_CERTIFICATE",
  "WINDOWS_CERTIFICATE_PASSWORD",
  "WINDOWS_TIMESTAMP_URL",
]);

export function releaseSecretReport(environment) {
  const missing = requiredReleaseSecrets.filter(name => !environment[name]?.trim());
  const message = missing.length
    ? `Native release blocked. Required signing values unavailable to this run:\n\n${missing.map(name => `- ${name}`).join("\n")}\n\nNo platform builds or release uploads should run. Unsigned testing remains available through test-build.yml.\n`
    : "All required native signing values are supplied. Certificate validity, notarization, and signature verification remain platform build checks.\n";
  return { missing, message };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = releaseSecretReport(process.env);
  process.stdout.write(report.message);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report.message);
  process.exitCode = report.missing.length ? 1 : 0;
}
