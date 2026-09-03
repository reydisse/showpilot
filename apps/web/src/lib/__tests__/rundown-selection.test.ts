import { describe, expect, it } from "vitest";
import { waitForRundownWrites } from "../rundown-selection";

describe("waitForRundownWrites", () => {
  it("waits through a debounced save and two stable idle observations", async () => {
    let checks = 0;
    let clock = 0;
    await waitForRundownWrites(
      () => ++checks <= 2,
      {
        timeoutMs: 1_000,
        now: () => clock,
        wait: async (milliseconds) => { clock += milliseconds; },
      },
    );
    expect(checks).toBe(4);
  });

  it("fails without switching when confirmation never arrives", async () => {
    let clock = 0;
    await expect(waitForRundownWrites(
      () => true,
      {
        timeoutMs: 100,
        intervalMs: 50,
        now: () => clock,
        wait: async (milliseconds) => { clock += milliseconds; },
      },
    )).rejects.toThrow("still waiting for live confirmation");
  });
});
