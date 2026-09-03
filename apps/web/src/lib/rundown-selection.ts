interface RundownWriteWaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

/**
 * Wait until an in-flight rundown edit is observably idle before changing
 * rooms. Two consecutive idle checks cover React's batched transition from a
 * completed debounce to the relay's command-confirmation state.
 */
export async function waitForRundownWrites(
  isBusy: () => boolean,
  options: RundownWriteWaitOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 12_000;
  const intervalMs = options.intervalMs ?? 50;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds)));
  const deadline = now() + timeoutMs;
  let consecutiveIdleChecks = 0;

  while (now() < deadline) {
    if (isBusy()) {
      consecutiveIdleChecks = 0;
    } else {
      consecutiveIdleChecks += 1;
      if (consecutiveIdleChecks >= 2) return;
    }
    await wait(intervalMs);
  }

  throw new Error("The current rundown change is still waiting for live confirmation.");
}
