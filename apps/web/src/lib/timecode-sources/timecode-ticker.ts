/** A worker keeps clock callbacks independent of the page's animation loop. */
export function startTimecodeTicker(
  tick: () => void,
  ticksPerSecond: 30 | 60 = 30,
): () => void {
  let active = true;
  let worker: Worker | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  const deliver = () => {
    if (active) tick();
  };
  const fallback = () => {
    worker?.terminate();
    worker = undefined;
    if (active && interval === undefined)
      interval = setInterval(deliver, 1_000 / ticksPerSecond);
  };
  try {
    worker = new Worker(
      new URL("./timecode-ticker.worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data === "tick") deliver();
    };
    worker.onerror = fallback;
    worker.postMessage(ticksPerSecond);
  } catch {
    // Older webviews may not support module workers. Keep a real elapsed clock;
    // if the page itself is suspended, the relay's feed watchdog still applies.
    fallback();
  }
  return () => {
    active = false;
    worker?.terminate();
    if (interval !== undefined) clearInterval(interval);
  };
}
