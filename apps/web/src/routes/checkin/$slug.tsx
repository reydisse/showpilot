import { createFileRoute, useBlocker } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, KeyRound, LoaderCircle } from "lucide-react";
import { BoardSkeleton } from "@/components/ui/Skeleton";
import { ConfirmDialog, useConfirmDialog } from "@/components/ui/confirm-dialog";
import { getPublicCheckInOrg, publicCheckInByMemberId, getPublicCrewMemberByMemberId } from "@/lib/data";
import { publicCheckInOrgSchema, type PublicAttendanceResult, type PublicAttendanceWrite, type PublicCrewMember } from "@/lib/public-checkin";

export const Route = createFileRoute("/checkin/$slug")({
  pendingComponent: () => <BoardSkeleton />,
  loader: async ({ params, abortController }) => {
    if (!publicCheckInOrgSchema.safeParse({ slug: params.slug }).success) return { slug: params.slug, orgName: null };
    const org = await getPublicCheckInOrg({ data: { slug: params.slug }, signal: abortController.signal });
    return { slug: params.slug, orgName: org?.name ?? null };
  },
  component: PublicCheckInPage,
});
function PublicCheckInPage() {
  const { slug, orgName } = Route.useLoaderData();
  return orgName === null ? <main className="min-h-screen bg-board-bg p-6 text-board-text">
    <div className="mx-auto max-w-lg space-y-4"><h1 className="text-xl font-semibold">Organization not found</h1>
      <p>Check the check-in link or ask your team for the correct QR code.</p>
      <a href="/" className="inline-flex min-h-11 items-center underline">Go to ShowPilot</a></div>
  </main> : <CheckInKiosk key={slug} slug={slug} orgName={orgName} />;
}

type Failure = { message: string; occurredAt: number };
type State =
  | { kind: "entry" }
  | { kind: "lookup"; memberId: string }
  | { kind: "lookup-error"; memberId: string; failure: Failure }
  | { kind: "confirm"; member: PublicCrewMember }
  | { kind: "write"; attempt: PublicAttendanceWrite }
  | { kind: "write-error"; attempt: PublicAttendanceWrite; failure: Failure }
  | { kind: "done"; attempt: PublicAttendanceWrite; result: PublicAttendanceResult };
interface Flight { controller: AbortController; timer?: ReturnType<typeof setTimeout> }
const buttonClass = "min-h-11 rounded-xl border border-board-border px-4 py-3 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fire-500 disabled:opacity-50";

export function CheckInKiosk({ slug, orgName }: { slug: string; orgName: string }) {
  const [code, setCode] = useState("");
  const [state, setState] = useState<State>({ kind: "entry" });
  const flight = useRef<Flight | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  const uncertain = state.kind === "write" || state.kind === "write-error";
  const blocker = useBlocker({ shouldBlockFn: () => uncertain, enableBeforeUnload: uncertain, withResolver: true });
  const cancel = () => { clearTimeout(flight.current?.timer); flight.current?.controller.abort(); flight.current = null; };
  const reset = () => { cancel(); setCode(""); setState({ kind: "entry" }); };
  useEffect(() => {
    // Legacy IDs are hints, never identity proof. Do not read or restore them.
    try { localStorage.removeItem(`showpilot-checkin:${slug}:memberId`); } catch { /* Storage is optional; no identity is restored. */ }
    return cancel;
  }, [slug]);
  useEffect(() => { if (state.kind === "entry") input.current?.focus(); }, [state.kind]);
  useEffect(() => {
    // A shared station should not retain a completed or abandoned identity.
    // Failures stay visible until the user chooses Retry or Start over.
    if (state.kind !== "confirm" && state.kind !== "done") return;
    const timer = setTimeout(reset, state.kind === "done" ? 15_000 : 60_000);
    return () => clearTimeout(timer);
  }, [state]);

  async function run<T>(operation: (signal: AbortSignal) => Promise<T>, success: (result: T) => void, failure: (error: Failure) => void) {
    if (flight.current) return;
    const current: Flight = { controller: new AbortController() }; flight.current = current;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => { current.controller.signal.throwIfAborted(); return operation(current.controller.signal); }),
        new Promise<never>((_, reject) => { current.timer = setTimeout(() => { reject(new Error("Confirmation timed out. Check the connection and retry.")); current.controller.abort(); }, 10_000); }),
      ]);
      if (flight.current === current) success(result);
    } catch (error) {
      if (flight.current === current) failure({ message: error instanceof Error ? error.message : "Unable to confirm attendance. Please retry.", occurredAt: Date.now() });
    } finally { clearTimeout(current.timer); if (flight.current === current) flight.current = null; }
  }
  function lookup(memberId: string) {
    if (flight.current) return;
    setState({ kind: "lookup", memberId });
    void run(signal => getPublicCrewMemberByMemberId({ data: { slug, memberId }, signal }), member => {
      if (member) setState({ kind: "confirm", member });
      else setState({ kind: "lookup-error", memberId, failure: { message: "Member not found. Check your ID or ask your team.", occurredAt: Date.now() } });
    }, failure => setState({ kind: "lookup-error", memberId, failure }));
  }
  function write(attempt: PublicAttendanceWrite) {
    if (flight.current) return;
    setState({ kind: "write", attempt });
    void run(async signal => {
      const result = await publicCheckInByMemberId({ data: attempt, signal });
      if (result.requestId !== attempt.requestId || (result.outcome !== "applied" && result.outcome !== "conflict")) throw new Error("Attendance was not confirmed. Retry the same change.");
      return result;
    }, result => setState({ kind: "done", attempt, result }), failure => setState({ kind: "write-error", attempt, failure }));
  }
  async function startOver() {
    if (uncertain && !await confirm({ title: "Start over?", description: "The attendance change may still complete. Starting over removes this retry. Enter your ID again to check the latest attendance.", confirmLabel: "Start over", variant: "warning" })) return;
    reset();
  }
  const failure = state.kind === "lookup-error" || state.kind === "write-error" ? state.failure : null;
  const completed = state.kind === "done" && state.result.outcome === "applied" && state.result.member !== null
    && state.result.member.isOnline === (state.attempt.intent === "check-in");
  return <div className="min-h-screen bg-board-bg text-board-text">
    <header className="border-b border-board-border px-5 py-4"><div className="mx-auto max-w-lg">
      <h1 className="text-lg font-bold text-fire-500">Crew check-in</h1><p className="mt-1 break-words text-sm text-board-muted">{orgName}</p>
    </div></header>
    <main className="mx-auto max-w-lg space-y-5 px-5 py-8">
      {state.kind === "entry" && <form className="space-y-4" onSubmit={event => { event.preventDefault(); const memberId = code.trim().toUpperCase(); if (memberId) lookup(memberId); }}>
        <KeyRound className="size-10 text-fire-500" aria-hidden="true" />
        <p>Enter your member ID, then confirm your name and attendance.</p>
        <label htmlFor="member-id" className="block text-sm font-medium">Member ID</label>
        <input ref={input} id="member-id" value={code} onChange={event => setCode(event.target.value.toUpperCase())} maxLength={64} autoComplete="off" autoCapitalize="characters" spellCheck={false}
          className="min-h-12 w-full rounded-xl border border-board-border bg-board-card px-4 py-3 font-mono text-lg focus-visible:outline-fire-500" placeholder="e.g. TD3917" />
        <button type="submit" disabled={!code.trim()} className={`${buttonClass} w-full bg-fire-500 text-white`}>Find my name</button>
        <p className="text-xs text-board-muted">Shared station: your identity is cleared when you finish. Enter your own ID each time.</p>
      </form>}
      {(state.kind === "lookup" || state.kind === "write") && <p role="status" className="flex items-center gap-3"><LoaderCircle className="size-5 animate-spin" aria-hidden="true" />{state.kind === "lookup" ? "Finding your name…" : "Confirming attendance…"}</p>}
      {state.kind === "lookup" && <button className={buttonClass} onClick={reset}>Cancel lookup</button>}
      {state.kind === "confirm" && <section aria-label="Confirm your identity" className="space-y-4 rounded-2xl border border-board-border bg-board-card p-5">
        {state.member.photoUrl && <img src={state.member.photoUrl} alt="" className="size-20 rounded-full object-cover" />}
        <h2 className="break-words text-xl font-semibold">Is this you, {state.member.name}?</h2>
        <p className="break-words text-board-muted">{state.member.role}</p>
        <p>{state.member.isOnline ? "You are currently checked in." : "You are currently checked out."}</p>
        <button className={`${buttonClass} w-full bg-fire-500 text-white`} onClick={() => write({ slug, memberId: state.member.memberId, intent: state.member.isOnline ? "check-out" : "check-in", expectedRevision: state.member.revision, requestId: crypto.randomUUID() })}>
          {state.member.isOnline ? "Yes, check me out" : "Yes, check me in"}
        </button>
        <button className={`${buttonClass} w-full`} onClick={reset}>Not me · use another ID</button>
      </section>}
      {failure && <section role="alert" className="space-y-4 rounded-xl border border-red-400/30 bg-red-500/5 p-4">
        <h2 className="text-lg font-medium">{state.kind === "write-error" ? "Attendance not confirmed" : "Could not find your name"}</h2>
        <p className="break-words">{failure.message}</p>
        {state.kind === "write-error" && <p className="text-sm text-board-muted">The change may have arrived. Retry checks the same request without changing a later attendance update.</p>}
        <p className="text-xs text-board-muted">Last error <time dateTime={new Date(failure.occurredAt).toISOString()}>{new Date(failure.occurredAt).toLocaleTimeString()}</time></p>
        <button className={buttonClass} onClick={() => { if (state.kind === "lookup-error") lookup(state.memberId); else if (state.kind === "write-error") write(state.attempt); }}>{state.kind === "write-error" ? "Retry attendance" : "Retry lookup"}</button>
        <button className={`${buttonClass} ml-2`} onClick={() => void startOver()}>Start over</button>
      </section>}
      {state.kind === "done" && <section role="status" className="space-y-4">
        {completed && <CheckCircle2 aria-hidden="true" className="size-12 text-green-400" />}
        <h2 className="text-xl font-semibold">{completed ? state.attempt.intent === "check-in" ? "Checked in" : "Checked out" : "Attendance changed"}</h2>
        {completed ? <p className="break-words">{state.result.member?.name}</p> : <p>{state.result.outcome === "conflict" ? "Your change was not applied because attendance changed after you looked it up." : "Your earlier change was recorded, and attendance has since changed."} Enter your ID again to review the latest state.</p>}
        <button className={`${buttonClass} w-full`} onClick={reset}>Done</button>
        <p className="text-xs text-board-muted">This screen clears automatically after 15 seconds.</p>
      </section>}
    </main>
    {ConfirmDialogEl}
    <ConfirmDialog open={blocker.status === "blocked"} onOpenChange={open => { if (!open) blocker.reset?.(); }} onConfirm={() => blocker.proceed?.()}
      title="Leave check-in?" description="The attendance change may still complete. Leaving removes this retry. Enter your ID again when you return to check the latest attendance." confirmLabel="Leave" cancelLabel="Stay" variant="warning" />
  </div>;
}
