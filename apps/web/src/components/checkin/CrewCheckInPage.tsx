import { useCallback, useRef, useState } from "react";
import { Link, useBlocker } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { getCheckInMembers } from "@/lib/crew-attendance";
import type { CrewAttendanceMember, CrewAttendanceOperation } from "@/lib/crew-attendance-writes";
import { useOperatorRead } from "@/hooks/useOperatorRead";
import { useCrewAttendanceWrite } from "@/hooks/useCrewAttendanceWrite";
import { ReadFailureNotice } from "@/components/layout/ReadFailureNotice";
import { ConfirmDialog, useConfirmDialog } from "@/components/ui/confirm-dialog";
import { CheckInList } from "./CheckInList";
const actionClass = "min-h-11 rounded-xl border border-board-border px-4 py-3 text-sm font-medium disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fire-500";
export function CrewCheckInPage({ orgId, slug, initialMembers }: { orgId: string; slug: string; initialMembers: CrewAttendanceMember[] }) {
  const [needsRead, setNeedsRead] = useState(false);
  const read = useCallback(async (signal: AbortSignal) => {
    const members = await getCheckInMembers({ data: { orgId }, signal });
    if (!signal.aborted) setNeedsRead(false);
    return members;
  }, [orgId]);
  const crew = useOperatorRead({ key: orgId, initialValue: initialMembers, read, intervalMs: 15_000,
    errorMessage: "Could not refresh crew attendance. Shown attendance is the last confirmed state. Retry the read before changing attendance." });
  const writes = useCrewAttendanceWrite(orgId);
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  const [mode, setMode] = useState<"entry" | "list">("entry");
  const [code, setCode] = useState("");
  const [lookupError, setLookupError] = useState("");
  const [selected, setSelected] = useState<CrewAttendanceMember | null>(null);
  const [completedId, setCompletedId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const finishing = useRef(false);
  const uncertain = writes.state.kind === "pending" || writes.state.kind === "uncertain";
  const blocker = useBlocker({ shouldBlockFn: () => uncertain, enableBeforeUnload: uncertain, withResolver: true });
  const blocked = writes.state.kind !== "idle" || needsRead || Boolean(crew.error);
  async function refreshAfterWrite() {
    const confirmed = await crew.refresh();
    if (confirmed) setNeedsRead(false);
  }
  async function change(operation?: CrewAttendanceOperation) {
    if (finishing.current || (operation && blocked)) return;
    finishing.current = true;
    setNotice("");
    try {
      const confirmed = await writes.run(operation);
      if (!confirmed) return;
      setNeedsRead(true);
      if (confirmed.result.outcome === "applied") {
        setNotice(`Attendance change saved. ${confirmed.result.changedCount} crew ${confirmed.result.changedCount === 1 ? "record" : "records"} changed.`);
        setCompletedId(confirmed.attempt.members.length === 1 ? confirmed.attempt.members[0].id : null);
        setSelected(null); setCode(""); setLookupError("");
      }
      // Cancel any pre-write list response; refreshing only reads, never resends.
      crew.invalidate();
      await refreshAfterWrite();
    } finally { finishing.current = false; }
  }
  function single(member: CrewAttendanceMember) {
    void change({ isOnline: !member.isOnline, members: [{ id: member.id, expectedRevision: member.revision }] });
  }
  async function all(isOnline: boolean) {
    if (blocked || crew.value.length === 0) return;
    const operation = { isOnline, members: crew.value.map(member => ({ id: member.id, expectedRevision: member.revision })) };
    if (await confirm({ title: `Check all ${operation.members.length} crew ${isOnline ? "in" : "out"}?`, description: `This changes the ${operation.members.length} crew in the current roster, including people outside your search. If any attendance changes before confirmation, nothing will be applied.`, confirmLabel: isOnline ? "Check crew in" : "Check crew out", variant: "warning" })) void change(operation);
  }
  const failure = writes.state.kind === "uncertain" || writes.state.kind === "conflict" ? writes.state.failure : null;
  const selectedStale = selected !== null && crew.value.find(member => member.id === selected.id)?.revision !== selected.revision;
  const completed = completedId ? crew.value.find(member => member.id === completedId) : null;
  return <div className="h-full overflow-auto text-board-text">
    <header className="sticky top-0 z-10 border-b border-board-border bg-board-bg/95 px-4 py-4"><div className="mx-auto flex max-w-3xl flex-wrap items-center gap-3">
      <Link to="/$slug/show" params={{ slug }} aria-label="Back to Show Flow" className={`${actionClass} flex items-center gap-2`}><ArrowLeft className="size-4" /><span className="hidden sm:inline">Show Flow</span></Link>
      <h1 className="min-w-36 flex-1 text-lg font-semibold">Crew check-in</h1>
      <button className={`${actionClass} ml-auto shrink-0`} onClick={() => setMode(mode === "entry" ? "list" : "entry")}>{mode === "entry" ? "Browse crew" : "Enter member ID"}</button>
    </div></header>
    <main className="mx-auto max-w-3xl space-y-4 px-4 py-5">
      {notice && <p role="status" className="rounded-xl border border-green-400/25 bg-green-500/5 p-3 text-sm text-green-300">{notice}{needsRead && " Latest attendance has not yet been confirmed."}</p>}
      <ReadFailureNotice error={crew.error} refreshing={crew.refreshing} retry={() => void refreshAfterWrite()} label="Retry crew list" />
      {writes.state.kind === "pending" && <p role="status">Confirming attendance…</p>}
      {failure && <section role="alert" className="space-y-3 rounded-xl border border-amber-400/30 bg-amber-500/5 p-4">
        <p className="break-words">{failure.message}</p><p className="text-xs text-board-muted">Last error <time dateTime={new Date(failure.occurredAt).toISOString()}>{new Date(failure.occurredAt).toLocaleTimeString()}</time></p>
        {writes.state.kind === "uncertain" ? <button className={actionClass} onClick={() => void change()}>Retry attendance</button> : <button className={actionClass} disabled={needsRead || Boolean(crew.error) || crew.refreshing} onClick={() => { writes.clearConflict(); setSelected(null); setCompletedId(null); }}>Review updated crew</button>}
      </section>}
      {mode === "list" ? <CheckInList members={crew.value} blocked={blocked} refreshing={crew.refreshing} onChange={single} onSetAll={value => void all(value)} /> : <div className="max-w-lg space-y-4">
        {completedId && !needsRead && !crew.error ? <section className="space-y-3 rounded-xl border border-board-border bg-board-card p-4">
          <h2 className="text-lg font-medium">Latest attendance</h2>
          <p className="break-words">{completed ? `${completed.name}: ${completed.isOnline ? "checked in" : "checked out"}` : "This crew member is no longer in the roster."}</p>
          {completed?.isOnline && <div className="flex flex-wrap gap-2"><Link to="/$slug/crew-chat" params={{ slug }} search={{ name: completed.name }} className={actionClass}>Join Production Chat</Link><Link to="/$slug/rundown" params={{ slug }} className={actionClass}>View Rundown</Link></div>}
          <button className={actionClass} onClick={() => { setCompletedId(null); setNotice(""); }}>Done</button>
        </section> : selected ? <section className="space-y-3 rounded-xl border border-board-border bg-board-card p-4">
          <h2 className="break-words text-lg font-medium">{selected.name}</h2><p className="text-sm text-board-muted">{selected.role} · Selected status: {selected.isOnline ? "Checked in" : "Checked out"}</p>
          <p className="text-sm text-amber-300">{selectedStale ? "Attendance changed since you selected this person. Find them again before making a change." : ""}</p>
          <button disabled={blocked || selectedStale} className={`${actionClass} bg-fire-500 text-white`} onClick={() => single(selected)}>Check {selected.name} {selected.isOnline ? "out" : "in"}</button>
          <button disabled={uncertain} className={`${actionClass} ml-2`} onClick={() => setSelected(null)}>Use another ID</button>
        </section> : <form className="space-y-3" onSubmit={event => {
          event.preventDefault(); if (blocked) return;
          const member = crew.value.find(member => member.memberId.toUpperCase() === code.trim().toUpperCase());
          if (member) { setSelected(member); setLookupError(""); setCompletedId(null); }
          else setLookupError("Member not found in the confirmed roster. Check the ID or refresh the crew list.");
        }}>
          <label htmlFor="crew-member-id" className="block text-sm font-medium">Member ID</label>
          <input id="crew-member-id" value={code} onChange={event => setCode(event.target.value.toUpperCase())} maxLength={64} autoComplete="off" disabled={uncertain} className="min-h-11 w-full rounded-xl border border-board-border bg-board-card px-4 py-3 font-mono focus-visible:outline-fire-500" placeholder="e.g. TD3917" />
          <button disabled={blocked || !code.trim()} className={`${actionClass} bg-fire-500 text-white`}>Find crew member</button>
          {lookupError && <div role="alert" className="space-y-2 text-sm text-amber-300"><p>{lookupError}</p><button type="button" className={actionClass} disabled={crew.refreshing} onClick={() => void refreshAfterWrite()}>Refresh crew list</button></div>}
        </form>}
      </div>}
    </main>
    {ConfirmDialogEl}
    <ConfirmDialog open={blocker.status === "blocked"} onOpenChange={open => { if (!open) blocker.reset?.(); }} onConfirm={() => blocker.proceed?.()} title="Leave crew check-in?" description="The attendance change may still complete. Leaving removes this retry. Return and refresh attendance before choosing another action." confirmLabel="Leave" cancelLabel="Stay" variant="warning" />
  </div>;
}
