// Builds the public landing page and the isolated 3D concept.
// Reads HTML templates, interpolates {{token}} placeholders from
// src/pricing.mjs, and writes the deployable site to dist/ together with the
// static files in static/. Deployed as a Cloudflare Worker with static
// assets (see wrangler.jsonc). Only the concept uses a browser bundle.

import { mkdir, readFile, writeFile, cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  PRICING,
  APP_URL,
  SIGNUP_URL,
  LOGIN_URL,
  SUPPORT_EMAIL,
} from "./src/pricing.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));

const tokens = {
  "starter.name": PRICING.starter.name,
  "starter.monthly": String(PRICING.starter.monthly),
  "starter.tagline": PRICING.starter.tagline,
  "starter.features": PRICING.starter.features
    .map((f) => `<li>${f}</li>`)
    .join("\n              "),
  "pro.name": PRICING.pro.name,
  "pro.monthly": String(PRICING.pro.monthly),
  "pro.tagline": PRICING.pro.tagline,
  "pro.features": PRICING.pro.features
    .map((f) => `<li>${f}</li>`)
    .join("\n              "),
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

await rm(path.join(root, "dist"), { recursive: true, force: true });

for (const [source, destination] of [
  ["index.template.html", "index.html"],
  ["concept.template.html", "concept/index.html"],
]) {
  const template = await readFile(path.join(root, "src", source), "utf8");
  const html = template.replace(/\{\{([\w.]+)\}\}/g, (_, key) => {
    if (!(key in tokens))
      throw new Error(`Unknown template token in ${source}: ${key}`);
    return tokens[key];
  });
  const output = path.join(root, "dist", destination);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, html);
}

await cp(path.join(root, "static"), path.join(root, "dist"), {
  recursive: true,
});

await build({
  entryPoints: [path.join(root, "src/concept/main.js")],
  outdir: path.join(root, "dist/concept"),
  bundle: true,
  splitting: true,
  format: "esm",
  minify: true,
  target: "es2022",
});
await cp(
  new URL("../LICENSE", import.meta.resolve("three")),
  path.join(root, "dist/concept/three.LICENSE.txt"),
);

console.log("Built landing and concept pages and copied static assets.");
