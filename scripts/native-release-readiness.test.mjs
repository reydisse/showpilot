import assert from "node:assert/strict";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findNativeReleaseIssues,
  loadNativeReleaseSnapshot,
} from "./native-release-readiness.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function snapshot() {
  return structuredClone(loadNativeReleaseSnapshot(root));
}

test("the repository satisfies every native release contract", () => {
  assert.deepEqual(findNativeReleaseIssues(snapshot()), []);
});

test("rejects drift between installer, Cargo, lockfile, and engine versions", () => {
  const current = snapshot();
  current.products.bridge.tauri.version = "9.9.9";
  const issues = findNativeReleaseIssues(current);
  assert.ok(issues.some((issue) => issue.includes("versions must match")));
});

test("rejects a release tag that does not exactly match product metadata", () => {
  const current = snapshot();
  const issues = findNativeReleaseIssues(current, {
    product: "desktop",
    tagName: "desktop-v0.1.0",
  });
  assert.ok(issues.some((issue) => issue.includes("tag must be exactly")));
});

test("requires product and tag together", () => {
  const current = snapshot();
  assert.ok(
    findNativeReleaseIssues(current, { tagName: "desktop-v0.1.1" }).some(
      (issue) => issue.includes("native product is required"),
    ),
  );
  assert.ok(
    findNativeReleaseIssues(current, { product: "desktop" }).some((issue) =>
      issue.includes("release tag is required"),
    ),
  );
});

test("accepts the exact release tag for each product", () => {
  const current = snapshot();
  for (const product of ["desktop", "bridge"]) {
    const version = current.products[product].packageVersion;
    assert.deepEqual(
      findNativeReleaseIssues(current, {
        product,
        tagName: `${product}-v${version}`,
      }),
      [],
    );
  }
});

test("rejects updater trust and distribution workflow regressions", () => {
  const current = snapshot();
  current.products.bridge.tauri.plugins.updater.pubkey = "not-a-key";
  current.products.desktop.workflow = current.products.desktop.workflow.replace(
    "Get-AuthenticodeSignature",
    "Get-SomethingElse",
  );
  const issues = findNativeReleaseIssues(current);
  assert.ok(issues.some((issue) => issue.includes("minisign updater public key")));
  assert.ok(
    issues.some(
      (issue) =>
        issue.includes("release workflow is missing") &&
        issue.includes("Get-AuthenticodeSignature"),
    ),
  );
});

test("rejects landing routes that bypass the release Worker", () => {
  const current = snapshot();
  current.landingWrangler.assets.run_worker_first = [
    "/downloads/*",
    "/updates/*",
  ];
  const issues = findNativeReleaseIssues(current);
  assert.ok(
    issues.some((issue) =>
      issue.includes("Landing Worker must run first for /downloads."),
    ),
  );
});
