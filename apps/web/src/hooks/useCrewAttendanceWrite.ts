import { useCallback, useEffect, useRef, useState } from "react";
import { changeCrewAttendance } from "@/lib/crew-attendance";
import type { CrewAttendanceOperation, CrewAttendanceWrite } from "@/lib/crew-attendance-writes";
import type { OperatorReadFailure } from "./useOperatorRead";
type State = { kind: "idle" } | { kind: "pending"; attempt: CrewAttendanceWrite }
  | { kind: "uncertain" | "conflict"; attempt: CrewAttendanceWrite; failure: OperatorReadFailure };
interface Flight { controller: AbortController; timer?: ReturnType<typeof setTimeout> }
export function useCrewAttendanceWrite(orgId: string) {
  const currentOrg = useRef(orgId); currentOrg.current = orgId;
  const entry = useRef<State>({ kind: "idle" });
  const flight = useRef<Flight | null>(null);
  const [view, setView] = useState({ orgId, state: entry.current });
  const publish = (state: State) => { entry.current = state; setView({ orgId: currentOrg.current, state }); };
  useEffect(() => {
    publish({ kind: "idle" });
    return () => { clearTimeout(flight.current?.timer); flight.current?.controller.abort(); flight.current = null; };
  }, [orgId]);
  const run = useCallback(async (operation?: CrewAttendanceOperation) => {
    if (currentOrg.current !== orgId || flight.current || entry.current.kind === "conflict") return null;
    const previous = entry.current;
    if (operation && previous.kind !== "idle") return null;
    const attempt = previous.kind === "idle"
      ? operation ? { ...structuredClone(operation), orgId, requestId: crypto.randomUUID() } : null : previous.attempt;
    if (!attempt) return null;
    const current: Flight = { controller: new AbortController() }; flight.current = current;
    publish({ kind: "pending", attempt });
    try {
      const result = await Promise.race([
        changeCrewAttendance({ data: attempt, signal: current.controller.signal }),
        new Promise<never>((_, reject) => { current.timer = setTimeout(() => { reject(new Error("Attendance confirmation timed out.")); current.controller.abort(); }, 10_000); }),
      ]);
      if (flight.current !== current || currentOrg.current !== orgId) return null;
      if (result.requestId !== attempt.requestId || (result.outcome !== "applied" && result.outcome !== "conflict") || !Number.isInteger(result.changedCount)) throw new Error("Missing attendance acknowledgement.");
      publish(result.outcome === "applied" ? { kind: "idle" } : { kind: "conflict", attempt,
        failure: { message: "Crew attendance changed before your request arrived. No part of this change was applied. Review the refreshed crew before choosing another action.", occurredAt: Date.now() } });
      return { attempt, result };
    } catch (error) {
      if (flight.current !== current || currentOrg.current !== orgId) return null;
      const reason = error instanceof Error ? error.message : "Connection failed.";
      publish({ kind: "uncertain", attempt, failure: { message: `${reason} Attendance was not confirmed. Retry checks the same request without repeating a completed change.`, occurredAt: Date.now() } });
      return null;
    } finally { clearTimeout(current.timer); if (flight.current === current) flight.current = null; }
  }, [orgId]);
  const clearConflict = () => { if (entry.current.kind === "conflict") publish({ kind: "idle" }); };
  return { state: view.orgId === orgId ? view.state : { kind: "idle" } satisfies State, run, clearConflict };
}
