import { RelaySyncNotice } from "@/components/RelaySyncNotice";
import { createFileRoute, Link, useBlocker } from "@tanstack/react-router";
import { isEmojiReaction } from "@showpilot/shared";
import { PageSkeleton } from "@/components/ui/Skeleton";
import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Plus,
  AlertTriangle,
  ShieldCheck,
  Trash2,
  MessageCircle,
  Send,
  History,
  SmilePlus,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { objectionableContentReason } from "@/lib/user-content-safety";
import { getIncidentSnapshot } from "@/lib/incidents";
import { INCIDENT_CATEGORIES, REACTION_EMOJIS, incidentCategorySchema, incidentSeveritySchema, type IncidentOperation, type IncidentRow, type IncidentComment, type ContentReaction } from "@/lib/incident-writes";
import { useOperatorRead } from "@/hooks/useOperatorRead";
import { useIncidentWrite } from "@/hooks/useIncidentWrite";
import { ReadFailureNotice } from "@/components/layout/ReadFailureNotice";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import {
  hasAnyEffectivePermission,
  hasEffectivePermission,
} from "@/lib/app-permissions";
import { getTodayDateString, formatTime } from "@/lib/utils";
import { ShowSwitcherMenu } from "@/components/show-switcher-menu";
import { getOrgSettings } from "@/lib/settings";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { useServiceDateRollover } from "@/hooks/useServiceDateRollover";
import { useCueSheetSync } from "@/hooks/useCueSheetSync";
import { getIncidentHistory } from "@/lib/incident-history";
import { getRundownOpeningDate } from "@/lib/rundown";

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDisplayDate(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function normalizeIncident(incident: IncidentRow): IncidentRow {
  return { ...incident, category: INCIDENT_CATEGORIES.find(category => category.toLowerCase() === incident.category.trim().toLowerCase()) ?? incident.category };
}

const SEVERITY_COLORS: Record<string, string> = {
  low: "bg-blue-500/15 text-blue-400 border-blue-500/25",
  medium: "bg-yellow-500/15 text-yellow-400 border-yellow-500/25",
  high: "bg-orange-500/15 text-orange-400 border-orange-500/25",
  critical: "bg-red-500/15 text-red-400 border-red-500/25",
};

export const Route = createFileRoute("/$slug/production/incidents")({
  validateSearch: (search: Record<string, unknown>) => ({
    incident: typeof search.incident === "string" ? search.incident : undefined,
    show: typeof search.show === "string" ? search.show : undefined,
    date:
      typeof search.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(search.date)
        ? search.date
        : undefined,
  }),
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
    const [snapshot, recentHistory] = await Promise.all([
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
    ]);
    return {
      snapshot,
      orgId: orgId,
      orgTimezone: settings["org-timezone"] || "UTC",
      initialServiceDate: serviceDate,
      initialShowId: showId ?? null,
      shows: opening.shows,
      recentHistory,
    };
}

function IncidentsPage() {
  const initial = Route.useLoaderData();
  const { incident: focusedIncidentId } = Route.useSearch();
  const { slug } = Route.useParams();
  return <IncidentsWorkspace key={`${initial.orgId}:${initial.initialShowId}:${initial.initialServiceDate}`} initial={initial} slug={slug} focusedIncidentId={focusedIncidentId} />;
}

type IncidentInitial = Awaited<ReturnType<typeof loadIncidentPage>> & { role: Parameters<typeof hasEffectivePermission>[0]; grantedPermissions: Parameters<typeof hasEffectivePermission>[1] };
type ReportFields = Omit<Extract<IncidentOperation, { kind: "report" }>, "kind">;
const emptyReport: ReportFields = { category: "Audio", severity: "medium", description: "", reportedBy: "" };

export function IncidentsWorkspace({ initial, slug, focusedIncidentId }: { initial: IncidentInitial; slug: string; focusedIncidentId?: string }) {
  const { snapshot: initialSnapshot, recentHistory, orgId, role, grantedPermissions, orgTimezone, initialServiceDate, initialShowId, shows } = initial;
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
  const reactions = snapshotRead.value?.reactions ?? [];
  const loadingIncidents = !snapshotRead.value && !snapshotRead.error;
  const writes = useIncidentWrite({ orgId, showId, serviceDate });
  const writeLocked = writes.state.kind !== "idle";
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<ReportFields>(emptyReport);
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});
  const [replyTargets, setReplyTargets] = useState<Record<string, string | null>>({});
  const [savedNotice, setSavedNotice] = useState("");
  const [openIncidentId, setOpenIncidentId] = useState<string | null>(focusedIncidentId ?? null);
  const scrolledIncident = useRef<string | null>(null);
  const toggleIncident = (id: string) => setOpenIncidentId(current => current === id ? null : id);
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  const canReportIncidents = hasAnyEffectivePermission(role, grantedPermissions, ["incidents:report", "incidents:access"]);
  const canManageIncidents = hasEffectivePermission(role, grantedPermissions, "incidents:access");
  const canWrite = canReportIncidents && !!snapshotRead.value && !snapshotRead.error && !snapshotRead.refreshing && !writeLocked;
  const today = getTodayDateString(orgTimezone);
  const dirty = writeLocked || !!form.description.trim() || Object.values(commentDrafts).some(value => !!value.trim());
  const blocker = useBlocker({ shouldBlockFn: () => dirty, enableBeforeUnload: dirty, withResolver: true });
  const selectShow = async (next: typeof selection) => {
    if (dirty && !await confirm({ title: "Leave these incidents?", description: "An unconfirmed save may still complete. Leaving discards your local drafts and retry controls. Review this incident log when you return.", confirmLabel: "Leave incident log" })) return;
    setSelection(next); setForm(emptyReport); setCommentDrafts({}); setReplyTargets({}); setSavedNotice(""); setShowForm(false); setOpenIncidentId(null);
  };
  useServiceDateRollover({ serviceDate, timeZone: orgTimezone, onTodayChanged: nextToday => {
    if (!dirty) { const nextShow = shows.find(show => show.serviceDate === nextToday); void selectShow({ serviceDate: nextShow?.serviceDate ?? nextToday, showId: nextShow?.id ?? null }); }
  } });
  useEffect(() => { setOpenIncidentId(focusedIncidentId ?? null); }, [focusedIncidentId]);
  useEffect(() => {
    if (!openIncidentId) { scrolledIncident.current = null; return; }
    if (loadingIncidents || scrolledIncident.current === openIncidentId) return;
    const frame = requestAnimationFrame(() => {
      const card = document.getElementById(`incident-${openIncidentId}`);
      if (card) { scrolledIncident.current = openIncidentId; card.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
    });
    return () => cancelAnimationFrame(frame);
  }, [openIncidentId, loadingIncidents, snapshotRead.confirmedAt]);
  const { publish: publishIncident, syncError, syncErrorAt, status: syncStatus, retrySync } = useCueSheetSync({
    orgId, scope: scopeKey, onNote: () => {},
    onRefresh: async signal => { if (!await snapshotRead.refresh() || signal.aborted) throw new Error("Incident refresh was not confirmed. Retry to reconnect."); },
    onIncident: event => { if (event.showId === showId) snapshotRead.invalidate(); },
  });
  const save = async (operation?: IncidentOperation) => {
    if (operation && (!canWrite || (operation.kind === "report" && !showId))) return;
    setSavedNotice("");
    const ack = await writes.run(operation);
    if (!ack) return;
    snapshotRead.invalidate();
    if (ack.result.outcome !== "applied") return;
    setSavedNotice("Change saved.");
    const op = ack.attempt.operation;
    if (op.kind === "report") { setForm(emptyReport); setShowForm(false); }
    if (op.kind === "comment") {
      setCommentDrafts(current => current[op.incidentId]?.trim() === op.body ? { ...current, [op.incidentId]: "" } : current);
      setReplyTargets(current => ({ ...current, [op.incidentId]: null }));
    }
    const incidentId = op.kind === "report" ? `incident-${ack.attempt.requestId}` : op.kind === "delete" ? op.id : op.kind === "comment" ? op.incidentId : comments.find(comment => comment.id === op.commentId)?.incidentId;
    if (incidentId && op.kind !== "reaction") publishIncident({ type: "incident", showId, incidentId, action: op.kind === "report" ? "created" : op.kind === "delete" ? "deleted" : "commented", at: Date.now() });
    if (incidentId && op.kind === "reaction") publishIncident({ type: "incident", showId, incidentId, action: "commented", at: Date.now() });
  };
  const handleAdd = (event: React.FormEvent) => { event.preventDefault(); if (form.description.trim()) void save({ kind: "report", ...form }); };
  const handleDelete = async (incident: IncidentRow) => {
    if (!canManageIncidents || !canWrite) return;
    if (await confirm({ title: "Delete incident", description: "Delete this incident and its discussion? This action cannot be undone.", confirmLabel: "Delete" })) await save({ kind: "delete", id: incident.id, snapshot: incident.deleteSnapshot });
  };
  const submitComment = (incidentId: string) => { const body = commentDrafts[incidentId]?.trim(); if (body && !objectionableContentReason(body)) void save({ kind: "comment", incidentId, parentId: replyTargets[incidentId] ?? null, body }); };
  const reactToComment = async (commentId: string, emoji: string) => {
    const own = reactions.find(reaction => reaction.targetId === commentId && reaction.emoji === emoji && reaction.userId === snapshotRead.value?.viewerId);
    await save({ kind: "reaction", commentId, emoji, active: !own, expectedId: own?.id ?? null });
  };
  const writeNotice = writes.state.kind === "uncertain" || writes.state.kind === "conflict" ?
    <ReadFailureNotice error={writes.state.failure} refreshing={writes.state.kind === "conflict" && (snapshotRead.refreshing || !!snapshotRead.error)}
      retry={() => writes.state.kind === "conflict" ? writes.clearConflict() : void save()} label={writes.state.kind === "conflict" ? "I reviewed the incident log" : "Retry incident save"} />
    : writes.state.kind === "pending" ? <p role="status" className="p-3 text-sm text-board-muted">Saving incident change…</p> : null;

  return (
    <div className="h-full overflow-auto">
      <RelaySyncNotice error={syncError} occurredAt={syncErrorAt} status={syncStatus} onRetry={retrySync} />
      <div className="sticky top-0 z-10 border-b border-board-border bg-board-bg/80 px-4 py-4 backdrop-blur-xl sm:px-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="text-lg font-semibold text-board-text">
            Incident Log
          </h1>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end [&_button]:min-h-11">
            <Link
              to="/$slug/production/incidents-history"
              params={{ slug }}
              search={{
                query: "",
                status: "all",
                severity: "all",
                category: "",
                assignee: "",
                from: "",
                to: "",
                sort: "newest",
                page: 1,
              }}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-board-border bg-board-card px-3 text-xs font-medium text-board-muted transition-colors hover:border-fire-500/30 hover:text-board-text"
            >
              <History className="h-3.5 w-3.5" />
              History
            </Link>
            <ShowSwitcherMenu
              disabled={writes.state.kind === "pending"}
              selectedId={showId}
              shows={shows}
              timeZone={orgTimezone}
              onSelect={(selected) => {
                void selectShow({ showId: selected.id, serviceDate: selected.serviceDate });
              }}
            />
            {canReportIncidents && showId && (
              <button
                onClick={() => setShowForm(true)}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-black transition-all hover:shadow-lg hover:shadow-fire-500/20 active:scale-[0.98]"
                style={{
                  background:
                    "linear-gradient(135deg, #FFC107 0%, #FF8F00 100%)",
                }}
              >
                <Plus className="w-3.5 h-3.5" />
                Report
              </button>
            )}
          </div>
        </div>
        <ReadFailureNotice error={snapshotRead.error} refreshing={snapshotRead.refreshing} retry={snapshotRead.retry} label="Retry incidents" />
        {!showForm && writeNotice}
      </div>

      <div className="mx-auto max-w-3xl p-4 sm:p-6">
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-fire-400">
              {serviceDate === today ? "Today" : "Selected date"}
            </p>
            <h2 className="mt-1 text-sm font-semibold text-board-text">
              {serviceDate === today ? "Current incidents" : "Incident details"}
            </h2>
          </div>
          <span className="text-xs text-board-muted">
            {formatDisplayDate(serviceDate)}
          </span>
        </div>
        {savedNotice && <p role="status" className="py-3 text-sm text-emerald-400">{savedNotice}</p>}
        {loadingIncidents && (
          <p className="mb-3 text-xs text-board-muted">
            Loading incidents for {formatDisplayDate(serviceDate)}...
          </p>
        )}
        {incidents.length > 0 ? (
          <div className="space-y-3">
            {incidents.map((incident) => (
              <div
                id={`incident-${incident.id}`}
                key={incident.id}
                className={`group scroll-mt-28 rounded-xl bg-board-card border transition-colors ${incident.id === openIncidentId ? "border-fire-500/70" : "border-board-border hover:border-fire-500/20"}`}
              >
                <div className="flex items-start gap-1 p-4">
                <button
                  type="button"
                  className="min-w-0 flex-1 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-fire-500/50"
                  aria-expanded={openIncidentId === incident.id}
                  aria-controls={`discussion-${incident.id}`}
                  onClick={() => toggleIncident(incident.id)}
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <AlertTriangle
                      className={`w-4 h-4 mt-0.5 shrink-0 ${incident.severity === "critical" ? "text-red-400" : incident.severity === "high" ? "text-orange-400" : "text-yellow-400"}`}
                    />
                    <div className="min-w-0">
                      <p className="whitespace-pre-wrap [overflow-wrap:anywhere] text-sm text-board-text">
                        {incident.description}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span
                          className={`text-xs font-medium uppercase tracking-wider px-1.5 py-0.5 rounded border ${SEVERITY_COLORS[incident.severity] || SEVERITY_COLORS.medium}`}
                        >
                          {incident.severity}
                        </span>
                        <span className="text-xs text-board-muted bg-board-bg px-1.5 py-0.5 rounded border border-board-border">
                          {incident.category}
                        </span>
                        {incident.reportedBy && (
                          <span className="text-xs text-board-muted">
                            by {incident.reportedBy}
                          </span>
                        )}
                        {incident.timestamp && (
                          <span className="text-xs text-board-muted">
                            {formatTime(
                              new Date(incident.timestamp),
                              "12hr",
                              orgTimezone,
                            )}
                          </span>
                        )}
                        <span
                          className={`text-xs font-medium ${incident.status === "resolved" ? "text-green-400" : "text-board-muted"}`}
                        >
                          {incident.status}
                        </span>
                      </div>
                      <p
                        className={`mt-2 text-xs ${incident.assignedTo ? "text-board-text" : "text-red-400"}`}
                      >
                        {incident.assignedTo
                          ? `Assigned to ${incident.assignedName || "team member"}${incident.acknowledgedAt ? " · acknowledged" : " · awaiting acknowledgement"}`
                          : "Unassigned"}
                      </p>
                    </div>
                  </div>
                </button>
                  {canManageIncidents && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleDelete(incident);
                      }}
                      disabled={!canWrite}
                      className="min-h-11 min-w-11 rounded-lg p-2 text-board-muted hover:bg-red-500/20 hover:text-red-400 focus-visible:outline-2 focus-visible:outline-fire-500 disabled:opacity-50"
                      aria-label={`Delete incident: ${incident.description}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                <div className="border-t border-board-border/60 px-4 pb-4">
                  <button
                    type="button"
                    aria-expanded={openIncidentId === incident.id}
                    aria-controls={`discussion-${incident.id}`}
                    onClick={() => toggleIncident(incident.id)}
                    className="flex min-h-11 w-full flex-wrap items-center gap-2 py-2 text-xs font-medium text-board-muted hover:text-board-text"
                  >
                    <span className="text-fire-400">{openIncidentId === incident.id ? "Close discussion" : "Open discussion"}</span>
                    <MessageCircle className="h-3.5 w-3.5" />
                    {
                      comments.filter(
                        (comment) => comment.incidentId === incident.id,
                      ).length
                    }{" "}
                    comment
                    {comments.filter(
                      (comment) => comment.incidentId === incident.id,
                    ).length === 1
                      ? ""
                      : "s"}
                    {incident.status === "resolved"
                      ? " · resolution notes"
                      : ""}
                    <ChevronDown className={`ml-auto h-4 w-4 transition-transform ${openIncidentId === incident.id ? "rotate-180" : ""}`} />
                  </button>
                  {openIncidentId === incident.id && (
                    <div id={`discussion-${incident.id}`} className="space-y-3">
                      {!comments.some((comment) => comment.incidentId === incident.id) ? <p className="text-sm text-board-muted">No updates yet. Add the first update below.</p> : null}
                      {comments
                        .filter(
                          (comment) =>
                            comment.incidentId === incident.id &&
                            !comment.parentId,
                        )
                        .map((comment) => (
                          <CommentThread
                            key={comment.id}
                            comment={comment}
                            comments={comments.filter(
                              (item) => item.incidentId === incident.id,
                            )}
                            reactions={reactions}
                            timeZone={orgTimezone}
                            onReply={(commentId) =>
                              setReplyTargets((current) => ({
                                ...current,
                                [incident.id]: commentId,
                              }))
                            }
                            onReact={reactToComment}
                            disabled={!canWrite}
                            viewerId={snapshotRead.value?.viewerId ?? ""}
                          />
                        ))}
                      {replyTargets[incident.id] ? (
                        <div className="flex items-center justify-between rounded-lg border border-fire-500/20 bg-fire-500/[0.04] px-3 py-2 text-xs text-board-muted">
                          <span>Replying in thread</span>
                          <button
                            type="button"
                            onClick={() =>
                              setReplyTargets((current) => ({
                                ...current,
                                [incident.id]: null,
                              }))
                            }
                            className="min-h-11 px-2 text-fire-400"
                          >
                            Cancel reply
                          </button>
                        </div>
                      ) : null}
                      {objectionableContentReason(commentDrafts[incident.id] ?? "") && <p role="alert" className="text-sm text-red-300">{objectionableContentReason(commentDrafts[incident.id] ?? "")}</p>}
                      <div className="flex items-end gap-2">
                        <textarea
                          aria-label={`Update for ${incident.description}`}
                          value={commentDrafts[incident.id] ?? ""}
                          onChange={(event) =>
                            setCommentDrafts((current) => ({
                              ...current,
                              [incident.id]: event.target.value,
                            }))
                          }
                          placeholder={
                            incident.status === "resolved"
                              ? "Add a resolution note or follow-up…"
                              : replyTargets[incident.id]
                                ? "Write a reply…"
                                : "Add an update…"
                          }
                          rows={2}
                          maxLength={2000}
                          className="min-w-0 flex-1 resize-none rounded-lg border border-board-border bg-board-bg px-3 py-2 text-base sm:text-sm text-board-text outline-none placeholder:text-board-muted/50 focus:border-fire-500/40"
                        />
                        <button
                          type="button"
                          disabled={
                            !canWrite ||
                            !!objectionableContentReason(commentDrafts[incident.id] ?? "") ||
                            !commentDrafts[incident.id]?.trim()
                          }
                          onClick={() => void submitComment(incident.id)}
                          className="min-h-11 min-w-11 rounded-lg bg-fire-500 p-2.5 text-black disabled:opacity-40"
                          aria-label="Post comment"
                        >
                          <Send className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : !loadingIncidents && !snapshotRead.error ? (
          <EmptyState
            icon={ShieldCheck}
            title="No incidents for this date"
            description={
              canReportIncidents
                ? "All clear. Use Report above to log anything that goes wrong during the show — audio dropouts, camera faults, stream issues."
                : "All clear. Issues reported during the show will appear here."
            }
          />
        ) : null}

        <section className="mt-10 border-t border-board-border pt-6">
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-board-muted">
                History
              </p>
              <h2 className="mt-1 text-sm font-semibold text-board-text">
                Previous incidents
              </h2>
            </div>
            <Link
              to="/$slug/production/incidents-history"
              params={{ slug }}
              search={{
                query: "",
                status: "all",
                severity: "all",
                category: "",
                assignee: "",
                from: "",
                to: "",
                sort: "newest",
                page: 1,
              }}
              className="inline-flex min-h-11 items-center text-xs font-medium text-fire-400 hover:text-fire-300"
            >
              View and filter all
            </Link>
          </div>
          {recentHistory.incidents.length > 0 ? (
            <div className="overflow-hidden rounded-xl border border-board-border bg-board-card">
              {recentHistory.incidents.map((incident) => (
                <Link
                  key={incident.id}
                  to="/$slug/production/incidents"
                  params={{ slug }}
                  search={{ incident: incident.id, date: incident.serviceDate, show: incident.showId ?? undefined }}
                  className="flex min-h-16 items-center gap-3 border-t border-board-border/70 p-4 first:border-t-0 hover:bg-board-bg/55"
                >
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 [overflow-wrap:anywhere] text-sm text-board-text">{incident.description}</p>
                    <p className="mt-1 text-xs text-board-muted">{incident.serviceDate} · {incident.category} · {incident.commentCount} comments</p>
                    <p className={`mt-1 text-xs capitalize ${incident.status === "open" ? "text-red-400" : "text-green-400"}`}>{incident.status} · {incident.assignedName || "Unassigned"}</p>
                  </div>
                  <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-board-muted" />
                </Link>
              ))}
            </div>
          ) : (
            <div className="min-h-11 rounded-xl border border-dashed border-board-border px-4 py-8 text-center">
              <p className="text-xs text-board-muted">
                No previous incidents yet.
              </p>
            </div>
          )}
        </section>
      </div>

      <Dialog open={showForm && canReportIncidents && !!showId} onOpenChange={setShowForm}>
        <DialogContent className="max-h-[85vh] overflow-y-auto border-board-border bg-board-card text-board-text sm:max-w-lg">
          <DialogHeader><DialogTitle>Report incident</DialogTitle><DialogDescription>Log an issue for {formatDisplayDate(serviceDate)}.</DialogDescription></DialogHeader>
          <ReadFailureNotice error={snapshotRead.error} refreshing={snapshotRead.refreshing} retry={snapshotRead.retry} label="Retry incidents" />
          {writeNotice}
          <form onSubmit={handleAdd} className="space-y-4">
            <label htmlFor="incident-description" className="block text-sm font-medium">What happened?</label>
            <textarea
              id="incident-description"
              maxLength={10_000}
              disabled={writeLocked}
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
              placeholder="What happened?"
              rows={3}
              className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-sm text-board-text placeholder:text-board-muted/50 outline-none focus:border-fire-500/50 focus:ring-1 focus:ring-fire-500/20 resize-none"
            />
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="sr-only" htmlFor="incident-category">Category</label>
              <select
                id="incident-category"
                disabled={writeLocked}
                value={form.category}
                onChange={(e) => setForm({ ...form, category: incidentCategorySchema.parse(e.target.value) })}
                className="min-h-11 min-w-0 px-3 py-2.5 rounded-xl bg-board-bg border border-board-border text-sm text-board-text outline-none focus:border-fire-500/50"
              >
                {INCIDENT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <label className="sr-only" htmlFor="incident-severity">Severity</label>
              <select
                id="incident-severity"
                disabled={writeLocked}
                value={form.severity}
                onChange={(e) => setForm({ ...form, severity: incidentSeveritySchema.parse(e.target.value) })}
                className="min-h-11 min-w-0 px-3 py-2.5 rounded-xl bg-board-bg border border-board-border text-sm text-board-text outline-none focus:border-fire-500/50"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
              <label className="sr-only" htmlFor="incident-reporter">Reported by</label>
              <input
                id="incident-reporter"
                maxLength={200}
                disabled={writeLocked}
                value={form.reportedBy}
                onChange={(e) =>
                  setForm({ ...form, reportedBy: e.target.value })
                }
                placeholder="Reported by..."
                className="min-h-11 min-w-0 px-3 py-2.5 rounded-xl bg-board-bg border border-board-border text-sm text-board-text placeholder:text-board-muted/50 outline-none focus:border-fire-500/50"
              />
            </div>
            <div className="flex justify-end gap-2 border-t border-board-border pt-4">
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="min-h-11 rounded-xl border border-board-border px-4 py-2.5 text-sm font-medium text-board-muted hover:text-board-text"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!canWrite || !form.description.trim()}
                className="min-h-11 rounded-xl px-4 py-2.5 text-sm font-semibold text-black transition-all hover:shadow-lg hover:shadow-fire-500/20 active:scale-[0.98] disabled:opacity-50"
                style={{
                  background:
                    "linear-gradient(135deg, #FFC107 0%, #FF8F00 100%)",
                }}
              >
                Submit report
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      {ConfirmDialogEl}
      <Dialog open={blocker.status === "blocked"} onOpenChange={open => { if (!open) blocker.reset?.(); }}>
        <DialogContent><DialogHeader><DialogTitle>Leave these incidents?</DialogTitle><DialogDescription>An unconfirmed save may still complete. Leaving discards your local drafts and retry controls. Review this incident log when you return.</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => blocker.reset?.()}>Stay</Button><Button onClick={() => blocker.proceed?.()}>Leave incident log</Button></DialogFooter></DialogContent>
      </Dialog>
    </div>
  );
}

function CommentThread({
  comment,
  comments,
  reactions,
  onReply,
  onReact,
  timeZone,
  disabled,
  viewerId,
}: {
  comment: IncidentComment;
  comments: IncidentComment[];
  reactions: ContentReaction[];
  timeZone: string;
  disabled: boolean;
  viewerId: string;
  onReply: (commentId: string) => void;
  onReact: (
    commentId: string,
    emoji: string,
  ) => Promise<void>;
}) {
  const [reactionPickerFor, setReactionPickerFor] = useState<string | null>(
    null,
  );
  const [customReaction, setCustomReaction] = useState("");
  const renderComment = (item: IncidentComment, depth = 0): ReactNode => {
    const itemReactions = reactions.filter(
      (reaction) => reaction.targetId === item.id,
    );
    const children = comments.filter(
      (candidate) => candidate.parentId === item.id,
    );
    const parent = item.parentId
      ? comments.find((candidate) => candidate.id === item.parentId)
      : null;
    return (
      <Fragment key={item.id}>
        <div
          className={
            depth ? "ml-3 border-l-2 border-board-border pl-3 sm:ml-4" : ""
          }
        >
          <div className="rounded-lg bg-board-bg/55 px-3 py-2">
            {parent ? (
              <div className="mb-2 rounded-md border-l-2 border-fire-500/50 bg-board-card/60 px-2 py-1.5 text-xs text-board-muted">
                <span className="font-semibold text-fire-300">
                  Replying to {parent.authorName}
                </span>
                <p className="mt-0.5 truncate">{parent.body}</p>
              </div>
            ) : null}
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-board-text">
                {item.authorName}
              </span>
              <span className="text-xs text-board-muted">
                {formatTime(new Date(item.createdAt), "12hr", timeZone)}
              </span>
            </div>
            <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-board-text/80">
              {item.body}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1">
              {[...new Set(itemReactions.map((reaction) => reaction.emoji))].map((emoji) => {
                const count = itemReactions.filter(
                  (reaction) => reaction.emoji === emoji,
                ).length;
                return (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => void onReact(item.id, emoji)}
                    aria-label={`React ${emoji}`}
                    disabled={disabled}
                    aria-pressed={itemReactions.some(reaction => reaction.emoji === emoji && reaction.userId === viewerId)}
                    className="min-h-11 min-w-11 rounded-full border border-board-border px-2 py-1 text-xs text-board-muted hover:border-fire-500/30 hover:text-board-text"
                  >
                    {emoji}
                    {count ? ` ${count}` : ""}
                  </button>
                );
              })}
              <span className="relative">
                <button
                  type="button"
                  onClick={() =>
                    setReactionPickerFor((current) =>
                      current === item.id ? null : item.id,
                    )
                  }
                  aria-label="Add reaction"
                  disabled={disabled}
                  className="min-h-11 min-w-11 rounded-md p-1 text-board-muted hover:bg-board-border/60 hover:text-board-text"
                >
                  <SmilePlus className="h-3.5 w-3.5" />
                </button>
                {reactionPickerFor === item.id ? (
                  <span className="fixed inset-x-4 bottom-4 z-40 block max-h-[50vh] overflow-auto sm:absolute sm:inset-x-auto sm:bottom-auto sm:left-0 sm:top-full sm:mt-1 sm:w-80 rounded-lg border border-board-border bg-board-card p-2 shadow-xl">
                    <span className="grid max-h-40 grid-cols-5 sm:grid-cols-6 gap-1 overflow-y-auto">{REACTION_EMOJIS.map((emoji) => (
                      <button
                        key={emoji}
                        type="button"
                        onClick={() => {
                          setReactionPickerFor(null);
                          void onReact(item.id, emoji);
                        }}
                        className="min-h-11 min-w-11 rounded-md p-1.5 text-base hover:bg-board-border/60"
                        aria-label={`React ${emoji}`}
                    disabled={disabled}
                    aria-pressed={itemReactions.some(reaction => reaction.emoji === emoji && reaction.userId === viewerId)}
                      >
                        {emoji}
                      </button>
                    ))}</span>
                    <form className="mt-2 flex gap-1 border-t border-board-border pt-2" onSubmit={(event) => { event.preventDefault(); if (!isEmojiReaction(customReaction)) return; setReactionPickerFor(null); setCustomReaction(""); void onReact(item.id, customReaction); }}>
                      <input aria-label="Type or paste any emoji" value={customReaction} onChange={(event) => setCustomReaction(event.target.value)} maxLength={32} placeholder="Any emoji" className="min-w-0 flex-1 rounded-md border border-board-border bg-board-bg px-2 py-1 text-xs text-board-text outline-none focus:border-fire-400/50" />
                      <button type="submit" disabled={disabled || !isEmojiReaction(customReaction)} className="min-h-11 rounded-md bg-fire-500 px-2 text-xs font-semibold text-black disabled:opacity-40">Add</button>
                    </form>
                  </span>
                ) : null}
              </span>
              <button
                type="button"
                onClick={() => onReply(item.id)}
                disabled={disabled}
                className="min-h-11 px-2 ml-1 text-xs font-medium text-board-muted hover:text-fire-400"
              >
                Reply
              </button>
            </div>
          </div>
        </div>
        {children.map((child) => renderComment(child, depth + 1))}
      </Fragment>
    );
  };
  return <div className="flex flex-col gap-2">{renderComment(comment)}</div>;
}
