import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../../..");

function source(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function requiresFragments(path, fragments) {
  const text = source(path);
  for (const fragment of fragments) {
    assert.ok(text.includes(fragment), `${path} must include ${fragment}`);
  }
}

test("screen-bound web polling pauses while hidden and cannot overlap", () => {
  const contracts = [
    ["apps/web/src/hooks/useProPresenter.ts", ["document.visibilityState", "request !== current", "controller.abort()"]],
    ["apps/web/src/components/dashboard/tm-operations.tsx", ["document.visibilityState", "useLiveInputHealth", "refreshInFlightRef"]],
    ["apps/web/src/components/layout/NotificationCenter.tsx", ["document.visibilityState", "refreshInFlightRef"]],
    ["apps/web/src/components/layout/LiveRundownBar.tsx", ["document.visibilityState", "refreshing"]],
    ["apps/web/src/routes/$slug/schedule.tsx", ["document.visibilityState", "refreshing"]],
    ["apps/web/src/routes/$slug/streaming/health.tsx", ["useLiveInputHealth", "useOperatorRead"]],
    ["apps/web/src/hooks/useLiveInputHealth.ts", ["useOperatorRead", "signal", "key", "intervalMs: 10_000"]],
    ["apps/web/src/routes/$slug/streaming/platforms.tsx", ["useOperatorRead", "signal", "key: outputKey"]],
    ["apps/web/src/routes/$slug/show.tsx", ["useOperatorRead", "signal", "key: `${orgId}:${today}`"]],
    ["apps/web/src/hooks/useOperatorRead.ts", ["document.visibilityState", "request !== current", "controller.abort()"]],
    ["apps/web/src/routes/$slug/board.tsx", ["document.visibilityState", "refreshing"]],
    ["apps/web/src/routes/timer/$orgSlug.tsx", ["document.visibilityState", "wsConnectedRef.current"]],
  ];
  for (const [path, fragments] of contracts) requiresFragments(path, fragments);
});

test("Bridge and device feedback polling prevent overlap without pausing output", () => {
  requiresFragments("apps/bridge/src/protocols/propresenter.ts", ["private pollInFlight = false", "this.pollInFlight"]);
  requiresFragments("apps/web/src/lib/device-modules/profiles/profile-driven-module.ts", ["pollingFeedbackIds", "finally"]);
});

test("external chat pauses hidden polling and prevents concurrent requests", () => {
  requiresFragments("apps/web/src/lib/adapters/external-chat-adapter-base.ts", [
    "document.visibilityState !== \"visible\"",
    "this.pollInFlight",
  ]);
});

test("mobile route polling remains tied to screen focus and app focus", () => {
  requiresFragments("apps/mobile/src/hooks/use-screen-polling.ts", ["useFocusEffect", "return useScreenFocus() ? intervalMs : false"]);
  requiresFragments("apps/mobile/src/providers/app-providers.tsx", ["focusManager.setFocused", "refetchIntervalInBackground: false"]);
});
