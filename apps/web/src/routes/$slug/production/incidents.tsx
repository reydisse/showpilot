import { QuietActivity } from "@/components/ui/QuietActivity";
import { RelaySyncNotice } from "@/components/RelaySyncNotice";
import { parseIncidentTimestamp } from "@/lib/incident-time";
import { createFileRoute, Link, redirect, useBlocker, useRouteContext } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { useCallback, useState, type KeyboardEvent } from "react";
import { ChevronRight, History, MessageCircle, Plus, Search, ShieldCheck } from "lucide-react";
import { getIncidentCountsByShow, getIncidentSnapshot } from "@/lib/incidents";
import { INCIDENT_CATEGORIES, type IncidentOperation, type IncidentRow } from "@/lib/incident-writes";
import { useOperatorRead } from "@/hooks/useOperatorRead";
import { useIncidentWrite } from "@/hooks/useIncidentWrite";
import { useDeviceTimeZone } from "@/hooks/useDeviceTimeZone";
import { ReadFailureNotice } from "@/components/layout/ReadFailureNotice";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { ModalA, modalCancel, modalHint, modalPrimary } from "@/components/schedule/modal-a";
import {
  hasAnyEffectivePermission,
  hasEffectivePermission,
} from "@/lib/app-permissions";
import { getTodayDateString } from "@/lib/utils";

import { getOrgSettings } from "@/lib/settings";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { useServiceDateRollover } from "@/hooks/useServiceDateRollover";
import { useCueSheetSync } from "@/hooks/useCueSheetSync";
import { getIncidentHistory } from "@/lib/incident-history";
import { getRundownOpeningDate } from "@/lib/rundown";
import { card, clockTime, dayMonth, longDate, primaryButton, secondaryButton, ghostButton, SectionCard, SeverityBars, SeverityPicker, splitDescription } from "@/components/incidents/incident-a";

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function normalizeIncident(incident: IncidentRow): IncidentRow {
  return { ...incident, category: INCIDENT_CATEGORIES.find(category => category.toLowerCase() === incident.category.trim().toLowerCase()) ?? incident.category };
}

export const Route = createFileRoute("/$slug/production/incidents")({
  validateSearch: (search: Record<string, unknown>) => ({
    incident: typeof search.incident === "string" ? search.incident : undefined,
    show: typeof search.show === "string" ? search.show : undefined,
    date:
      typeof search.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(search.date)
        ? search.date
        : undefined,
    // From History's "Report incident": open the report form on arrival.
    report: search.report === true || search.report === "true" ? true : undefined,
  }),
  // Older notification and history links point at ?incident=; the incident now has its own page.
  beforeLoad: ({ search, params }) => {
    if (search.incident) throw redirect({ to: "/$slug/production/incident/$incidentId", params: { slug: params.slug, incidentId: search.incident } });
  },
  pendingComponent: () => <PageSkeleton />,
  pendingMs: 800,
  pendingMinMs: 100,
  loaderDeps: ({ search }) => ({ date: search.date, show: search.show }),
  loader: async ({ context, deps, abortController }) => {
    const signal = abortController.signal;
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(
      context.role,
      ["incidents:report", "incidents:access"],
      context.slug,
      context.orgId,
    );
    return { ...await loadIncidentPage(context.orgId, deps, signal), role: context.role, grantedPermissions: context.grantedPermissions };

  },
  component: IncidentsPage,
});

async function loadIncidentPage(orgId: string, deps: { date?: string; show?: string }, signal: AbortSignal) {
    const settings = await getOrgSettings({ data: { orgId: orgId }, signal });
    const today = getTodayDateString(settings["org-timezone"]);
    const opening = await getRundownOpeningDate({
      data: {
        orgId: orgId,
        today,
        serviceDate: deps.date,
        showId: deps.show,
      }, signal,
    });
    const serviceDate = opening.serviceDate;
    const showId = opening.showId;
    const [snapshot, recentHistory, counts] = await Promise.all([
      getIncidentSnapshot({ data: { orgId: orgId, serviceDate, showId: showId ?? null }, signal }),
      getIncidentHistory({
        data: {
          orgId: orgId,
          status: "all",
          severity: "all",
          sort: "newest",
          to: shiftDate(getTodayDateString(settings["org-timezone"]), -1),
          page: 1,
          pageSize: 10,
        }, signal,
      }),
      getIncidentCountsByShow({ data: { orgId }, signal }),
    ]);
    return {
      snapshot,
      orgId: orgId,
      orgTimezone: settings["org-timezone"] || "UTC",
      initialServiceDate: serviceDate,
      initialShowId: showId ?? null,
      shows: opening.shows,
      recentHistory,
      counts,
    };
}

function IncidentsPage() {
  const initial = Route.useLoaderData();
  const { slug } = Route.useParams();
  const { report } = Route.useSearch();
  return <IncidentsWorkspace key={`${initial.orgId}:${initial.initialShowId}:${initial.initialServiceDate}`} initial={initial} slug={slug} openReport={report} />;
}

type IncidentInitial = Awaited<ReturnType<typeof loadIncidentPage>> & { role: Parameters<typeof hasEffectivePermission>[0]; grantedPermissions: Parameters<typeof hasEffectivePermission>[1] };
type ReportFields = Omit<Extract<IncidentOperation, { kind: "report" }>, "kind">;
const emptyReport: ReportFields = { category: "Audio", severity: "medium", description: "", reportedBy: "" };

export function IncidentsWorkspace({ initial, slug, openReport = false }: { initial: IncidentInitial; slug: string; openReport?: boolean }) {
  const { snapshot: initialSnapshot, recentHistory, counts, orgId, role, grantedPermissions, orgTimezone, initialServiceDate, initialShowId, shows } = initial;
  const { user } = useRouteContext({ from: "/$slug" });
  const timeZone = useDeviceTimeZone();
  const [selection, setSelection] = useState({ showId: initialShowId, serviceDate: initialServiceDate });
  const { showId, serviceDate } = selection;
  const scopeKey = JSON.stringify([orgId, showId, serviceDate]);
  const read = useCallback((signal: AbortSignal) => getIncidentSnapshot({ data: { orgId, showId, serviceDate }, signal }), [orgId, showId, serviceDate]);
  const snapshotRead = useOperatorRead<Awaited<ReturnType<typeof getIncidentSnapshot>> | null>({
    key: scopeKey, initialValue: showId === initialShowId && serviceDate === initialServiceDate ? initialSnapshot : null,
    read, errorMessage: "Could not refresh incidents. Confirmed reports and drafts are kept. Retry to get the latest discussion.",
    // The relay can request a fresh snapshot while this tab is in the background.
    pauseWhenHidden: false,
  });
  const incidents = snapshotRead.value?.incidents.map(normalizeIncident) ?? [];
  const comments = snapshotRead.value?.comments ?? [];
  const loadingIncidents = !snapshotRead.value && !snapshotRead.error;
  const writes = useIncidentWrite({ orgId, showId, serviceDate });
  const writeLocked = writes.state.kind !== "idle";
  const [showQuery, setShowQuery] = useState("");
  const [showUntitled, setShowUntitled] = useState(false);
  const [showForm, setShowForm] = useState(openReport);
  const [form, setForm] = useState<ReportFields>(() => ({ ...emptyReport, reportedBy: user.name }));
  const [savedNotice, setSavedNotice] = useState("");
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  const canReportIncidents = hasAnyEffectivePermission(role, grantedPermissions, ["incidents:report", "incidents:access"]);
  const canWrite = canReportIncidents && !!snapshotRead.value && !snapshotRead.error && !snapshotRead.refreshing && !writeLocked;
  const today = getTodayDateString(orgTimezone);
  void hasEffectivePermission;
  const dirty = writeLocked || !!form.description.trim();
  const blocker = useBlocker({ shouldBlockFn: () => dirty, enableBeforeUnload: dirty, withResolver: true });
  const resetForm = () => setForm({ ...emptyReport, reportedBy: user.name });
  const selectShow = async (next: typeof selection) => {
    if (dirty && !await confirm({ title: "Leave this report?", description: "An unconfirmed save may still complete. Leaving discards your draft report and retry controls.", confirmLabel: "Leave report" })) return;
    setSelection(next); resetForm(); setSavedNotice(""); setShowForm(false);
  };
  useServiceDateRollover({ serviceDate, timeZone: orgTimezone, onTodayChanged: nextToday => {
    if (!dirty) { const nextShow = shows.find(show => show.serviceDate === nextToday); void selectShow({ serviceDate: nextShow?.serviceDate ?? nextToday, showId: nextShow?.id ?? null }); }
  } });
  const { publish: publishIncident, syncError, syncErrorAt, status: syncStatus, retrySync } = useCueSheetSync({
    orgId, scope: scopeKey, onNote: () => {},
    onRefresh: async signal => { if (!await snapshotRead.refresh() || signal.aborted) throw new Error("This change needs attention."); },
    onIncident: event => { if (event.showId === showId) snapshotRead.invalidate(); },
  });
  const save = async (operation?: IncidentOperation) => {
    if (operation && (!canWrite || (operation.kind === "report" && !showId))) return;
    setSavedNotice("");
    const ack = await writes.run(operation);
    if (!ack) return;
    snapshotRead.invalidate();
    if (ack.result.outcome !== "applied") return;
    setSavedNotice("Report saved.");
    const op = ack.attempt.operation;
    if (op.kind === "report") { resetForm(); setShowForm(false); }
    const incidentId = op.kind === "report" ? `incident-${ack.attempt.requestId}` : op.kind === "delete" || op.kind === "update" ? op.id : op.kind === "comment" ? op.incidentId : comments.find(comment => comment.id === op.commentId)?.incidentId;
    if (incidentId) publishIncident({ type: "incident", showId, incidentId, action: op.kind === "report" ? "created" : op.kind === "delete" ? "deleted" : "commented", at: Date.now() });
  };
  const submitReport = () => { if (form.description.trim()) void save({ kind: "report", ...form }); };
  const writeNotice = writes.state.kind === "uncertain" || writes.state.kind === "conflict" ?
    <ReadFailureNotice variant="panel" error={writes.state.failure} refreshing={writes.state.kind === "conflict" && (snapshotRead.refreshing || !!snapshotRead.error)}
      retry={() => writes.state.kind === "conflict" ? writes.clearConflict() : void save()} label={writes.state.kind === "conflict" ? "I reviewed the incident log" : "Retry incident save"}
      title={writes.state.kind === "conflict" ? "The incident log changed first." : "Your report wasn't confirmed."} description={writes.state.failure.message} />
    : writes.state.kind === "pending" ? <p role="status" className="text-xs text-[var(--sa-ink-3)]"><QuietActivity label="Saving incident change…" /></p> : null;

  const selectedShow = shows.find(show => show.id === showId);
  const relative = (date: string) => {
    const days = Math.round((Date.parse(date) - Date.parse(today)) / 86_400_000);
    return days === 0 ? "Today" : days === 1 ? "Tomorrow" : days === -1 ? "Yesterday" : null;
  };
  const dateOf = (date: string) => new Date(`${date}T12:00:00Z`);
  const dateLine = `${longDate(dateOf(serviceDate), "UTC")}${relative(serviceDate) ? ` · ${relative(serviceDate)}` : ""}`;
  const commentCount = (id: string) => comments.filter(comment => comment.incidentId === id).length;
  const visibleShows = shows.filter(show => (showUntitled || !!show.name.trim()) && (`${show.name} ${show.serviceDate} ${longDate(dateOf(show.serviceDate), "UTC")}`).toLowerCase().includes(showQuery.toLowerCase()));
  const hiddenUntitled = shows.filter(show => !show.name.trim()).length;
  const onReportKey = (event: KeyboardEvent) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (canWrite) submitReport(); } };

  return (
    <div className="schedule-a h-full overflow-auto bg-board-bg [overflow-wrap:anywhere]">
      <RelaySyncNotice error={syncError} occurredAt={syncErrorAt} status={syncStatus} onRetry={retrySync} />
      <div className="mx-auto flex max-w-[1180px] flex-col gap-6 px-4 pb-12 pt-6 md:px-8">
        <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="flex min-w-0 flex-col gap-1.5">
            <p className="text-xs uppercase tracking-[0.04em] tabular-nums text-[var(--sa-ink-3)]">{dateLine}</p>
            <h1 className="truncate text-[26px] font-semibold leading-[1.15] tracking-[-0.02em] text-board-text">{selectedShow?.name || "Incident log"}</h1>
          </div>
          <div className="flex items-center gap-2">
            <Link to="/$slug/production/incidents-history" params={{ slug }} search={HISTORY_DEFAULTS} className={ghostButton}><History className="h-3.5 w-3.5" />History</Link>
            {canReportIncidents && showId ? <button type="button" onClick={() => setShowForm(true)} className={primaryButton}><Plus className="h-3.5 w-3.5" strokeWidth={2} />Report incident</button> : null}
          </div>
        </header>
        <ReadFailureNotice variant="panel" error={snapshotRead.error} refreshing={snapshotRead.refreshing} retry={snapshotRead.retry} label="Retry incidents" title="We couldn't load this show's incidents." description="Check your connection and try again. Everything your crew reported is saved." />
        {!showForm && writeNotice}
        {savedNotice ? <p role="status" className="text-[13px] text-[var(--sa-ok)]">{savedNotice}</p> : null}

        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="flex min-w-0 flex-col gap-6">
            <SectionCard title="This show" count={loadingIncidents ? undefined : `${incidents.length} ${incidents.length === 1 ? "incident" : "incidents"}`}>
              {loadingIncidents ? <div className="schedule-skeleton flex flex-col"><span className="sr-only"><QuietActivity label="Loading incidents" /></span>{[0, 1].map(row => <div key={row} className="flex items-center gap-4 border-t border-[var(--sa-border)] px-4 py-4 first:border-t-0"><span className="h-3 w-4 rounded bg-[var(--sa-surface-3)]" /><span className="h-3 w-1/2 rounded bg-[var(--sa-surface-3)]" /></div>)}</div>
                : incidents.length ? incidents.map(incident => <IncidentRowLink key={incident.id} slug={slug} incident={incident} comments={commentCount(incident.id)} timeZone={timeZone} />)
                : !snapshotRead.error ? <div className="p-4">
                  <div className="flex flex-wrap items-start gap-4 rounded-lg border border-dashed border-[var(--sa-border-strong)] p-6">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-[var(--sa-surface-2)] text-[var(--sa-ok)]"><ShieldCheck className="h-5 w-5" strokeWidth={1.75} /></span>
                    <div className="flex min-w-0 max-w-[520px] flex-1 flex-col gap-1.5">
                      <h2 className="text-base font-semibold text-board-text">All clear for this show</h2>
                      <p className="text-[13px] leading-[1.6] text-[var(--sa-ink-2)]">{serviceDate < today
                        ? "Nobody logged a problem. If something did go wrong — an audio dropout, a camera fault, a stream issue — you can still report it after the fact."
                        : "Nothing was reported. If something goes wrong — an audio dropout, a camera fault, a stream issue — use Report incident and it lands here."}</p>
                      {serviceDate < today && canReportIncidents && showId ? <button type="button" onClick={() => setShowForm(true)} className={`${secondaryButton} mt-2 self-start`}><Plus className="h-3.5 w-3.5" />Report incident</button> : null}
                    </div>
                  </div>
                </div> : null}
            </SectionCard>

            <SectionCard title="Recent across shows" count={`${recentHistory.total} total`} action={<Link to="/$slug/production/incidents-history" params={{ slug }} search={HISTORY_DEFAULTS} className="inline-flex min-h-9 items-center gap-1 text-[13px] text-[var(--sa-ink-2)] hover:text-board-text"><ChevronRight className="h-3.5 w-3.5" />View all in History</Link>}>
              {recentHistory.incidents.length
                ? recentHistory.incidents.slice(0, 5).map(incident => <IncidentRowLink key={incident.id} slug={slug} incident={incident} comments={incident.commentCount} timeZone={timeZone} showDate />)
                : <p className="px-4 py-6 text-[13px] text-[var(--sa-ink-3)]">No earlier incidents yet.</p>}
            </SectionCard>
          </div>

          <aside aria-label="Shows" className={`${card} overflow-hidden`}>
            <div className="flex flex-col gap-3 p-4">
              <h2 className="text-[13px] font-semibold text-board-text">Shows</h2>
              <label className="relative block">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--sa-ink-3)]" />
                <input aria-label="Find a show or date" placeholder="Find a show or date" value={showQuery} onChange={event => setShowQuery(event.target.value)} className="h-9 w-full rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface-2)] pl-9 pr-3 text-[13px] text-board-text outline-none placeholder:text-[var(--sa-ink-3)] focus:border-fire-500" />
              </label>
            </div>
            {(["Upcoming", "Past"] as const).map(group => {
              const list = visibleShows.filter(show => group === "Upcoming" ? show.serviceDate >= today : show.serviceDate < today);
              if (!list.length) return null;
              return <div key={group} className="px-2 pb-2">
                <h3 className="px-2 pb-1 pt-1 text-[11px] font-medium uppercase tracking-[0.07em] text-[var(--sa-ink-3)]">{group}</h3>
                {list.map(show => {
                  const active = show.id === showId, count = counts[show.id] ?? 0;
                  const meta = group === "Upcoming" ? (relative(show.serviceDate) ?? longDate(dateOf(show.serviceDate), "UTC")) : count ? `${count} ${count === 1 ? "incident" : "incidents"}` : "No incidents";
                  return <button key={show.id} type="button" disabled={writes.state.kind === "pending"} aria-pressed={active} onClick={() => void selectShow({ showId: show.id, serviceDate: show.serviceDate })}
                    className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left disabled:opacity-50 ${active ? "bg-board-border" : "hover:bg-[var(--sa-surface-2)]"}`}>
                    <span className="flex w-8 shrink-0 flex-col items-center"><span className="text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--sa-ink-3)]">{dateOf(show.serviceDate).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" })}</span><span className={`text-[15px] font-medium tabular-nums leading-[1.2] ${active ? "text-fire-400" : "text-[var(--sa-ink-2)]"}`}>{Number(show.serviceDate.slice(8))}</span></span>
                    <span className="flex min-w-0 flex-col gap-0.5"><span className="truncate text-[13px] font-medium text-board-text">{show.name || "Untitled show"}</span><span className="text-xs text-[var(--sa-ink-3)]">{meta}</span></span>
                  </button>;
                })}
              </div>;
            })}
            {hiddenUntitled ? <div className="flex items-center justify-between gap-2 border-t border-[var(--sa-border)] px-4 py-3 text-xs text-[var(--sa-ink-3)]">
              <span>{showUntitled ? `${hiddenUntitled} untitled ${hiddenUntitled === 1 ? "show" : "shows"} shown` : `${hiddenUntitled} untitled ${hiddenUntitled === 1 ? "show" : "shows"} hidden`}</span>
              <button type="button" onClick={() => setShowUntitled(value => !value)} className="rounded-md px-2 py-1 font-medium text-board-text hover:bg-[var(--sa-surface-2)]">{showUntitled ? "Hide" : "Show"}</button>
            </div> : null}
          </aside>
        </div>
      </div>

      {showForm && canReportIncidents && showId ? (
        <ModalA title="Report incident" description={`${selectedShow?.name || "This show"} · ${longDate(dateOf(serviceDate), "UTC")}`} onClose={() => setShowForm(false)}>
          <form onSubmit={event => { event.preventDefault(); submitReport(); }} onKeyDown={onReportKey} className="flex flex-col gap-4">
            {writeNotice}
            <label className="block">
              <span className="sr-only">What happened?</span>
              <textarea id="incident-description" autoFocus aria-label="What happened?" maxLength={10_000} disabled={writeLocked} value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} placeholder="What happened?"
                className="!h-32 w-full resize-none !py-3 !text-sm" />
              <span className={modalHint}>The first line becomes the title in the log. Add detail on the lines below.</span>
            </label>
            <fieldset disabled={writeLocked} className="flex flex-col gap-2">
              <legend className="mb-2 text-[11px] font-medium uppercase tracking-[0.07em] text-[var(--sa-ink-3)]">Category</legend>
              <div className="flex flex-wrap gap-1.5">
                {INCIDENT_CATEGORIES.map(value => <button key={value} type="button" aria-pressed={form.category === value} onClick={() => setForm({ ...form, category: value })}
                  className={`h-8 rounded-lg border px-3 text-[13px] disabled:opacity-50 ${form.category === value ? "border-[var(--sa-border-strong)] bg-[var(--sa-surface-3)] font-medium text-board-text shadow-[inset_0_0_0_1px_var(--sa-border-strong)]" : "border-[var(--sa-border-strong)] text-[var(--sa-ink-2)] hover:text-board-text"}`}>{value}</button>)}
              </div>
            </fieldset>
            <fieldset disabled={writeLocked} className="flex flex-col gap-2">
              <legend className="mb-2 text-[11px] font-medium uppercase tracking-[0.07em] text-[var(--sa-ink-3)]">Severity</legend>
              <SeverityPicker value={form.severity} disabled={writeLocked} onChange={severity => setForm({ ...form, severity })} />
            </fieldset>
            <label className="block">
              <span className="block text-[11px] font-medium uppercase tracking-[0.07em] text-[var(--sa-ink-3)]">Reported by</span>
              <input id="incident-reporter" maxLength={200} disabled={writeLocked} value={form.reportedBy} onChange={event => setForm({ ...form, reportedBy: event.target.value })} placeholder="Who noticed it" className="w-full" />
            </label>
            <div className="-mx-5 -mb-5 mt-1 flex flex-wrap items-center gap-2 border-t border-[var(--sa-border)] bg-board-bg px-5 py-3.5">
              <span className="mr-auto hidden items-center gap-1.5 text-xs text-[var(--sa-ink-3)] sm:inline-flex"><kbd className="rounded border border-[var(--sa-border-strong)] px-1.5 py-0.5 text-[11px]">⌘</kbd><kbd className="rounded border border-[var(--sa-border-strong)] px-1.5 py-0.5 text-[11px]">Enter</kbd>to submit</span>
              <button type="button" onClick={() => setShowForm(false)} className={modalCancel}>Cancel</button>
              <button type="submit" disabled={!canWrite || !form.description.trim()} className={modalPrimary}>Submit report</button>
            </div>
          </form>
        </ModalA>
      ) : null}
      {ConfirmDialogEl}
      <Dialog open={blocker.status === "blocked"} onOpenChange={open => { if (!open) blocker.reset?.(); }}>
        <DialogContent><DialogHeader><DialogTitle>Leave this report?</DialogTitle><DialogDescription>An unconfirmed save may still complete. Leaving discards your draft report and retry controls.</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => blocker.reset?.()}>Stay</Button><Button onClick={() => blocker.proceed?.()}>Leave report</Button></DialogFooter></DialogContent>
      </Dialog>
    </div>
  );
}

const HISTORY_DEFAULTS = { query: "", status: "all", severity: "all", category: "", assignee: "", from: "", to: "", sort: "newest", page: 1 } as const;

/** One incident in a list: severity bars, title and first detail line, comments, and when it was reported. */
export function IncidentRowLink({ slug, incident, comments, timeZone, showDate = false }: {
  slug: string;
  incident: Pick<IncidentRow, "id" | "severity" | "description" | "timestamp">;
  comments: number;
  timeZone: string;
  showDate?: boolean;
}) {
  const { title, body } = splitDescription(incident.description);
  const reported = parseIncidentTimestamp(incident.timestamp);
  return <Link to="/$slug/production/incident/$incidentId" params={{ slug, incidentId: incident.id }}
    className="grid grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-x-4 border-t border-[var(--sa-border)] px-4 py-3 first:border-t-0 hover:bg-[var(--sa-surface-2)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-fire-500 sm:grid-cols-[16px_minmax(0,1fr)_48px_76px]">
    <SeverityBars severity={incident.severity} />
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="truncate text-[13px] font-medium text-board-text">{title}</span>
      {body ? <span className="truncate text-[13px] text-[var(--sa-ink-3)]">{body}</span> : null}
    </span>
    <span className="hidden items-center gap-1.5 text-[13px] tabular-nums text-[var(--sa-ink-2)] sm:inline-flex"><MessageCircle className="h-3.5 w-3.5 text-[var(--sa-ink-3)]" />{comments}</span>
    <span className="flex flex-col items-end text-xs tabular-nums">
      <span className="text-board-text">{showDate ? dayMonth(reported, timeZone) : clockTime(reported, timeZone)}</span>
      {showDate ? <span className="text-[var(--sa-ink-3)]">{clockTime(reported, timeZone)}</span> : null}
    </span>
  </Link>;
}
