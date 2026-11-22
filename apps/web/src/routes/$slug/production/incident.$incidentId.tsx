import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronUp, ClipboardCheck, Link2, Trash2 } from "lucide-react";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { ReadFailureNotice } from "@/components/layout/ReadFailureNotice";
import { QuietActivity } from "@/components/ui/QuietActivity";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { useOperatorRead } from "@/hooks/useOperatorRead";
import { useIncidentWrite } from "@/hooks/useIncidentWrite";
import { useDeviceTimeZone } from "@/hooks/useDeviceTimeZone";
import { getIncidentDetail } from "@/lib/incidents";
import { getIncidentHistory } from "@/lib/incident-history";
import { parseIncidentTimestamp } from "@/lib/incident-time";
import { objectionableContentReason } from "@/lib/user-content-safety";
import { INCIDENT_CATEGORIES, type IncidentOperation } from "@/lib/incident-writes";
import { IncidentDiscussion } from "@/components/incidents/IncidentDiscussion";
import {
  card,
  clockTime,
  ghostButton,
  longDate,
  PersonAvatar,
  primaryButton,
  secondaryButton,
  SectionCard,
  SeverityBars,
  SeverityPicker,
  severityLabel,
  splitDescription,
  StatusLabel,
} from "@/components/incidents/incident-a";

const HISTORY_DEFAULTS = { query: "", status: "all", severity: "all", category: "", assignee: "", from: "", to: "", sort: "newest", page: 1 } as const;

export const Route = createFileRoute("/$slug/production/incident/$incidentId")({
  pendingComponent: () => <PageSkeleton />,
  pendingMs: 800,
  pendingMinMs: 100,
  loader: async ({ context, params, abortController }) => {
    const signal = abortController.signal;
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, ["incidents:report", "incidents:access"], context.slug, context.orgId);
    const [detail, neighbours] = await Promise.all([
      getIncidentDetail({ data: { orgId: context.orgId, incidentId: params.incidentId }, signal }),
      // Position within the newest-first history, for "2 of 16" and the up/down buttons.
      getIncidentHistory({ data: { orgId: context.orgId, status: "all", severity: "all", sort: "newest", page: 1, pageSize: 100 }, signal }),
    ]);
    return { detail, orgId: context.orgId, order: neighbours.incidents.map(incident => incident.id), total: neighbours.total };
  },
  component: IncidentDetailPage,
});

type Changes = Extract<IncidentOperation, { kind: "update" }>["changes"];

function IncidentDetailPage() {
  const initial = Route.useLoaderData();
  const { slug, incidentId } = Route.useParams();
  return <IncidentDetailWorkspace key={`${initial.orgId}:${incidentId}`} initial={initial} slug={slug} incidentId={incidentId} />;
}

type DetailInitial = {
  detail: Awaited<ReturnType<typeof getIncidentDetail>>;
  orgId: string;
  order: string[];
  total: number;
};

export function IncidentDetailWorkspace({ initial, slug, incidentId }: { initial: DetailInitial; slug: string; incidentId: string }) {
  const navigate = useNavigate();
  const timeZone = useDeviceTimeZone();
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  const detailRead = useOperatorRead({
    key: `${initial.orgId}:${incidentId}`,
    initialValue: initial.detail,
    read: useCallback((signal: AbortSignal) => getIncidentDetail({ data: { orgId: initial.orgId, incidentId }, signal }), [initial.orgId, incidentId]),
    errorMessage: "Could not refresh this incident. What you see is the last confirmed version.",
    intervalMs: 15_000,
  });
  const { incident, comments, reactions, responders, canManage, viewerId } = detailRead.value;
  const writes = useIncidentWrite({ orgId: initial.orgId, showId: incident?.showId ?? null, serviceDate: incident?.serviceDate ?? "2000-01-01" });
  // Shown immediately; cleared once the refreshed incident arrives or the save fails.
  const [pending, setPending] = useState<Changes>({});
  const [noteDraft, setNoteDraft] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const busy = writes.state.kind !== "idle";

  if (!incident) {
    return <div className="schedule-a flex h-full flex-col items-start gap-4 bg-board-bg px-8 py-10">
      <Link to="/$slug/production/incidents-history" params={{ slug }} search={HISTORY_DEFAULTS} className="inline-flex items-center gap-1 text-[13px] text-[var(--sa-ink-2)] hover:text-board-text"><ChevronLeft className="h-3.5 w-3.5" />Incident history</Link>
      <h1 className="text-xl font-semibold text-board-text">This incident is no longer here</h1>
      <p className="text-[13px] text-[var(--sa-ink-2)]">It may have been deleted. Everything else in the history is unchanged.</p>
    </div>;
  }

  const view = { ...incident, ...pending, resolutionNote: pending.resolutionNote ?? incident.resolutionNote };
  const assigneeName = pending.assignedTo !== undefined ? (responders.find(person => person.userId === pending.assignedTo)?.name ?? "") : incident.assignedName;
  const reported = parseIncidentTimestamp(incident.timestamp);
  const { title, body } = splitDescription(incident.description);
  const position = initial.order.indexOf(incident.id);
  const newer = position > 0 ? initial.order[position - 1] : null;
  const older = position >= 0 && position < initial.order.length - 1 ? initial.order[position + 1] : null;

  // With no operation, retries the unconfirmed change already queued (same request id, never a duplicate).
  const save = async (operation?: IncidentOperation) => {
    const ack = await writes.run(operation);
    await detailRead.refresh();
    setPending({});
    return ack?.result.outcome === "applied";
  };
  const update = (changes: Changes) => {
    if (!canManage || busy) return;
    setPending(current => ({ ...current, ...changes }));
    void save({ kind: "update", id: incident.id, snapshot: incident.deleteSnapshot, changes });
  };
  const remove = async () => {
    if (!canManage || busy) return;
    if (!await confirm({ title: "Delete this incident?", description: "Delete this incident and its discussion? This cannot be undone.", confirmLabel: "Delete incident", variant: "danger" })) return;
    if (await save({ kind: "delete", id: incident.id, snapshot: incident.deleteSnapshot })) void navigate({ to: "/$slug/production/incidents-history", params: { slug }, search: HISTORY_DEFAULTS });
  };
  const noteProblem = noteDraft ? objectionableContentReason(noteDraft) : null;
  const select = "h-9 w-full appearance-none rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface-2)] pl-3 pr-8 text-[13px] text-board-text outline-none focus:border-fire-500 disabled:opacity-60";

  return (
    <div className="schedule-a h-full overflow-auto bg-board-bg [overflow-wrap:anywhere]">
      <div className="mx-auto flex max-w-[1180px] flex-col gap-6 px-4 pb-12 pt-6 md:px-8">
        <div className="flex items-center justify-between gap-3">
          <Link to="/$slug/production/incidents-history" params={{ slug }} search={HISTORY_DEFAULTS} className="inline-flex min-h-9 items-center gap-1 text-[13px] text-[var(--sa-ink-2)] hover:text-board-text"><ChevronLeft className="h-3.5 w-3.5" />Incident history</Link>
          {position >= 0 ? <div className="flex items-center gap-2">
            <span className="text-xs tabular-nums text-[var(--sa-ink-2)]">{position + 1} <span className="text-[var(--sa-ink-3)]">of</span> {initial.total}</span>
            {[{ id: newer, label: "Newer incident", icon: ChevronUp }, { id: older, label: "Older incident", icon: ChevronDown }].map(({ id, label, icon: Icon }) => id
              ? <Link key={label} to="/$slug/production/incident/$incidentId" params={{ slug, incidentId: id }} aria-label={label} className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--sa-border-strong)] text-[var(--sa-ink-2)] hover:bg-[var(--sa-surface-2)] hover:text-board-text"><Icon className="h-4 w-4" /></Link>
              : <span key={label} aria-hidden="true" className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--sa-border)] text-[var(--sa-ink-3)] opacity-40"><Icon className="h-4 w-4" /></span>)}
          </div> : null}
        </div>

        <ReadFailureNotice variant="panel" error={detailRead.error} refreshing={detailRead.refreshing} retry={detailRead.retry} label="Try again" />
        {writes.state.kind === "uncertain" || writes.state.kind === "conflict"
          ? <ReadFailureNotice variant="panel" error={writes.state.failure} refreshing={false} retry={() => writes.state.kind === "conflict" ? writes.clearConflict() : void save()} label={writes.state.kind === "conflict" ? "Got it" : "Retry save"} title={writes.state.kind === "conflict" ? "Someone changed this incident first." : "Your change wasn't confirmed."} description={writes.state.failure.message} />
          : null}

        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="flex min-w-0 flex-col gap-6">
            <header className="flex flex-col gap-2">
              <p className="text-xs uppercase tracking-[0.04em] tabular-nums text-[var(--sa-ink-3)]">{longDate(reported, timeZone)} · {clockTime(reported, timeZone)}</p>
              <h1 className="text-[26px] font-semibold leading-[1.2] tracking-[-0.02em] text-board-text">{title}</h1>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] text-[var(--sa-ink-2)]">
                <StatusLabel status={view.status} />
                <span className="inline-flex items-center gap-2"><SeverityBars severity={view.severity} />{severityLabel(view.severity)}</span>
                <span>{view.category}</span>
                <span className="text-[var(--sa-ink-3)]">Reported by {incident.reportedBy || "someone on the crew"}</span>
                {incident.showName ? <span className="text-[var(--sa-ink-3)]">{incident.showName}</span> : null}
              </div>
            </header>

            <SectionCard title="What happened">
              <p className="whitespace-pre-wrap px-4 py-4 text-sm leading-[1.7] text-board-text">{body || title}</p>
            </SectionCard>

            <SectionCard title="Resolution" action={canManage && view.resolutionNote && noteDraft === null ? <button type="button" onClick={() => setNoteDraft(view.resolutionNote)} className={`${ghostButton} h-7 px-2.5 text-xs`}>Edit note</button> : null}>
              <div className="p-4">
                {noteDraft !== null ? (
                  <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); if (noteProblem) return; update({ resolutionNote: noteDraft.trim() }); setNoteDraft(null); }}>
                    <textarea autoFocus aria-label="Resolution note" value={noteDraft} onChange={event => setNoteDraft(event.target.value)} maxLength={4000} rows={4} placeholder="What fixed it, and what should the next crew check before service?" className="w-full resize-y rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface-2)] px-3 py-2.5 text-sm leading-[1.6] text-board-text outline-none placeholder:text-[var(--sa-ink-3)] focus:border-fire-500" />
                    {noteProblem ? <p role="alert" className="text-[13px] text-[var(--sa-danger)]">{noteProblem}</p> : null}
                    <div className="flex justify-end gap-2">
                      <button type="button" onClick={() => setNoteDraft(null)} className={ghostButton}>Cancel</button>
                      <button type="submit" disabled={busy || !!noteProblem || noteDraft.trim() === incident.resolutionNote} className={primaryButton}>Save note</button>
                    </div>
                  </form>
                ) : view.resolutionNote ? (
                  <p className="whitespace-pre-wrap text-sm leading-[1.7] text-board-text">{view.resolutionNote}</p>
                ) : (
                  <div className="flex flex-wrap items-center gap-4 rounded-lg border border-dashed border-[var(--sa-border-strong)] px-4 py-4">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--sa-surface-2)] text-[var(--sa-ink-2)]"><ClipboardCheck className="h-4 w-4" strokeWidth={1.75} /></span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-semibold text-board-text">No resolution note yet</p>
                      <p className="text-[13px] text-[var(--sa-ink-2)]">Write down what fixed it, so the next crew knows what to check before service.</p>
                    </div>
                    {canManage ? <button type="button" onClick={() => setNoteDraft("")} className={`${secondaryButton} h-7 px-2.5 text-xs`}>Add note</button> : null}
                  </div>
                )}
              </div>
            </SectionCard>

            <SectionCard title="Comments" count={comments.length}>
              <IncidentDiscussion
                incidentId={incident.id}
                comments={comments}
                reactions={reactions}
                viewerId={viewerId}
                timeZone={timeZone}
                disabled={busy || !!detailRead.error}
                onSave={save}
              />
            </SectionCard>
          </div>

          <aside aria-label="Incident details" className={`${card} lg:sticky lg:top-6`}>
            <h2 className="px-4 pb-1 pt-4 text-[13px] font-semibold text-board-text">Details</h2>
            <dl className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5 px-4 pb-4 pt-2 text-[13px]">
              <dt className="text-[var(--sa-ink-2)]">Status</dt>
              <dd>{canManage ? <label className="relative block">
                <span className={`pointer-events-none absolute left-3 top-1/2 h-[7px] w-[7px] -translate-y-1/2 rounded-full ${view.status === "resolved" ? "bg-[var(--sa-ok)]" : "bg-[var(--sa-warn)]"}`} />
                <select aria-label="Status" value={view.status} disabled={busy} onChange={event => update({ status: event.target.value as "open" | "resolved" })} className={`${select} pl-7`}><option value="open">Open</option><option value="resolved">Resolved</option></select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--sa-ink-3)]" />
              </label> : <StatusLabel status={view.status} />}</dd>

              <dt className="text-[var(--sa-ink-2)]">Category</dt>
              <dd>{canManage ? <label className="relative block">
                <select aria-label="Category" value={view.category} disabled={busy} onChange={event => update({ category: event.target.value as (typeof INCIDENT_CATEGORIES)[number] })} className={select}>
                  {!INCIDENT_CATEGORIES.includes(view.category as (typeof INCIDENT_CATEGORIES)[number]) ? <option value={view.category}>{view.category}</option> : null}
                  {INCIDENT_CATEGORIES.map(category => <option key={category} value={category}>{category}</option>)}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--sa-ink-3)]" />
              </label> : <span className="text-board-text">{view.category}</span>}</dd>

              <dt className="text-[var(--sa-ink-2)]">Assignee</dt>
              <dd>{canManage ? <label className="relative block">
                <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2"><PersonAvatar name={assigneeName || null} size={20} /></span>
                <select aria-label="Assignee" value={view.assignedTo ?? ""} disabled={busy} onChange={event => update({ assignedTo: event.target.value || null })} className={`${select} pl-9`}>
                  <option value="">Unassigned</option>
                  {incident.assignedTo && !responders.some(person => person.userId === incident.assignedTo) ? <option value={incident.assignedTo}>{incident.assignedName || "Current owner"}</option> : null}
                  {responders.map(person => <option key={person.userId} value={person.userId}>{person.name}{person.userId === viewerId ? " (you)" : ""}</option>)}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--sa-ink-3)]" />
              </label> : <span className="inline-flex items-center gap-2 text-board-text"><PersonAvatar name={assigneeName || null} size={20} />{assigneeName || "Unassigned"}</span>}</dd>

              <dt className="col-span-2 pt-1 text-[var(--sa-ink-2)]">Severity</dt>
              <dd className="col-span-2">{canManage
                ? <SeverityPicker compact value={view.severity} disabled={busy} onChange={severity => update({ severity })} />
                : <span className="inline-flex items-center gap-2 text-board-text"><SeverityBars severity={view.severity} />{severityLabel(view.severity)}</span>}</dd>
            </dl>
            <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-3 border-t border-[var(--sa-border)] px-4 py-4 text-[13px]">
              <dt className="text-[var(--sa-ink-2)]">Reported by</dt><dd className="text-board-text">{incident.reportedBy || "—"}</dd>
              <dt className="text-[var(--sa-ink-2)]">Reported</dt><dd className="tabular-nums text-board-text">{longDate(reported, timeZone)} · {clockTime(reported, timeZone)}</dd>
              {incident.acknowledgedAt ? <><dt className="text-[var(--sa-ink-2)]">Acknowledged</dt><dd className="text-board-text">Yes</dd></> : null}
            </dl>
            <div className="flex items-center justify-between gap-2 border-t border-[var(--sa-border)] px-2 py-2">
              <button type="button" onClick={() => { void navigator.clipboard?.writeText(window.location.href).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }} className={ghostButton}>
                {copied ? <Check className="h-3.5 w-3.5" /> : <Link2 className="h-3.5 w-3.5" />}{copied ? "Link copied" : "Copy link"}
              </button>
              {canManage ? <button type="button" disabled={busy} onClick={() => void remove()} className={`${ghostButton} text-[var(--sa-danger)] hover:bg-[var(--sa-danger)]/10 hover:text-[var(--sa-danger)]`}><Trash2 className="h-3.5 w-3.5" />Delete</button> : null}
            </div>
            {writes.state.kind === "pending" ? <p role="status" className="border-t border-[var(--sa-border)] px-4 py-2 text-xs text-[var(--sa-ink-3)]"><QuietActivity label="Saving…" /></p> : null}
          </aside>
        </div>
      </div>
      {ConfirmDialogEl}
    </div>
  );
}
