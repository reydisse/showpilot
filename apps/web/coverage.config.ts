// Both Vitest runtimes must instrument the same files before their maps merge.
export const coverageGroups = {
  timecode: ["src/lib/timecode*.{ts,tsx}", "src/lib/timecode*/**/*.{ts,tsx}"],
  relays: ["src/durable-objects/**/*.{ts,tsx}"],
  devices: ["src/lib/device-modules/**/*.{ts,tsx}"],
};

export function coverageOptions(pool: "unit" | "worker") {
  return {
    provider: "istanbul" as const,
    include: Object.values(coverageGroups).flat(),
    exclude: ["**/*.test.{ts,tsx}", "**/__tests__/**", "**/*.d.ts"],
    reporter: ["json" as const],
    reportsDirectory: `coverage/${pool}`,
  };
}
