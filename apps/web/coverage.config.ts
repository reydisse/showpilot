import { resolve } from "node:path";

// Both Vitest runtimes must instrument the same files before their maps merge.
export const coverageGroups = {
  timecode: ["src/lib/timecode*.{ts,tsx}", "src/lib/timecode*/**/*.{ts,tsx}", "../../packages/shared/src/timecode*.ts", "../../packages/shared/src/automation-webhook-url.ts"],
  relays: ["src/durable-objects/**/*.{ts,tsx}"],
  devices: ["src/lib/device-modules/**/*.{ts,tsx}", "../../packages/shared/src/automation-action-params.ts"],
};

export function coverageOptions(pool: "unit" | "worker") {
  return {
    provider: "istanbul" as const,
    // Shared Timecode validation remains in the gate after moving out of web.
    allowExternal: true,
    include: Object.values(coverageGroups).flat().map(pattern => resolve(import.meta.dirname, pattern)),
    exclude: ["**/*.test.{ts,tsx}", "**/__tests__/**", "**/*.d.ts"],
    reporter: ["json" as const],
    reportsDirectory: `coverage/${pool}`,
  };
}
