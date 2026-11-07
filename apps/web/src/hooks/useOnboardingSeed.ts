import { useEffect, useRef, useState } from "react";
import { getOnboardingSeed, seedOrgTemplate } from "@/lib/onboarding";
import { onboardingSeedSnapshotSchema, type OnboardingSeedSnapshot, type OnboardingSeedInput } from "@/lib/onboarding-seed-contract";
import type { OnboardingTemplateId } from "@/lib/templates";
import { getTodayDateString } from "@/lib/utils";

interface SeedFlight { controller: AbortController; timer?: ReturnType<typeof setTimeout> }

export function useOnboardingSeed(orgId: string | null) {
  const [snapshot, setSnapshot] = useState<OnboardingSeedSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; occurredAt: number } | null>(null);
  const [requested, setRequested] = useState<OnboardingSeedInput | null>(null);
  const pending = useRef<OnboardingSeedInput | null>(null);
  const flight = useRef<SeedFlight | null>(null);
  const currentOrg = useRef(orgId); currentOrg.current = orgId;
  const run = async (input: OnboardingSeedInput | null) => {
    if (!orgId || currentOrg.current !== orgId || flight.current) return;
    const request: SeedFlight = { controller: new AbortController() };
    const { controller } = request; flight.current = request;
    setBusy(true); setFailure(null);
    try {
      const result = await Promise.race([
        input ? seedOrgTemplate({ data: input, signal: controller.signal }) : getOnboardingSeed({ data: { orgId }, signal: controller.signal }),
        new Promise<never>((_, reject) => { request.timer = setTimeout(() => { controller.abort(); reject(new Error("Setup result timed out.")); }, 10_000); }),
      ]);
      if (flight.current !== request || controller.signal.aborted || currentOrg.current !== orgId) return;
      const next = onboardingSeedSnapshotSchema.parse(result);
      if (input && next.status === "empty") throw new Error("Missing seed acknowledgement.");
      setSnapshot(next);
    } catch {
      if (flight.current === request && currentOrg.current === orgId) setFailure({ occurredAt: Date.now(), message: input
        ? "Rundown creation was not confirmed. It may have finished. Check the saved result or retry; existing data will not be replaced."
        : "Could not check the saved rundown. Retry the check before choosing a template." });
    } finally {
      clearTimeout(request.timer);
      if (flight.current === request) { flight.current = null; setBusy(false); }
    }
  };
  const check = () => run(null);
  useEffect(() => {
    setSnapshot(null); setRequested(null); pending.current = null; setFailure(null); setBusy(false);
    if (orgId) void check();
    return () => { flight.current?.controller.abort(); clearTimeout(flight.current?.timer); flight.current = null; };
    // Reads follow organization identity. A refresh never starts a write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);
  const save = (template: OnboardingTemplateId) => {
    if (!orgId || currentOrg.current !== orgId || flight.current) return Promise.resolve();
    const input = { orgId, template, serviceDate: getTodayDateString() };
    pending.current = input; setRequested(input);
    return run(input);
  };
  return { snapshot, busy, failure, requested, check, save, retry: () => pending.current ? run(pending.current) : check() };
}
