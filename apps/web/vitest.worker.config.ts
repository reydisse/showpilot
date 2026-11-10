import path from "node:path";

import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    path.join(import.meta.dirname, "prisma/migrations"),
  );

  return {
    plugins: [
      cloudflareTest({
        main: "./src/test/worker-entry.ts",
        miniflare: {
          modulesRules: [
            // Keep the real crypto implementation in workerd's native module
            // loader. Vitest's transformed imports add overhead inside hash
            // loops (about 10x for PIN derivation), exhausting CI test deadlines.
            { type: "ESModule", include: ["**/node_modules/@noble/hashes/*.js"] },
            { type: "CompiledWasm", include: ["**/*.wasm", "**/*.wasm?module"] },
          ],
          compatibilityDate: "2026-02-28",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["DB"],
          r2Buckets: ["STORAGE"],
          durableObjects: {
            BRIDGE_RELAY: { className: "BridgeRelay", useSQLite: true },
            CHAT_RELAY: { className: "ChatRelay", useSQLite: true },
            RUNDOWN_RELAY: { className: "TestRundownRelay", useSQLite: true },
            TIMECODE_RELAY: { className: "TestTimecodeRelay", useSQLite: true },
            LOWER_THIRDS_RELAY: { className: "TestLowerThirdsRelay", useSQLite: true },
            CUE_SHEET_RELAY: { className: "CueSheetRelay", useSQLite: true },
          },
          bindings: {
            TEST_MIGRATIONS: migrations,
            CREDENTIAL_ENCRYPTION_KEYS: JSON.stringify({ active: "test", keys: { test: Buffer.alloc(32, 19).toString("base64") } }),
            BETTER_AUTH_SECRET: "worker-test-secret-for-local-integration-only",
            KIOSK_SECRET: "worker-test-kiosk-secret-for-local-integration-only",
            COMPANION_SECRET: "worker-test-companion-secret-for-local-integration-only",
            BETTER_AUTH_URL: "https://app.showpilot.tech",
            TEST_SHARE_PRISMA: process.env.SHOWPILOT_PROBE_ISOLATE_PRISMA === "1",
          },
        },
      }),
    ],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "./src"),
      },
    },
    test: {
      include: ["src/**/*.worker.test.{ts,tsx}"],
      setupFiles: ["./src/test/apply-worker-migrations.ts"],
    },
  };
});
