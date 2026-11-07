import { useEffect, useRef, useState } from "react";
import { getSetupTeam, saveSetupTeam, sendSetupInvitation, finishSetupTeam } from "@/lib/setup-save";
import { setupSnapshotSchema, type SetupSnapshot, type SetupTeamInput } from "@/lib/setup-save-contract";
type Team = Pick<SetupTeamInput, "crew" | "invites">;
interface Flight { controller: AbortController }
export function useSetupTeamSave(orgId: string, onFinished: () => void) {
  const [snapshot, setSnapshot] = useState<SetupSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; occurredAt: number } | null>(null);
  const [frozen, setFrozen] = useState(false);
  const flight = useRef<Flight | null>(null);
  const pending = useRef<SetupTeamInput | null>(null);
  const currentOrg = useRef(orgId); currentOrg.current = orgId;
  const finished = useRef(onFinished); finished.current = onFinished;
  const run = async (action: (call: <T>(fn: (signal: AbortSignal) => Promise<T>) => Promise<T>) => Promise<void>, message: string) => {
    if (flight.current || currentOrg.current !== orgId) return;
    const request = { controller: new AbortController() }; flight.current = request;
    setBusy(true); setFailure(null);
    const call = async <T,>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      if (flight.current !== request || request.controller.signal.aborted) throw new Error("Setup request canceled.");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const value = await Promise.race([fn(request.controller.signal), new Promise<never>((_, reject) => {
          timer = setTimeout(() => { request.controller.abort(); reject(new Error("Setup confirmation timed out.")); }, 10_000);
        })]);
        if (flight.current !== request || request.controller.signal.aborted) throw new Error("Setup request canceled.");
        return value;
      } finally { clearTimeout(timer); }
    };
    try { await action(call); }
    catch { if (flight.current === request) setFailure({ message, occurredAt: Date.now() }); }
    finally { if (flight.current === request) { flight.current = null; setBusy(false); } }
  };
  const check = () => run(async call => {
    const next = await call(signal => getSetupTeam({ data: { orgId }, signal }));
    setSnapshot(setupSnapshotSchema.parse(next));
    if (next.completed) finished.current();
  }, "Could not confirm the saved setup. Check again before sending anything else.");
  useEffect(() => {
    setSnapshot(null); setFrozen(false); pending.current = null;
    void check();
    return () => { flight.current?.controller.abort(); flight.current = null; };
    // One scoped read on mount. Writes and result checks are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);
  const finish = (allowUnconfirmed = false) => run(async call => {
    const batch = snapshot?.batch;
    if (!batch) return;
    const result = await call(signal => finishSetupTeam({ data: { orgId, batchId: batch.batchId, allowUnconfirmed }, signal }));
    if (!result.ok || result.batchId !== batch.batchId) throw new Error("Missing completion acknowledgement.");
    finished.current();
  }, "Setup completion was not confirmed. Check saved results or retry finishing; saved people will not be added again.");
  const save = (team?: Team) => run(async call => {
    if (!pending.current) {
      if (!team) return;
      pending.current = { ...structuredClone(team), orgId, batchId: crypto.randomUUID() };
    }
    setFrozen(true);
    const attempt = pending.current;
    let next = await call(signal => saveSetupTeam({ data: attempt, signal }));
    setSnapshot(setupSnapshotSchema.parse(next));
    if (!next.batch) throw new Error("Missing saved team acknowledgement.");
    if (next.batch.batchId !== attempt.batchId) {
      setFailure({ message: "Another setup request saved a team first. Your draft was not applied. Review the actual saved team below.", occurredAt: Date.now() });
      return;
    }
    for (const index of next.batch.invites.keys()) {
      if (next.invitations[index]) continue;
      next = await call(signal => sendSetupInvitation({ data: { orgId, batchId: attempt.batchId, index, attemptId: crypto.randomUUID(), previousAttemptId: null }, signal }));
      if (next.batch?.batchId !== attempt.batchId) throw new Error("Setup invitation acknowledgement changed scope.");
      setSnapshot(setupSnapshotSchema.parse(next));
    }
    if (next.invitations.every(job => job?.state === "accepted")) {
      const result = await call(signal => finishSetupTeam({ data: { orgId, batchId: attempt.batchId, allowUnconfirmed: false }, signal }));
      if (!result.ok || result.batchId !== attempt.batchId) throw new Error("Missing completion acknowledgement.");
      finished.current();
    }
  }, "Some setup work was not confirmed. Your entered team is preserved. Check saved results before retrying.");
  const send = (index: number) => run(async call => {
    const batch = snapshot?.batch;
    if (!batch) return;
    const job = snapshot.invitations[index];
    const next = await call(signal => sendSetupInvitation({ data: {
      orgId, batchId: batch.batchId, index, attemptId: crypto.randomUUID(), previousAttemptId: job?.attemptId ?? null,
    }, signal }));
    if (next.batch?.batchId !== batch.batchId) throw new Error("Setup invitation acknowledgement changed scope.");
    setSnapshot(setupSnapshotSchema.parse(next));
  }, "Invitation delivery was not confirmed. Check saved results. Existing crew and accepted invitations will not be sent again.");
  return { snapshot, busy, failure, frozen, check, save, finish, send };
}
