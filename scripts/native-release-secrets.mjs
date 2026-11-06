import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Apple and updater signing stay mandatory. Windows Authenticode is a separate
// decision: all three values absent is an explicit unsigned build, while any
// partial or malformed set fails instead of being treated as signed.
export const platformReleaseSecrets = Object.freeze([
  "TAURI_SIGNING_PRIVATE_KEY",
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "KEYCHAIN_PASSWORD",
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_TEAM_ID",
]);

export const windowsSigningSecrets = Object.freeze([
  "WINDOWS_CERTIFICATE",
  "WINDOWS_CERTIFICATE_PASSWORD",
  "WINDOWS_TIMESTAMP_URL",
]);

export const requiredReleaseSecrets = Object.freeze([
  ...platformReleaseSecrets,
  ...windowsSigningSecrets,
]);

export const UNSIGNED_WINDOWS_NOTICE = [
  "UNSIGNED Windows build: Windows signing credentials are entirely absent.",
  "None of WINDOWS_CERTIFICATE, WINDOWS_CERTIFICATE_PASSWORD, or WINDOWS_TIMESTAMP_URL is set.",
  "These installers are not Authenticode signed. Windows Defender SmartScreen may warn before installation.",
  "Do not describe this Windows build as signed.",
].join("\n");

const SIGNED_WINDOWS_NOTICE = "Windows signing credentials are complete. The Windows build must be Authenticode signed, and signature verification remains a release check.\n";

function supplied(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isBase64(value) {
  const compact = value.replace(/\s+/g, "");
  if (compact.length < 16 || compact.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return false;
  const decoded = Buffer.from(compact, "base64");
  return decoded.length > 0 && decoded.toString("base64").replace(/=+$/, "") === compact.replace(/=+$/, "");
}

/** Classify Windows signing without printing credential values. */
export function windowsSigningDecision(environment) {
  const present = windowsSigningSecrets.filter((name) => supplied(environment[name]));
  if (present.length === 0) {
    return { mode: "unsigned", problems: [], notice: `${UNSIGNED_WINDOWS_NOTICE}\n` };
  }

  const problems = [];
  for (const name of windowsSigningSecrets) {
    if (!supplied(environment[name])) {
      problems.push(`${name} is missing from a partial Windows signing configuration.`);
    }
  }
  const timestamp = environment.WINDOWS_TIMESTAMP_URL?.trim();
  if (timestamp) {
    try {
      const url = new URL(timestamp);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        problems.push("WINDOWS_TIMESTAMP_URL must use HTTP or HTTPS.");
      }
    } catch {
      problems.push("WINDOWS_TIMESTAMP_URL is not a valid URL.");
    }
  }
  const certificate = environment.WINDOWS_CERTIFICATE?.trim();
  if (certificate && !isBase64(certificate)) {
    problems.push("WINDOWS_CERTIFICATE is not valid base64.");
  }
  if (problems.length > 0) {
    return {
      mode: "invalid",
      problems,
      notice: `partial or invalid Windows signing configuration was not treated as signed or unsigned:\n\n${problems.map((problem) => `- ${problem}`).join("\n")}\n`,
    };
  }
  return { mode: "signed", problems: [], notice: SIGNED_WINDOWS_NOTICE };
}

export function releaseSecretReport(environment) {
  const missing = platformReleaseSecrets.filter((name) => !supplied(environment[name]));
  const windows = windowsSigningDecision(environment);
  const sections = [];
  if (missing.length > 0) {
    sections.push(`Native release blocked. Required signing values unavailable to this run:\n\n${missing.map((name) => `- ${name}`).join("\n")}\n`);
  }
  sections.push(windows.notice);
  if (windows.mode === "invalid") {
    sections.push("No Windows build should continue until every Windows signing value is removed for an explicitly unsigned build, or the complete configuration is valid.\n");
  }
  return {
    missing,
    windows,
    blocked: missing.length > 0 || windows.mode === "invalid",
    message: sections.join("\n"),
  };
}

function writeIfSet(fileVariable, contents) {
  if (process.env[fileVariable]) appendFileSync(process.env[fileVariable], contents);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const windowsOnly = process.argv.includes("--windows-mode");
  const report = releaseSecretReport(process.env);
  const message = windowsOnly ? report.windows.notice : report.message;
  const blocked = windowsOnly ? report.windows.mode === "invalid" : report.blocked;
  process.stdout.write(message.endsWith("\n") ? message : `${message}\n`);
  writeIfSet("GITHUB_STEP_SUMMARY", message.endsWith("\n") ? message : `${message}\n`);
  writeIfSet("GITHUB_OUTPUT", `mode=${report.windows.mode}\n`);
  writeIfSet("GITHUB_ENV", `WINDOWS_SIGNING_MODE=${report.windows.mode}\n`);
  process.exitCode = blocked ? 1 : 0;
}
