import { useCallback, useEffect, useRef, useState } from "react";

export interface OperatorReadFailure { message: string; occurredAt: number }
interface PendingRead { controller: AbortController; deadline?: ReturnType<typeof setTimeout> }
interface ReadOptions<T> {
  key: string;
  initialValue: T;
  read: (signal: AbortSignal, previous: T) => Promise<T>;
  errorMessage: string;
  intervalMs?: number;
  enabled?: boolean;
  pauseWhenHidden?: boolean;
}

/** Bounded reads retain confirmed data and cancel stale work. Output feeds can opt into background polling. */
export function useOperatorRead<T>({ key, initialValue, read, errorMessage, intervalMs, enabled = true, pauseWhenHidden = true }: ReadOptions<T>) {
  const [state, setState] = useState<{ key: string; value: T; error: OperatorReadFailure | null; refreshing: boolean; confirmedAt: number | null }>({ key, value: initialValue, error: null, refreshing: false, confirmedAt: null });
  const initialRef = useRef(initialValue);
  initialRef.current = initialValue;
  const retryRef = useRef<() => void>(() => {});
  const retry = useCallback(() => retryRef.current(), []);

  useEffect(() => {
    let disposed = false;
    let value = initialRef.current;
    let failures = 0;
    let confirmedAt: number | null = null;
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    let request: PendingRead | null = null;
    setState({ key, value, error: null, refreshing: false, confirmedAt });
    const visible = () => !pauseWhenHidden || document.visibilityState !== "hidden";
    const clearScheduled = () => { if (scheduled !== undefined) clearTimeout(scheduled); scheduled = undefined; };
    const cancel = () => {
      const current = request; request = null;
      if (current?.deadline !== undefined) clearTimeout(current.deadline);
      current?.controller.abort();
    };
    const refresh = async () => {
      if (disposed || !enabled || !visible() || request) return;
      clearScheduled();
      const current: PendingRead = { controller: new AbortController() };
      request = current;
      setState(previous => ({ ...previous, refreshing: true }));
      try {
        const next = await Promise.race([
          Promise.resolve().then(() => disposed || request !== current || current.controller.signal.aborted ? value : read(current.controller.signal, value)),
          new Promise<never>((_resolve, reject) => {
            current.deadline = setTimeout(() => { current.controller.abort(); reject(new Error("Read confirmation timed out")); }, 8_000);
          }),
        ]);
        if (disposed || request !== current) return;
        value = next; failures = 0; confirmedAt = Date.now();
        setState({ key, value, error: null, refreshing: false, confirmedAt });
      } catch {
        if (disposed || request !== current) return;
        failures++;
        setState({ key, value, error: { message: errorMessage, occurredAt: Date.now() }, refreshing: false, confirmedAt });
      } finally {
        if (current.deadline !== undefined) clearTimeout(current.deadline);
        if (request === current) {
          request = null;
          if (!disposed && enabled && visible() && intervalMs !== undefined) {
            scheduled = setTimeout(() => { void refresh(); }, Math.min(intervalMs * 2 ** Math.min(failures, 5), 30_000));
          }
        }
      }
    };
    const visibilityChanged = () => {
      clearScheduled();
      if (visible()) void refresh();
      else { cancel(); setState(previous => ({ ...previous, refreshing: false })); }
    };
    retryRef.current = () => { void refresh(); };
    if (enabled) {
      void refresh();
      if (pauseWhenHidden) document.addEventListener("visibilitychange", visibilityChanged);
    }
    return () => {
      disposed = true; retryRef.current = () => {};
      clearScheduled(); cancel();
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [key, read, errorMessage, intervalMs, enabled, pauseWhenHidden]);

  const current = enabled && state.key === key ? state : { value: initialValue, error: null, refreshing: false, confirmedAt: null };
  return { value: current.value, error: current.error, refreshing: current.refreshing, confirmedAt: current.confirmedAt, retry };
}
