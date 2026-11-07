import { useEffect, useRef, useState } from "react";
import { getSetupChoices, saveSetupRole, saveSetupWorkspace } from "@/lib/setup-choices";
import { setupChoicesSnapshotSchema, setupChoiceConfirmed, setupWorkspaceSelectionSchema, type SetupChoicesSnapshot, type SetupChoiceCommand, type SetupWorkspaceSelection } from "@/lib/setup-choices-contract";
import type { OnboardingArchetype } from "@/lib/onboarding-flow";
interface Flight { controller: AbortController; timer?: ReturnType<typeof setTimeout> }
export function useSetupChoices(orgId: string | null) {
  const [snapshot, setSnapshot] = useState<SetupChoicesSnapshot | null>(null);
  const [pending, setPending] = useState<SetupChoiceCommand | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; occurredAt: number; step: "workspace" | "role" | null } | null>(null);
  const flight = useRef<Flight | null>(null);
  const currentOrg = useRef(orgId); currentOrg.current = orgId;
  const run = async (command: SetupChoiceCommand | null): Promise<boolean> => {
    if (!orgId || currentOrg.current !== orgId || flight.current) return false;
    const request: Flight = { controller: new AbortController() }; flight.current = request;
    setBusy(true); setFailure(null);
    try {
      const signal = request.controller.signal;
      const result = await Promise.race([
        command?.kind === "workspace" ? saveSetupWorkspace({ data: command, signal })
          : command?.kind === "role" ? saveSetupRole({ data: command, signal }) : getSetupChoices({ data: { orgId }, signal }),
        new Promise<never>((_, reject) => { request.timer = setTimeout(() => { request.controller.abort(); reject(new Error("Setup choice timed out.")); }, 10_000); }),
      ]);
      if (flight.current !== request || signal.aborted || currentOrg.current !== orgId) return false;
      const next = setupChoicesSnapshotSchema.parse(result); setSnapshot(next);
      if (command && !setupChoiceConfirmed(next, command)) {
        const actualRevision = command.kind === "workspace" ? next.workspaceRevision : next.roleValue;
        if (actualRevision === command.expectedRevision) throw new Error("Missing save acknowledgement.");
        setFailure({ step: command.kind, occurredAt: Date.now(), message: "Saved choices changed while this request was waiting. Your draft was not applied. Review the saved choice below, then select again if you want to replace it." });
        return false;
      }
      return true;
    } catch {
      if (flight.current === request && currentOrg.current === orgId) setFailure({ step: command?.kind ?? null, occurredAt: Date.now(), message: command
        ? "This choice was not confirmed. It may have saved. Check the saved choices or retry the same request; newer choices will not be overwritten."
        : "Could not read your saved choices. Check again before continuing." });
      return false;
    } finally {
      clearTimeout(request.timer);
      if (flight.current === request) { flight.current = null; setBusy(false); }
    }
  };
  const check = () => run(null);
  useEffect(() => {
    setSnapshot(null); setPending(null); setFailure(null); setBusy(false);
    if (orgId) void check();
    return () => { flight.current?.controller.abort(); clearTimeout(flight.current?.timer); flight.current = null; };
    // Scope changes read fresh state and never replay a choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);
  const workspace = (selection: SetupWorkspaceSelection) => {
    if (!orgId || currentOrg.current !== orgId || !snapshot || flight.current) return Promise.resolve(false);
    const parsed = setupWorkspaceSelectionSchema.safeParse(selection);
    if (!parsed.success) {
      setFailure({ step: "workspace", occurredAt: Date.now(), message: parsed.error.issues[0]?.message ?? "Check your workspace names and modules." });
      return Promise.resolve(false);
    }
    const command: SetupChoiceCommand = { kind: "workspace", orgId, requestId: crypto.randomUUID(), expectedRevision: snapshot.workspaceRevision, selection: parsed.data };
    setPending(command); return run(command);
  };
  const role = (archetype: OnboardingArchetype) => {
    if (!orgId || currentOrg.current !== orgId || !snapshot || flight.current) return Promise.resolve(false);
    const command: SetupChoiceCommand = { kind: "role", orgId, requestId: crypto.randomUUID(), expectedRevision: snapshot.roleValue, archetype };
    setPending(command); return run(command);
  };
  return { snapshot, pending, busy, failure, check, workspace, role, retry: () => run(pending) };
}
