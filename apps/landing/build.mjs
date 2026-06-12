// Zero-dependency build for the landing page.
// Reads src/index.template.html, interpolates {{token}} placeholders from
// src/pricing.mjs, and writes the deployable site to dist/ together with the
// static files in static/. Deployed as a Cloudflare Worker with static
// assets (see wrangler.jsonc) — no framework, no bundler, nothing to break.

import { mkdir, readFile, writeFile, cp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRICING, APP_URL, SIGNUP_URL, LOGIN_URL, SUPPORT_EMAIL } from "./src/pricing.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));

const tokens = {
  "starter.name": PRICING.starter.name,
  "starter.monthly": String(PRICING.starter.monthly),
  "starter.tagline": PRICING.starter.tagline,
  "starter.features": PRICING.starter.features.map((f) => `<li>${f}</li>`).join("\n              "),
  "pro.name": PRICING.pro.name,
  "pro.monthly": String(PRICING.pro.monthly),
  "pro.tagline": PRICING.pro.tagline,
  "pro.features": PRICING.pro.features.map((f) => `<li>${f}</li>`).join("\n              "),
  "founding.name": PRICING.founding.name,
  "founding.monthly": String(PRICING.founding.monthly),
  "founding.tagline": PRICING.founding.tagline,
  annualNote: PRICING.annualNote,
  appUrl: APP_URL,
  signupUrl: SIGNUP_URL,
  loginUrl: LOGIN_URL,
  supportEmail: SUPPORT_EMAIL,
  buildDate: new Date().toISOString().slice(0, 10),
};

const template = await readFile(path.join(root, "src/index.template.html"), "utf8");

const unknown = [];
const html = template.replace(/\{\{([\w.]+)\}\}/g, (_, key) => {
  if (!(key in tokens)) {
    unknown.push(key);
    return "";
  }
  return tokens[key];
});
if (unknown.length) {
  console.error(`Unknown template tokens: ${unknown.join(", ")}`);
  process.exit(1);
}

await mkdir(path.join(root, "dist"), { recursive: true });
await writeFile(path.join(root, "dist/index.html"), html);

await cp(path.join(root, "static"), path.join(root, "dist"), { recursive: true });

console.log("Built dist/index.html and copied static assets.");
