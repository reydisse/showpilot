import { describe, expect, it } from "vitest";
import { SerialCommandExecutor } from "../serial-command-executor";

describe("SerialCommandExecutor", () => {
  it("does not enter a second transition while the first is awaiting persistence", async () => {
    const executor = new SerialCommandExecutor();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = executor.run(async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
      return 1;
    });
    const second = executor.run(async () => {
      events.push("second:start");
      return 2;
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("releases the next transition after a failure", async () => {
    const executor = new SerialCommandExecutor();
    const first = executor.run(async () => {
      throw new Error("persistence failed");
    });
    const second = executor.run(async () => "accepted");

    await expect(first).rejects.toThrow("persistence failed");
    await expect(second).resolves.toBe("accepted");
  });
});
