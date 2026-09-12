import { afterEach, describe, expect, it, vi } from "vitest";
import { withOperationTimeout } from "../operation-timeout";

afterEach(() => {
  vi.useRealTimers();
});

describe("withOperationTimeout", () => {
  it("returns an operation that completes inside the boundary", async () => {
    await expect(withOperationTimeout(Promise.resolve("ready"), 100, "late"))
      .resolves.toBe("ready");
  });

  it("rejects an operation that never answers", async () => {
    vi.useFakeTimers();
    const result = withOperationTimeout(new Promise<never>(() => {}), 15_000, "Bridge timed out");
    const rejection = expect(result).rejects.toThrow("Bridge timed out");
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
  });
});
