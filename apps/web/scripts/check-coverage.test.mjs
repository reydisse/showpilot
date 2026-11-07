import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, test } from "node:test";
import { assertThresholds, checkCoverage, mergeCoverage, metrics, ratchetBaseline, sourceInventory } from "./check-coverage.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "showpilot-coverage-")); roots.push(root);
  const inventory = { timecode: ["src/lib/timecode.ts"], relays: ["src/durable-objects/Relay.ts"], devices: ["src/lib/device-modules/device.ts"] };
  const loc = line => ({ start: { line, column: 0 }, end: { line, column: 10 } });
  const reports = { unit: {}, worker: {} };
  for (const files of Object.values(inventory)) for (const file of files) {
    const path = resolve(root, file); mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, "export const first = () => 1;\nexport const second = () => 2;\n");
    for (const [pool, hits] of [["unit", [1, 0]], ["worker", [0, 1]]]) reports[pool][path] = {
      path, statementMap: { 0: loc(1), 1: loc(2) }, s: { 0: hits[0], 1: hits[1] },
      fnMap: { 0: { name: "first", decl: loc(1), loc: loc(1), line: 1 }, 1: { name: "second", decl: loc(2), loc: loc(2), line: 2 } }, f: { 0: hits[0], 1: hits[1] },
      branchMap: { 0: { loc: loc(1), type: "if", locations: [loc(1), loc(2)], line: 1 } }, b: { 0: hits },
    };
  }
  const baseline = { version: 1, groups: Object.fromEntries(Object.keys(inventory).map(group => [group, Object.fromEntries(metrics.map(metric => [metric, 90]))])) };
  return { root, inventory, reports, baseline };
}

test("counts complementary unit and Worker execution once, and discovers unimported source", () => {
  const f = fixture();
  writeFileSync(resolve(f.root, "src/lib/device-modules/types.ts"), "export interface Connection { id: string }\n");
  writeFileSync(resolve(f.root, "src/lib/timecode.test.ts"), "throw new Error('not source');\n");
  assert.deepEqual(sourceInventory(f.root), f.inventory);
  const { summary } = mergeCoverage(f.root, f.inventory, f.reports);
  for (const group of Object.values(summary.groups)) {
    for (const metric of metrics) assert.equal(group[metric].pct, 100);
    assert.equal(group.lines.total, 2); assert.equal(group.lines.covered, 2);
  }
  const missingPath = resolve(f.root, "src/lib/timecode-new.ts");
  writeFileSync(missingPath, "export const untested = () => 3;\n");
  assert.throws(() => mergeCoverage(f.root, sourceInventory(f.root), f.reports), /executable source missing.*timecode-new/);
});

test("rejects an empty or incomplete pool even if the other pool covers every file", () => {
  const f = fixture();
  assert.throws(() => mergeCoverage(f.root, f.inventory, { ...f.reports, worker: {} }), /worker: coverage report is empty/);
  delete f.reports.worker[resolve(f.root, f.inventory.relays[0])];
  assert.throws(() => mergeCoverage(f.root, f.inventory, f.reports), /worker: executable source missing/);
});

test("gates every metric separately and refuses a downward ratchet", () => {
  const f = fixture(); const { summary } = mergeCoverage(f.root, f.inventory, f.reports);
  assert.doesNotThrow(() => assertThresholds(summary, f.baseline));
  for (const group of Object.keys(summary.groups)) for (const metric of metrics) {
    const decreased = structuredClone(summary); decreased.groups[group][metric].pct = 89.99;
    assert.throws(() => assertThresholds(decreased, f.baseline), /Coverage decreased/);
    assert.throws(() => ratchetBaseline(decreased, f.baseline), /Coverage decreased/);
  }
  const raised = ratchetBaseline(summary, f.baseline);
  for (const group of Object.values(raised.groups)) for (const metric of metrics) assert.equal(group[metric], 100);
  assert.deepEqual(ratchetBaseline(summary, raised), raised);
  assert.throws(() => assertThresholds(summary, { version: 1, groups: {} }), /exactly the measured groups/);
  f.baseline.groups.timecode.lines = null;
  assert.throws(() => assertThresholds(summary, f.baseline), /Invalid threshold/);
});

test("a failed real report check preserves evidence and cannot rewrite the baseline", () => {
  const f = fixture();
  for (const [pool, report] of Object.entries(f.reports)) {
    mkdirSync(resolve(f.root, "coverage", pool), { recursive: true });
    // Simulate both test pools losing coverage of the second branch/function.
    for (const value of Object.values(report)) { value.s[1] = 0; value.f[1] = 0; value.b[0][1] = 0; }
    writeFileSync(resolve(f.root, "coverage", pool, "coverage-final.json"), JSON.stringify(report));
  }
  const baselinePath = resolve(f.root, "coverage-baseline.json");
  const original = JSON.stringify(f.baseline); writeFileSync(baselinePath, original);
  assert.throws(() => checkCoverage({ root: f.root, ratchet: true }), /Coverage decreased/);
  assert.equal(readFileSync(baselinePath, "utf8"), original);
  const summary = JSON.parse(readFileSync(resolve(f.root, "coverage/coverage-summary.json"), "utf8"));
  assert.equal(summary.groups.timecode.lines.pct, 50);
});
