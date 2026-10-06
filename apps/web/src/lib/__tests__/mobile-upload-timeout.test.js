import { afterEach, describe, expect, it, vi } from "vitest";
import { withUploadTimeout } from "../../../../mobile/src/lib/upload-timeout";

afterEach(() => vi.useRealTimers());

describe("mobile attachment upload deadline", () => {
  it("rejects a stalled native operation even when it ignores cancellation", async () => {
    vi.useFakeTimers();
    let signal;
    const result = withUploadTimeout((value) => {
      signal = value;
      return new Promise(() => {});
    });
    const rejected = expect(result).rejects.toThrow("upload timed out");
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns successful uploads and clears the deadline without aborting", async () => {
    vi.useFakeTimers();
    let signal;
    expect(await withUploadTimeout(async (value) => { signal = value; return "attachment"; })).toBe("attachment");
    expect(signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves actionable upload errors and clears the deadline", async () => {
    vi.useFakeTimers();
    await expect(withUploadTimeout(async () => { throw new Error("File too large"); })).rejects.toThrow("File too large");
    expect(vi.getTimerCount()).toBe(0);
  });
});
