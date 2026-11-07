import { useCallback } from "react";
import { Link } from "@tanstack/react-router";
import { getOnboardingProgress } from "@/lib/onboarding";
import { useOperatorRead } from "@/hooks/useOperatorRead";

export function ResumeSetup({ orgId }: { orgId: string }) {
  const read = useCallback(async (signal: AbortSignal) => {
    const progress = await getOnboardingProgress({ data: { mode: "resume", orgId }, signal });
    if (!progress.authenticated || progress.org?.id !== orgId) throw new Error("Setup access could not be confirmed.");
    return progress;
  }, [orgId]);
  const state = useOperatorRead<Awaited<ReturnType<typeof getOnboardingProgress>> | null>({
    key: orgId, initialValue: null, read, errorMessage: "Could not check setup progress. Try again.",
  });
  if (state.error) return <div role="alert" className="space-y-2 text-sm text-red-400">
    <p>{state.error.message} Last attempt: {new Date(state.error.occurredAt).toLocaleTimeString()}</p>
    <button type="button" className="min-h-11 rounded-lg border border-board-border px-4 py-2" disabled={state.refreshing} onClick={state.retry}>Check setup progress</button>
  </div>;
  if (state.confirmedAt === null) return <p role="status" className="text-sm text-board-muted">Checking setup progress…</p>;
  if (!state.value?.isOwner || !state.value.started || state.value.completed) return null;
  return <section className="space-y-2 rounded-xl border border-board-border p-4">
    <h2 className="font-semibold">Finish setting up your workspace</h2>
    <p className="text-sm text-board-muted">Resume from your saved choices. Existing people and rundowns are kept.</p>
    <Link to="/setup" search={{ orgId }} className="inline-flex min-h-11 items-center rounded-lg border border-board-border px-4 py-2 text-sm focus-visible:outline-2">Resume setup</Link>
  </section>;
}
