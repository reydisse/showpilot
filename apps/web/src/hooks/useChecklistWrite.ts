import { useCallback, useEffect, useRef, useState } from "react";
import { mutateChecklist } from "@/lib/data";
import type { ChecklistOperation, ChecklistWrite, ChecklistWriteResult } from "@/lib/checklist-writes";
import type { OperatorReadFailure } from "./useOperatorRead";

type WriteState =
  | { kind: "idle" }
  | { kind: "pending"; attempt: ChecklistWrite }
  | { kind: "uncertain" | "conflict"; attempt: ChecklistWrite; failure: OperatorReadFailure };
interface Flight { controller: AbortController; timer?: ReturnType<typeof setTimeout> }

export function useChecklistWrite(scope: Pick<ChecklistWrite, "orgId" | "showId" | "serviceDate">) {
  const key = JSON.stringify(scope);
  const currentKey = useRef(key); currentKey.current = key;
  const entry = useRef<WriteState>({ kind: "idle" });
  const flight = useRef<Flight | null>(null);
  const [state, setState] = useState<{ key: string; value: WriteState }>({ key, value: entry.current });
  const publish = (value: WriteState) => { entry.current = value; setState({ key: currentKey.current, value }); };
  useEffect(() => {
    publish({ kind: "idle" });
    return () => { clearTimeout(flight.current?.timer); flight.current?.controller.abort(); flight.current = null; };
  }, [key]);
  const run = useCallback(async (operation?: ChecklistOperation): Promise<{ attempt: ChecklistWrite; result: ChecklistWriteResult } | null> => {
    if (currentKey.current !== key || flight.current || entry.current.kind === "conflict") return null;
    const previous = entry.current;
    if (operation && previous.kind !== "idle") return null;
    const attempt = previous.kind === "idle"
      ? operation ? { ...scope, requestId: crypto.randomUUID(), operation: structuredClone(operation) } : null
      : previous.attempt;
    if (!attempt) return null;
    const current: Flight = { controller: new AbortController() }; flight.current = current;
    publish({ kind: "pending", attempt });
    try {
      const result = await Promise.race([
        mutateChecklist({ data: attempt, signal: current.controller.signal }),
        new Promise<never>((_, reject) => { current.timer = setTimeout(() => { reject(new Error("Confirmation timed out")); current.controller.abort(); }, 10_000); }),
      ]);
      if (flight.current !== current || currentKey.current !== key) return null;
      if (result.requestId !== attempt.requestId || (result.outcome !== "applied" && result.outcome !== "conflict")) throw new Error("Missing acknowledgement");
      publish(result.outcome === "applied" ? { kind: "idle" } : {
        kind: "conflict", attempt, failure: { message: "This checklist changed before your edit arrived. Your edit was not applied. Review the refreshed checklist before making another change.", occurredAt: Date.now() },
      });
      return { attempt, result };
    } catch {
      if (flight.current !== current || currentKey.current !== key) return null;
      publish({ kind: "uncertain", attempt, failure: { message: "Save was not confirmed. Your change is kept. Retry checks the same change without duplicating it or overwriting a later edit.", occurredAt: Date.now() } });
      return null;
    } finally { clearTimeout(current.timer); if (flight.current === current) flight.current = null; }
  }, [key, scope.orgId, scope.showId, scope.serviceDate]);
  const clearConflict = () => { if (entry.current.kind === "conflict") publish({ kind: "idle" }); };
  return { state: state.key === key ? state.value : { kind: "idle" } satisfies WriteState, run, clearConflict };
}
