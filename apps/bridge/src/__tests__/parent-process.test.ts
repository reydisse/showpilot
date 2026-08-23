import { describe, expect, it, vi } from "vitest";
import {
  isParentProcessAlive,
  parseParentProcessId,
  startParentProcessMonitor,
} from "../parent-process.js";

describe("desktop parent process monitoring", () => {
  it("accepts only safe process ids", () => {
    expect(parseParentProcessId("123")).toBe(123);
    for (const value of [undefined, "", "0", "1", "-2", "12x"]) {
      expect(parseParentProcessId(value)).toBeNull();
    }
  });

  it("treats an existing or permission-protected parent as alive", () => {
    expect(isParentProcessAlive(123, vi.fn())).toBe(true);
    expect(
      isParentProcessAlive(123, () => {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      }),
    ).toBe(true);
  });

  it("treats a missing parent as dead", () => {
    expect(
      isParentProcessAlive(123, () => {
        throw Object.assign(new Error("missing"), { code: "ESRCH" });
      }),
    ).toBe(false);
  });

  it("does not start a monitor without a desktop parent", () => {
    expect(startParentProcessMonitor(undefined, vi.fn())).toBeNull();
  });

  it("reports a dead desktop parent only once", () => {
    vi.useFakeTimers();
    const orphaned = vi.fn();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("missing"), { code: "ESRCH" });
    });

    startParentProcessMonitor("123", orphaned, 100);
    vi.advanceTimersByTime(500);

    expect(orphaned).toHaveBeenCalledTimes(1);
    kill.mockRestore();
    vi.useRealTimers();
  });
});
