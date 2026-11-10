import { globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import coverage from "istanbul-lib-coverage";
import ts from "typescript";
import { coverageGroups, coverageOptions } from "../coverage.config.ts";

export const metrics = ["statements", "branches", "functions", "lines"];
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const json = path => JSON.parse(readFileSync(path, "utf8"));
const save = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

export function sourceInventory(root) {
  return Object.fromEntries(Object.entries(coverageGroups).map(([group, patterns]) => [group,
    [...new Set(globSync(patterns, { cwd: root, exclude: coverageOptions("unit").exclude }))].filter(file => {
      // Interfaces and type-only protocol contracts have no executable counters.
      // Use the compiler, not a hand-maintained filename exemption list.
      const output = ts.transpileModule(readFileSync(resolve(root, file), "utf8"), {
        fileName: file, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, removeComments: true },
      }).outputText.trim();
      return output !== "" && !/^export\s*\{\s*\};?$/.test(output);
    }).sort(),
  ]));
}

export function mergeCoverage(root, inventory, reports) {
  const merged = coverage.createCoverageMap({});
  for (const [pool, report] of Object.entries(reports)) {
    const map = coverage.createCoverageMap(report);
    if (map.files().length === 0) throw new Error(`${pool}: coverage report is empty`);
    const paths = new Set(map.files().map(file => relative(root, file).split(sep).join("/")));
    for (const files of Object.values(inventory)) for (const file of files) {
      if (!paths.has(file)) throw new Error(`${pool}: executable source missing from coverage: ${file}`);
    }
    merged.merge(map);
  }
  const groups = Object.fromEntries(Object.entries(inventory).map(([group, files]) => {
    if (files.length === 0) throw new Error(`${group}: no executable source files found`);
    const summary = coverage.createCoverageSummary();
    for (const file of files) summary.merge(merged.fileCoverageFor(resolve(root, file)).toSummary());
    const values = summary.toJSON();
    for (const metric of metrics) if (!Number.isFinite(values[metric].pct) || values[metric].total === 0) {
      throw new Error(`${group}: no measurable ${metric} coverage`);
    }
    return [group, { files: files.length, ...values }];
  }));
  return { merged: merged.toJSON(), summary: { groups } };
}

export function assertThresholds(summary, baseline) {
  if (baseline.version !== 1 || !baseline.groups || Object.keys(baseline.groups).sort().join() !== Object.keys(summary.groups).sort().join()) {
    throw new Error("Coverage baseline must contain exactly the measured groups and version 1");
  }
  const failures = [];
  for (const [group, values] of Object.entries(summary.groups)) for (const metric of metrics) {
    const threshold = baseline.groups[group][metric];
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) throw new Error(`Invalid threshold: ${group}.${metric}`);
    const actual = values[metric].pct;
    if (actual < threshold) failures.push(`${group}.${metric}: ${actual}% is below ${threshold}%`);
  }
  if (failures.length) throw new Error(`Coverage decreased:\n${failures.join("\n")}`);
}

export function ratchetBaseline(summary, baseline) {
  // A local update can only raise thresholds. Regression must be fixed first.
  assertThresholds(summary, baseline);
  return { version: 1, groups: Object.fromEntries(Object.entries(summary.groups).map(([group, values]) => [group,
    Object.fromEntries(metrics.map(metric => [metric, Math.max(baseline.groups[group][metric], Math.floor(values[metric].pct))])),
  ])) };
}

export function checkCoverage({ root = webRoot, ratchet = false } = {}) {
  const directory = resolve(root, "coverage");
  const reports = Object.fromEntries(["unit", "worker"].map(pool => [pool, json(resolve(directory, pool, "coverage-final.json"))]));
  const { merged, summary } = mergeCoverage(root, sourceInventory(root), reports);
  mkdirSync(directory, { recursive: true });
  // Preserve measured evidence even when the gate rejects a regression.
  save(resolve(directory, "coverage-final.json"), merged);
  save(resolve(directory, "coverage-summary.json"), summary);
  const baselinePath = resolve(root, "coverage-baseline.json");
  const baseline = json(baselinePath);
  assertThresholds(summary, baseline);
  if (ratchet) save(baselinePath, ratchetBaseline(summary, baseline));
  for (const [group, values] of Object.entries(summary.groups)) {
    console.log(`${group} (${values.files} files): ${metrics.map(metric => `${metric} ${values[metric].pct}%`).join(", ")}`);
  }
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.slice(2).some(arg => arg !== "--ratchet")) throw new Error("Usage: node scripts/check-coverage.mjs [--ratchet]");
    checkCoverage({ ratchet: process.argv.includes("--ratchet") });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
