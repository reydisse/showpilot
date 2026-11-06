import { useCallback, useEffect, useRef, useState } from "react";
import { mutateCueSheet } from "@/lib/cue-sheet";
import type { CueSheetOperation, CueSheetWrite, CueSheetWriteResult } from "@/lib/cue-sheet-writes";
import type { OperatorReadFailure } from "./useOperatorRead";

export interface CueWriteState { attempt: CueSheetWrite; pending: boolean; failure: OperatorReadFailure | null; conflict: CueSheetWriteResult | null }
interface Flight { controller: AbortController; timeout?: ReturnType<typeof setTimeout> }

/** Each cell has its own lane. Columns share one lane so order/resize/delete
 * cannot pass an unconfirmed change. Retried requests keep their captured body.
 */
export function useCueSheetWrites(orgId: string) {
  const scope = useRef(orgId); scope.current = orgId;
  const entries = useRef(new Map<string, CueWriteState>());
  const flights = useRef(new Map<string, Flight>());
  const [state, setState] = useState({ orgId, entries: new Map<string, CueWriteState>() });
  const publish = () => setState({ orgId: scope.current, entries: new Map(entries.current) });
  useEffect(() => {
    entries.current.clear(); publish();
    return () => {
      for (const flight of flights.current.values()) { clearTimeout(flight.timeout); flight.controller.abort(); }
      flights.current.clear();
    };
  }, [orgId]);
  const run = useCallback(async (key: string, operation?: CueSheetOperation) => {
    const old = entries.current.get(key);
    if (flights.current.has(key) || (operation && old) || old?.conflict) return null;
    const attempt = old?.attempt ?? (operation ? { orgId: scope.current, requestId: crypto.randomUUID(), operation: structuredClone(operation) } : null);
    if (!attempt || attempt.orgId !== scope.current) return null;
    const flight: Flight = { controller: new AbortController() };
    flights.current.set(key, flight);
    entries.current.set(key, { attempt, pending: true, failure: old?.failure ?? null, conflict: null }); publish();
    try {
      const result = await Promise.race([
        mutateCueSheet({ data: attempt, signal: flight.controller.signal }),
        new Promise<never>((_, reject) => { flight.timeout = setTimeout(() => { reject(new Error("Confirmation timed out")); flight.controller.abort(); }, 10_000); }),
      ]);
      if (flights.current.get(key) !== flight || scope.current !== attempt.orgId) return null;
      if (result.requestId !== attempt.requestId || !["applied", "conflict"].includes(result.outcome)) throw new Error("Missing write acknowledgement");
      if (result.outcome === "applied") entries.current.delete(key);
      else entries.current.set(key, { attempt, pending: false, conflict: result, failure: { message: "The sheet changed while this edit was being saved. Your edit was not applied. Refresh or review the saved sheet.", occurredAt: Date.now() } });
      publish();
      return { attempt, result };
    } catch {
      if (flights.current.get(key) !== flight || scope.current !== attempt.orgId) return null;
      entries.current.set(key, { attempt, pending: false, conflict: null, failure: { message: "Save was not confirmed. Your edits are kept. Retry checks the same change without duplicating or overwriting a newer save.", occurredAt: Date.now() } }); publish();
      return null;
    } finally {
      clearTimeout(flight.timeout);
      if (flights.current.get(key) === flight) flights.current.delete(key);
    }
  }, []);
  const clearConflict = useCallback((key: string, requestId: string) => {
    const entry = entries.current.get(key);
    if (!entry?.conflict || entry.attempt.requestId !== requestId || flights.current.has(key)) return false;
    entries.current.delete(key); publish(); return true;
  }, []);
  const has = useCallback((key: string) => entries.current.has(key), []);
  return { entries: state.orgId === orgId ? state.entries : new Map<string, CueWriteState>(), run, clearConflict, has };
}
