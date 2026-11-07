import type { useOnboardingSeed } from "@/hooks/useOnboardingSeed";
import { getOnboardingTemplate } from "@/lib/templates";
const actionClass = "min-h-11 rounded-lg border border-white/20 px-4 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400 disabled:opacity-50";
export function SetupRundownResult({ seed, onDone }: { seed: ReturnType<typeof useOnboardingSeed>; onDone: () => void }) {
  const snapshot = seed.snapshot;
  const saved = snapshot?.status === "saved" ? snapshot : null;
  const different = saved && seed.requested && (saved.template !== seed.requested.template || saved.serviceDate !== seed.requested.serviceDate);
  return <section className="space-y-4 pt-8" aria-busy={seed.busy}>
    <h1 className="text-3xl font-bold">{saved ? saved.template === "blank" ? "Continue with your workspace" : "Your rundown is saved" : "Set up your first rundown"}</h1>
    {seed.busy && <p role="status" className="flex items-center gap-2 text-sm"><span aria-hidden="true" className="size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />Waiting for the saved result…</p>}
    {seed.failure && <div role="alert" className="space-y-2 rounded-xl border border-red-400/40 p-4 text-sm text-red-200">
      <p>{seed.failure.message}</p><p>Last attempt: {new Date(seed.failure.occurredAt).toLocaleTimeString()}</p>
    </div>}
    {snapshot?.status === "review" && <p role="alert" className="rounded-xl border border-amber-400/40 p-4 text-sm text-amber-200">{snapshot.message}</p>}
    {different && <p role="status" className="rounded-xl border border-amber-400/40 p-4 text-sm text-amber-200">Another setup choice was saved first. Your latest choice was not applied. The saved result is shown below.</p>}
    {saved && <>
      <p className="text-slate-300">{saved.template === "blank" ? saved.showId ? "Existing rundown kept. No template was added." : "No rundown was added. You can create one in your workspace later."
        : `${getOnboardingTemplate(saved.template)?.name} · ${saved.serviceDate}`}</p>
      {saved.items.length > 0 && <ol className="divide-y divide-white/15 rounded-xl border border-white/15">{saved.items.map(item => <li key={item.id} className="flex items-start justify-between gap-4 p-3">
        <span className="min-w-0 break-words">{item.title}</span><span className="shrink-0 font-mono text-sm text-slate-300">{Math.floor(item.duration / 60000)}:{String(Math.floor(item.duration / 1000) % 60).padStart(2, "0")}</span>
      </li>)}</ol>}
      <p className="text-sm text-slate-300">Creating a rundown does not start show transport or turn on outputs.</p>
    </>}
    <div className="flex flex-wrap gap-3">
      <button type="button" className={actionClass} disabled={seed.busy} onClick={() => void seed.check()}>Check saved rundown</button>
      {!saved && snapshot?.status !== "review" && seed.requested && <button type="button" className={actionClass} disabled={seed.busy} onClick={() => void seed.retry()}>Retry rundown creation</button>}
      {!saved && snapshot?.status !== "review" && <button type="button" className={actionClass} disabled={seed.busy} onClick={() => void seed.save("blank")}>Continue without adding a rundown</button>}
      {(saved || snapshot?.status === "review") && <button type="button" className={`${actionClass} bg-amber-400 text-black`} disabled={seed.busy} onClick={onDone}>{saved ? "Get your team in" : "Continue with existing data"}</button>}
    </div>
    {!saved && snapshot?.status !== "review" && <p className="text-sm text-slate-300">Continuing without a rundown adds no template. If an earlier request already saved one, it will be kept and shown for review.</p>}
  </section>;
}
