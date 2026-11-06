// Track every source requirement without treating a checked box as test evidence.
// Run --sync after editing the source; --phase 0 --gate refuses incomplete gates.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const source = readFileSync(resolve(root, "codex-mega-prompt.md"), "utf8");
const path = resolve(root, "docs/safety-pass-status.json");
const previous = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { requirements: [] };
let section = "Objective";
let phase = "global";
const requirements = [];
for (const [index, text] of source.split("\n").entries()) {
  if (/^#{2,3} /.test(text)) section = text.replace(/^#+ /, "");
  const phaseMatch = /^## Phase (\d):/.exec(text);
  if (phaseMatch) phase = phaseMatch[1];
  if (/^## (Final gate|Constraints restated)/.test(text)) phase = "final";
  if (!/^(?:- |\d+\. )/.test(text)) continue;
  const id = createHash("sha256").update(section + "\n" + text).digest("hex").slice(0, 16);
  const old = previous.requirements.find((item) => item.id === id);
  requirements.push({ id, phase, section, line: index + 1, status: old?.status ?? "pending", evidence: old?.evidence ?? [] });
}
if (process.argv.includes("--sync")) {
  const removed = previous.requirements.filter((old) => !requirements.some((item) => item.id === old.id));
  if (removed.length) throw new Error("Requirements changed or disappeared; reconcile the ledger explicitly before syncing.");
  writeFileSync(path, JSON.stringify({ source: "codex-mega-prompt.md", requirements }, null, 2) + "\n");
} else if (JSON.stringify(previous.requirements) !== JSON.stringify(requirements)) {
  throw new Error("Requirement ledger is stale. Run --sync to reconcile source positions.");
}
const phaseArg = process.argv.indexOf("--phase");
const selected = phaseArg < 0 ? requirements : requirements.filter((item) => item.phase === process.argv[phaseArg + 1]);
if (!selected.length) throw new Error("No requirements matched.");
for (const phase of [...new Set(selected.map((item) => item.phase))]) {
  const items = selected.filter((item) => item.phase === phase);
  const verified = items.filter((item) => item.status === "verified" && item.evidence.length > 0);
  console.log(`${phase}: ${verified.length}/${items.length} requirements have recorded verification evidence`);
}
if (process.argv.includes("--gate") && selected.some((item) => item.status !== "verified" || !item.evidence.length)) process.exitCode = 1;
