import { WORKSPACE_DEFINITIONS, resolveWorkspaceProfile } from "@showpilot/shared";
import type { useSetupChoices } from "@/hooks/useSetupChoices";
import { parseSetupRole, setupChoiceConfirmed } from "@/lib/setup-choices-contract";
import { archetypesForWorkspace } from "@/lib/workspace/archetypes";
const actionClass = "min-h-11 rounded-lg border border-white/20 px-4 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400 disabled:opacity-50";
export function SetupChoiceStatus({ choices, step, onContinue }: { choices: ReturnType<typeof useSetupChoices>; step: "workspace" | "role"; onContinue: () => void }) {
  const { snapshot, pending, busy, failure } = choices;
  const workspace = snapshot ? resolveWorkspaceProfile(snapshot.settings) : null;
  const role = snapshot ? parseSetupRole(snapshot.roleValue) : null;
  const hasSaved = step === "workspace" ? workspace?.isExplicit : Boolean(role);
  const awaiting = pending?.kind === step && (!snapshot || !setupChoiceConfirmed(snapshot, pending));
  const error = failure && (failure.step === null || failure.step === step) ? failure : null;
  return <div className="space-y-3" aria-busy={busy}>
    {busy && <p role="status" className="flex items-center gap-2 text-sm"><span aria-hidden="true" className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />Confirming saved choices…</p>}
    {error && <div role="alert" className="space-y-2 rounded-xl border border-red-400/40 p-4 text-sm text-red-200"><p>{error.message}</p><p>Last attempt: {new Date(error.occurredAt).toLocaleTimeString()}</p></div>}
    {hasSaved && workspace && <p className="text-sm text-slate-300">Saved {step}: {step === "workspace" ? WORKSPACE_DEFINITIONS[workspace.type].label : archetypesForWorkspace(workspace.type).find(item => item.id === role?.archetype)?.label}.</p>}
    {awaiting && !busy && !error && <p role="status" className="text-sm text-amber-200">Your latest choice is not confirmed. Your draft is kept. Retry it or select again after reviewing the saved choice.</p>}
    <div className="flex flex-wrap gap-3">
      <button type="button" className={actionClass} disabled={busy} onClick={() => void choices.check()}>Check saved choices</button>
      {awaiting && <button type="button" className={actionClass} disabled={busy} onClick={async () => { if (await choices.retry()) onContinue(); }}>Retry saving {step}</button>}
      {hasSaved && !awaiting && !error && <button type="button" className={`${actionClass} bg-amber-400 text-black`} disabled={busy} onClick={onContinue}>Continue with saved {step}</button>}
    </div>
  </div>;
}
