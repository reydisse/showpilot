export class MobileOperationTimeoutError extends Error {
  constructor() {
    super("The operation timed out.");
    this.name = "MobileOperationTimeoutError";
  }
}

/** Bound native requests and refresh callbacks, including transports that ignore
 * cancellation. Mutation results can remain uncertain after this deadline. */
export function runMobileOperation<T>(
  work: (controller: AbortController) => Promise<T>,
  parent: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let cancel = () => {};
  let timer: ReturnType<typeof setTimeout>;
  const interrupted = new Promise<never>((_, reject) => {
    const stop = (reason: unknown) => {
      reject(reason);
      controller.abort();
    };
    cancel = () => stop(new Error("The view closed."));
    timer = setTimeout(
      () => stop(new MobileOperationTimeoutError()),
      timeoutMs,
    );
    if (parent?.aborted) cancel();
    else parent?.addEventListener("abort", cancel, { once: true });
  });
  return Promise.race([
    Promise.resolve().then(() => {
      if (controller.signal.aborted)
        throw new Error("The operation was cancelled.");
      return work(controller);
    }),
    interrupted,
  ]).finally(() => {
    clearTimeout(timer);
    parent?.removeEventListener("abort", cancel);
  });
}
