import { useCallback, useSyncExternalStore } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import {
  dismissRundownHandoff,
  readRundownHandoffs,
  subscribeRundownHandoffs,
  type RundownHandoffNotice as Notice,
} from "@/lib/rundown-handoff";

const EMPTY: readonly Notice[] = [];
const serverSnapshot = () => EMPTY;
const explanations = {
  unconfirmed: "Confirmation was lost. Check live state before repeating an action.",
  rejected: "The server did not confirm a change. Later changes were not sent. Check live state and your access before trying again.",
  expired: "A transport action expired or its deadline could not be verified. Remaining changes were not sent.",
  interrupted: "The page closed before confirmation. Check live state before repeating an action.",
};

export function RundownHandoffNotice({ orgId, slug }: { orgId: string; slug: string }) {
  const snapshot = useCallback(() => readRundownHandoffs(orgId), [orgId]);
  const notices = useSyncExternalStore(subscribeRundownHandoffs, snapshot, serverSnapshot);
  if (!notices.length) return null;
  return <section aria-label="Rundown changes" className="max-h-[40dvh] shrink-0 overflow-y-auto border-b border-amber-400/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
    {notices.map(notice => <div key={notice.id} role={notice.kind === "pending" ? "status" : "alert"} className="flex flex-wrap items-center gap-3 py-1">
      <p className="min-w-0 flex-1 basis-60">
        {notice.kind === "pending" ? `Confirming ${notice.count} rundown ${notice.count === 1 ? "change" : "changes"} after leaving the page.` : `${notice.count} rundown ${notice.count === 1 ? "change needs" : "changes need"} review. ${explanations[notice.reason]}`} {notice.serviceDate && <span>Show date: {notice.serviceDate}. </span>}
        <time dateTime={new Date(notice.occurredAt).toISOString()} className="whitespace-nowrap">{new Date(notice.occurredAt).toLocaleTimeString()}</time>
      </p>
      <Link to="/$slug/rundown" params={{ slug }} search={{ show: notice.showId, date: notice.serviceDate }} className="inline-flex min-h-11 items-center rounded-md border border-amber-400/40 px-3 font-medium focus-visible:outline-2 focus-visible:outline-amber-300">Review rundown</Link>
      {notice.kind === "failed" && <Button type="button" variant="ghost" className="min-h-11 text-amber-200" onClick={() => dismissRundownHandoff(orgId, notice.id)}>Dismiss notice</Button>}
    </div>)}
  </section>;
}
