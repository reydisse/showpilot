// No DOM, relay authority, or automation lives in this worker. Every callback
// samples elapsed time on the owning page; queued ticks cannot replay old frames.
let started = false;
addEventListener("message", (event: MessageEvent<unknown>) => {
  if (started || (event.data !== 30 && event.data !== 60)) return;
  started = true;
  const intervalMs = 1_000 / event.data;
  setInterval(() => postMessage("tick"), intervalMs);
});

export {};
