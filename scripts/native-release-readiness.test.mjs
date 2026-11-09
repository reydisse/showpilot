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

test("rejects a Windows release path that hides the unsigned fallback", () => {
  for (const product of ["desktop", "bridge"]) {
    const current = snapshot();
    current.products[product].workflow = current.products[product].workflow.replace(
      "UNSIGNED Windows build: Windows signing credentials are entirely absent.",
      "Windows signing is optional.",
    );
    assert.ok(findNativeReleaseIssues(current).some((issue) => issue.includes("release workflow is missing")));
  }
});

test("rejects platform jobs that bypass the signing preflight", () => {
  for (const product of ["desktop", "bridge"]) {
    const current = snapshot();
    current.products[product].workflow = current.products[product].workflow.replace("needs: signing-preflight", "needs: []");
    assert.ok(findNativeReleaseIssues(current).some(issue => issue.includes("must wait for the shared signing preflight")));
  }
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

test("rejects synchronous desktop companion-window creation", () => {
  const current = snapshot();
  current.products.desktop.source = current.products.desktop.source.replace(
    "async fn open_companion_window(",
    "fn open_companion_window(",
  );
  const issues = findNativeReleaseIssues(current);
  assert.ok(issues.some((issue) => issue.includes("Windows WebView deadlocks")));
});

test("rejects desktop builds that bypass the bundled offline shell", () => {
  const current = snapshot();
  current.products.desktop.tauri.build.frontendDist = "https://showpilot.tech";
  const issues = findNativeReleaseIssues(current);
  assert.ok(issues.some((issue) => issue.includes("bundled offline shell")));
});


test("rejects missing hosted-workspace native command permissions", () => {
  const current = snapshot();
  const permission = current.products.desktop.permissions.permission[0];
  permission.commands.allow = permission.commands.allow.filter((command) => command !== "open_companion_window");
  assert.ok(findNativeReleaseIssues(current).some((issue) => issue.includes("explicitly permit")));
});

test("rejects untrusted origins and missing check-in window access", () => {
  const current = snapshot();
  current.products.desktop.capabilities.remote.urls.push("https://untrusted.example/*");
  current.products.desktop.capabilities.windows = ["main", "timer-*", "show-board-*", "confidence-*"];
  const issues = findNativeReleaseIssues(current);
  assert.ok(issues.some((issue) => issue.includes("trusted ShowPilot web origins")));
  assert.ok(issues.some((issue) => issue.includes("every companion window")));
});

test("rejects MIDI access from companion windows or untrusted origins", () => {
  const mutations = [
    desktop => desktop.midiCapabilities.windows.push("confidence-*"),
    desktop => desktop.midiCapabilities.remote.urls.push("https://untrusted.example/*"),
    desktop => desktop.capabilities.permissions.push("allow-midi-controller"),
    desktop => desktop.permissions.permission[0].commands.allow.push("midi_controller_feedback"),
    desktop => desktop.midiPermissions.permission[0].commands.allow.pop(),
  ];
  for (const mutate of mutations) {
    const current = snapshot(); mutate(current.products.desktop);
    assert.ok(findNativeReleaseIssues(current).some(issue => issue.includes("MIDI commands must be restricted")));
  }
});

test("rejects local show control from companion windows or untrusted origins", () => {
  const mutations = [
    desktop => desktop.localShowCapabilities.windows.push("confidence-*"),
    desktop => desktop.localShowCapabilities.remote.urls.push("https://untrusted.example/*"),
    desktop => desktop.capabilities.permissions.push("allow-local-show-control"),
    desktop => desktop.permissions.permission[0].commands.allow.push("local_show_command"),
    desktop => desktop.permissions.permission[0].commands.allow.push("open_local_show"),
    desktop => desktop.localShowPermissions.permission[0].commands.allow.pop(),
  ];
  for (const mutate of mutations) {
    const current = snapshot(); mutate(current.products.desktop);
    assert.ok(findNativeReleaseIssues(current).some(issue => issue.includes("local show control must be restricted")));
  }
});

test("rejects missing DeckLink runtime signing entitlement", () => {
  const current = snapshot();
  current.products.desktop.tauri.bundle.macOS.entitlements = undefined;
  assert.ok(findNativeReleaseIssues(current).some(issue => issue.includes("Blackmagic driver")));
  current.products.desktop.tauri.bundle.macOS.entitlements = "entitlements.plist";
  current.products.desktop.entitlements = current.products.desktop.entitlements.replace("<true/>", "<false/>");
  assert.ok(findNativeReleaseIssues(current).some(issue => issue.includes("Blackmagic driver")));
});
