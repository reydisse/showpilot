import { useCallback, useEffect, useRef, useState } from "react";
import { mutateGraphicLibrary, type GraphicLibraryOperation } from "@/lib/graphics";
import type { OperatorReadFailure } from "./useOperatorRead";

interface Attempt { orgId: string; requestId: string; operation: GraphicLibraryOperation }
interface Pending { controller: AbortController; timer?: ReturnType<typeof setTimeout> }

/** Keep the captured operation until acknowledged. Retry uses its original receipt key. */
export function useGraphicLibraryMutation(orgId: string) {
  const [state, setState] = useState<{ orgId: string; pending: boolean; failure: OperatorReadFailure | null; attempt: Attempt | null }>({ orgId, pending: false, failure: null, attempt: null });
  const attempt = useRef<Attempt | null>(null);
  const pending = useRef<Pending | null>(null);
  const scope = useRef(orgId);
  scope.current = orgId;
  useEffect(() => {
    attempt.current = null;
    setState({ orgId, pending: false, failure: null, attempt: null });
    return () => {
      const old = pending.current;
      pending.current = null;
      if (old?.timer !== undefined) clearTimeout(old.timer);
      old?.controller.abort();
    };
  }, [orgId]);
  const run = useCallback(async (operation?: GraphicLibraryOperation) => {
    if (pending.current) return false;
    if (operation && attempt.current) return false;
    const captured = attempt.current ?? (operation ? { orgId: scope.current, requestId: crypto.randomUUID(), operation: structuredClone(operation) } : null);
    if (!captured || captured.orgId !== scope.current) return false;
    attempt.current = captured;
    const current: Pending = { controller: new AbortController() };
    pending.current = current;
    setState({ orgId: captured.orgId, pending: true, failure: null, attempt: captured });
    try {
      const result = await Promise.race([
        mutateGraphicLibrary({ data: captured, signal: current.controller.signal }),
        new Promise<never>((_resolve, reject) => { current.timer = setTimeout(() => { current.controller.abort(); reject(new Error("Confirmation timed out")); }, 10_000); }),
      ]);
      if (pending.current !== current || scope.current !== captured.orgId) return false;
      if (result?.requestId !== captured.requestId || !result.id) throw new Error("Missing acknowledgement");
      attempt.current = null;
      setState({ orgId: captured.orgId, pending: false, failure: null, attempt: null });
      return true;
    } catch {
      if (pending.current !== current || scope.current !== captured.orgId) return false;
      setState({ orgId: captured.orgId, pending: false, attempt: captured, failure: {
        message: "Graphics library change was not confirmed. Retry checks the same change without duplicating it. Your original content is retained.",
        occurredAt: Date.now(),
      } });
      return false;
    } finally {
      if (current.timer !== undefined) clearTimeout(current.timer);
      if (pending.current === current) pending.current = null;
    }
  }, []);
  const current = state.orgId === orgId ? state : { pending: false, failure: null, attempt: null };
  const reviewed = useCallback(() => {
    if (pending.current) return;
    attempt.current = null;
    setState({ orgId: scope.current, pending: false, failure: null, attempt: null });
  }, []);
  return { ...current, run, reviewed, locked: current.attempt !== null };
}
