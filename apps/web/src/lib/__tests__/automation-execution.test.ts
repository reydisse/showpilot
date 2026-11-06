import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationExecutor } from "../automation-execution";

afterEach(() => vi.useRealTimers());
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("automation output execution", () => {
  it("orders one output while running unrelated outputs concurrently", async () => {
    vi.useFakeTimers();
    const executor = new AutomationExecutor();
    const observed: string[] = [];
    const first = executor.run("graphics", 100, async () => { observed.push("show"); await delay(20); observed.push("ack"); });
    const second = executor.run("graphics", 100, async () => { observed.push("clear"); });
    const other = executor.run("lyrics", 100, async () => { observed.push("lyrics"); });
    await vi.advanceTimersByTimeAsync(0);
    expect(observed).toEqual(["show", "lyrics"]);
    await vi.advanceTimersByTimeAsync(20);
    await Promise.all([first, second, other]);
    expect(observed).toEqual(["show", "lyrics", "ack", "clear"]);
  });

  it("aborts a slow operation and suppresses its late follow-up action", async () => {
    vi.useFakeTimers();
    const executor = new AutomationExecutor();
    const followUp = vi.fn();
    const result = executor.run("device", 10, async (signal) => {
      await delay(30);
      signal.throwIfAborted();
      followUp();
    });
    const rejected = expect(result).rejects.toThrow("timed out after 10 ms");
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    await vi.advanceTimersByTimeAsync(30);
    expect(followUp).not.toHaveBeenCalled();
    await expect(executor.run("device", 10, async () => {})).resolves.toBeUndefined();
  });

  it("does not dispatch an action whose deadline expired while queued", async () => {
    vi.useFakeTimers();
    const executor = new AutomationExecutor();
    const queued = vi.fn(async () => {});
    const first = executor.run("device", 100, () => delay(20));
    const second = executor.run("device", 5, queued);
    const rejected = expect(second).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(5);
    await rejected;
    await vi.advanceTimersByTimeAsync(20);
    await first;
    expect(queued).not.toHaveBeenCalled();
  });
});
