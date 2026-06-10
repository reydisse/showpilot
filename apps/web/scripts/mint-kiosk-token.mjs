#!/usr/bin/env node
// Mint a kiosk API token and print it. Inserts into the kiosk_token table so
// the kiosk data endpoints (/api/v1/kiosk/*) accept it as a Bearer token.
//
// Usage:
//   node scripts/mint-kiosk-token.mjs --org <orgId> --slug <orgSlug> \
//        [--label "Lobby rotator"] [--view board] [--days 0] \
//        [--by <userId>] [--remote]
//
// --days 0 (default) = permanent. --remote targets the deployed D1.
// The signed token is printed AND inserted; paste it into the rotator's
// KIOSK_TOKEN env var.

import { createHmac, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";

// Keep in sync with KIOSK_SECRET in src/lib/kiosk.ts.
const KIOSK_SECRET = "showpilot-kiosk-secret-v1";

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}

const orgId = arg("org");
const orgSlug = arg("slug");
const label = arg("label", "Kiosk display");
const view = arg("view", "board");
const days = Number(arg("days", "0"));
const createdBy = arg("by", "script");
const remote = arg("remote", false) === true;

if (!orgId || !orgSlug) {
  console.error("Missing --org <orgId> and/or --slug <orgSlug>");
  process.exit(1);
}

const b64url = (buf) =>
  Buffer.from(buf)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

const now = Math.floor(Date.now() / 1000);
const exp = days > 0 ? now + days * 86400 : null;

const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
const payload = b64url(
  JSON.stringify({ orgId, orgSlug, view, iat: now, ...(exp ? { exp } : {}) }),
);
const data = `${header}.${payload}`;
const sig = b64url(createHmac("sha256", KIOSK_SECRET).update(data).digest());
const token = `${data}.${sig}`;

// cuid-ish id; collisions are astronomically unlikely for our volume.
const id = "kt_" + randomBytes(16).toString("hex");
const expiresAt = exp ? new Date(exp * 1000).toISOString() : null;

const esc = (v) => (v === null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
const sql =
  `INSERT INTO kiosk_token (id, orgId, label, view, token, expiresAt, createdBy, revokedAt, createdAt) VALUES (` +
  [
    esc(id),
    esc(orgId),
    esc(label),
    esc(view),
    esc(token),
    esc(expiresAt),
    esc(createdBy),
    "NULL",
    esc(new Date().toISOString()),
  ].join(", ") +
  ");";

const flags = ["d1", "execute", "showpilot-db", remote ? "--remote" : "--local", "--command", sql];
execFileSync("npx", ["wrangler", ...flags], { stdio: "inherit" });

console.log("\n✅ Kiosk token minted" + (exp ? ` (expires ${expiresAt})` : " (permanent)"));
console.log(`   org:   ${orgSlug} (${orgId})`);
console.log(`   label: ${label}\n`);
console.log("KIOSK_TOKEN=" + token + "\n");
