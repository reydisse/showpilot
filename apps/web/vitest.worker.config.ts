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
          compatibilityDate: "2026-02-28",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["DB"],
          durableObjects: {
            BRIDGE_RELAY: "BridgeRelay",
            RUNDOWN_RELAY: "TestRundownRelay",
          },
          bindings: { TEST_MIGRATIONS: migrations },
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
