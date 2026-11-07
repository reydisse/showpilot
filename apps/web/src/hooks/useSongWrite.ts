import { useEffect, useMemo, useRef, useState } from "react";
import { createBrowserId } from "@/lib/browser-id";

type WriteState = { status: "idle" }
  | { status: "saving"; label: string; saved: boolean }
  | { status: "failed"; label: string; saved: boolean; message: string; at: number };
type SongChange<T> = {
  label: string;
  write: (requestId: string, signal: AbortSignal) => Promise<T>;
  apply: (result: T) => void;
  finish?: (result: T, signal: AbortSignal) => Promise<void>;
};
type PendingSongChange = { owner: { scope: string }; run: () => Promise<boolean>; controller: AbortController | null };

/** Abort also settles requests whose transport ignores cancellation. */
function bounded<T>(work: (signal: AbortSignal) => Promise<T>, controller: AbortController): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new Error("The request did not finish. Retry to confirm its result."));
    controller.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => controller.abort(), 10_000);
    Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new Error("Request cancelled.");
      return work(controller.signal);
    }).then(resolve, reject).finally(() => {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", cancel);
    });
    // Cancellation cleans up even when the underlying transport never settles.
    controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  });
}

/** One pending song change, with its exact request and acknowledged result retained for Retry. */
export function useSongWrite(scope: string) {
  const owner = useMemo(() => ({ scope }), [scope]);
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const [view, setView] = useState<{ owner: typeof owner; state: WriteState }>({ owner, state: { status: "idle" } });
  const command = useRef<PendingSongChange | null>(null);
  useEffect(() => () => {
    const pending = command.current;
    if (pending?.owner === owner) {
      command.current = null;
      pending.controller?.abort();
    }
  }, [owner]);

  const start = <T,>(change: SongChange<T>): Promise<boolean> => {
    if (command.current) return Promise.resolve(false);
    const requestId = createBrowserId();
    let result: { saved: false } | { saved: true; value: T } = { saved: false };
    let applied = false;
    const pending: PendingSongChange = { owner, controller: null, run: async (): Promise<boolean> => {
      if (pending.controller || currentOwner.current !== owner || command.current !== pending) return false;
      const controller = new AbortController();
      pending.controller = controller;
      const active = () => command.current === pending && currentOwner.current === owner && !controller.signal.aborted;
      setView({ owner, state: { status: "saving", label: change.label, saved: result.saved } });
      try {
        if (!result.saved) {
          const value = await bounded(signal => change.write(requestId, signal), controller);
          if (!active()) return false;
          result = { saved: true, value };
        }
        if (!applied) { change.apply(result.value); applied = true; }
        const finish = change.finish;
        if (finish) {
          const value = result.value;
          setView({ owner, state: { status: "saving", label: change.label, saved: true } });
          await bounded(signal => finish(value, signal), controller);
        }
        if (!active()) return false;
        command.current = null;
        setView({ owner, state: { status: "idle" } });
        return true;
      } catch (error) {
        if (command.current === pending && currentOwner.current === owner) {
          setView({ owner, state: { status: "failed", label: change.label, saved: result.saved,
            message: error instanceof Error ? error.message : "The song change could not be confirmed.", at: Date.now() } });
        }
        return false;
      } finally {
        controller.abort();
        pending.controller = null;
      }
    } };
    command.current = pending;
    return pending.run();
  };
  const state: WriteState = view.owner === owner ? view.state : { status: "idle" };
  return {
    state,
    start,
    retry: () => command.current?.owner === owner ? command.current.run() : Promise.resolve(false),
    // Call only after the user explicitly abandons the unconfirmed request.
    discard: () => {
      if (command.current?.controller) return;
      command.current = null;
      setView({ owner, state: { status: "idle" } });
    },
  };
}
