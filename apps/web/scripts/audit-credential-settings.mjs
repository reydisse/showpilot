// Read-only counts. Never select or print credential values or ciphertext.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isCredentialField } from "../src/lib/credential-fields.ts";

export const credentialSettingsAuditSql = `SELECT key,
  SUM(CASE WHEN value <> '' AND value NOT GLOB 'spenc:*' THEN 1 ELSE 0 END) AS plaintext,
  SUM(CASE WHEN value GLOB 'spenc:v1:*' THEN 1 ELSE 0 END) AS encrypted,
  SUM(CASE WHEN value GLOB 'spenc:*' AND value NOT GLOB 'spenc:v1:*' THEN 1 ELSE 0 END) AS unknownFormat
  FROM app_setting GROUP BY key`;

export function summarizeCredentialSettings(rows) {
  const counts = { plaintext: 0, encrypted: 0, unknownFormat: 0 };
  for (const row of rows) {
    if (!isCredentialField(row.key) || row.key === "api-key") continue;
    for (const key of Object.keys(counts)) {
      if (!Number.isSafeInteger(row[key]) || row[key] < 0) throw new Error("Invalid credential audit count");
      counts[key] += row[key];
    }
  }
  return counts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !["--local", "--remote"].includes(args[0])) throw new Error("Usage: node apps/web/scripts/audit-credential-settings.mjs --local|--remote");
  const { stdout } = await promisify(execFile)("pnpm", ["exec", "wrangler", "d1", "execute", "showpilot-db", args[0], "--command", credentialSettingsAuditSql, "--json"], {
    cwd: resolve(import.meta.dirname, ".."), maxBuffer: 4_000_000, timeout: 60_000,
  });
  const result = JSON.parse(stdout);
  const counts = summarizeCredentialSettings(result.flatMap(statement => statement.results ?? []));
  console.log(JSON.stringify(counts, null, 2));
  if (counts.plaintext || counts.unknownFormat) process.exitCode = 1;
}
