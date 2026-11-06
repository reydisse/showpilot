import { afterEach, expect, it, vi } from "vitest";
import {
  PROP_CLEAR_DELAY_MS,
  runProPresenterCue,
} from "../automation-propresenter";
import { AutomationExecutor } from "../automation-execution";

afterEach(() => vi.useRealTimers());

it("cancels during the clear-to-trigger delay without triggering or leaking a timer", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const send = vi.fn(async (command: Record<string, unknown>) =>
    command.action === "resolve-prop" ? '{"propUuid":"one"}' : undefined,
  );
  const result = runProPresenterCue({
    action: "pp-trigger-prop",
    payload: { propName: "Standby" },
    send,
    signal: controller.signal,
    assertCanDispatch: () => controller.signal.throwIfAborted(),
  });
  const rejected = expect(result).rejects.toThrow("Cancelled");
  await vi.advanceTimersByTimeAsync(PROP_CLEAR_DELAY_MS / 2);
  expect(send.mock.calls.map(([command]) => command.action)).toEqual([
    "resolve-prop",
    "clear-props",
  ]);
  controller.abort(new Error("Cancelled"));
  await rejected;
  await vi.advanceTimersByTimeAsync(PROP_CLEAR_DELAY_MS * 2);
  expect(send).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("cannot trigger after a clear acknowledgment arrives beyond the execution deadline", async () => {
  vi.useFakeTimers();
  let release = () => {};
  const send = vi.fn(async (command: Record<string, unknown>) => {
    if (command.action === "resolve-prop") return '{"propUuid":"one"}';
    if (command.action === "clear-props")
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return undefined;
  });
  const executor = new AutomationExecutor();
  const result = executor.run("propresenter", 10000, (signal) =>
    runProPresenterCue({
      action: "pp-trigger-prop",
      payload: { propName: "Standby" },
      send,
      signal,
      assertCanDispatch: () => signal.throwIfAborted(),
    }),
  );
  const rejected = expect(result).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(10001);
  await rejected;
  release();
  await vi.advanceTimersByTimeAsync(1000);
  expect(send.mock.calls.map(([command]) => command.action)).toEqual([
    "resolve-prop",
    "clear-props",
  ]);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([undefined, "null", "{}", '{"propUuid":3}', "not json"])(
  "does not clear for an invalid Bridge resolution response: %s",
  async (response) => {
    const send = vi.fn(async () => response);
    await expect(
      runProPresenterCue({
        action: "pp-trigger-prop",
        payload: { propName: "Standby" },
        send,
        signal: new AbortController().signal,
        assertCanDispatch: () => {},
      }),
    ).rejects.toThrow();
    expect(send).toHaveBeenCalledExactlyOnceWith(
      { action: "resolve-prop", propName: "Standby" },
      "resolve",
    );
  },
);
