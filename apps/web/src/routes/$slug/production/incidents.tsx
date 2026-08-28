import { createFileRoute, Link } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  AlertTriangle,
  ShieldCheck,
  Trash2,
  X,
  MessageCircle,
  Send,
  History,
  SmilePlus,
} from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { getIncidents, addIncident, deleteIncident } from "@/lib/data";
import {
  hasAnyEffectivePermission,
  hasEffectivePermission,
} from "@/lib/app-permissions";
import { getTodayDateString, formatTime } from "@/lib/utils";
import { formatServicePickerLabel } from "@/lib/service-picker";
import { getOrgSettings } from "@/lib/settings";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { useServiceDateRollover } from "@/hooks/useServiceDateRollover";
import { useCueSheetSync } from "@/hooks/useCueSheetSync";
import {
  addIncidentComment,
  getIncidentComments,
  type IncidentComment,
} from "@/lib/incident-comments";
import { getIncidentHistory } from "@/lib/incident-history";
import { getRundownOpeningDate } from "@/lib/rundown";
import {
  getContentReactions,
  REACTION_EMOJIS,
  toggleContentReaction,
  type ContentReaction,
} from "@/lib/content-reactions";

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

type IncidentItem = {
  id: string;
  category: string;
  severity: string;
  description: string;
  reportedBy: string;
  timestamp: string;
  status: string;
  assignedTo: string | null;
  assignedName: string;
  acknowledgedAt: string | null;
};

function normalizeIncident(incident: {
  id: string;
  category: string;
  severity: string;
  description: string;
  reportedBy: string;
  timestamp: Date | string;
  status?: string;
  assignedTo?: string | null;
  assignedName?: string | null;
  acknowledgedAt?: Date | string | null;
}): IncidentItem {
  return {
    id: incident.id,
    category:
      CATEGORIES.find(
        (category) =>
          category.toLowerCase() === incident.category.trim().toLowerCase(),
      ) ?? incident.category,
    severity: incident.severity,
    description: incident.description,
    reportedBy: incident.reportedBy,
    timestamp:
      incident.timestamp instanceof Date
        ? incident.timestamp.toISOString()
        : incident.timestamp,
    status: incident.status ?? "open",
    assignedTo: incident.assignedTo ?? null,
    assignedName: incident.assignedName ?? "",
    acknowledgedAt:
      incident.acknowledgedAt instanceof Date
        ? incident.acknowledgedAt.toISOString()
        : (incident.acknowledgedAt ?? null),
  };
}

const SEVERITY_COLORS: Record<string, string> = {
  low: "bg-blue-500/15 text-blue-400 border-blue-500/25",
  medium: "bg-yellow-500/15 text-yellow-400 border-yellow-500/25",
  high: "bg-orange-500/15 text-orange-400 border-orange-500/25",
  critical: "bg-red-500/15 text-red-400 border-red-500/25",
};

const CATEGORIES = [
  "Audio",
  "Video",
  "Lighting",
  "Network",
  "Power",
  "Software",
  "Hardware",
  "Other",
];

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
  loader: async ({ context, deps }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(
      context.role,
      ["incidents:report", "incidents:access"],
      context.slug,
      context.orgId,
    );
    const settings = await getOrgSettings({ data: { orgId: context.orgId } });
    const today = getTodayDateString(settings["org-timezone"]);
    const opening = await getRundownOpeningDate({
      data: { orgId: context.orgId, today, serviceDate: deps.date, showId: deps.show },
    });
    const serviceDate = opening.serviceDate;
    const showId = opening.showId;
    const [incidents, comments, recentHistory] = await Promise.all([
      getIncidents({ data: { orgId: context.orgId, serviceDate, showId } }),
      getIncidentComments({ data: { orgId: context.orgId, serviceDate, showId } }),
      getIncidentHistory({
        data: {
          orgId: context.orgId,
          status: "all",
          severity: "all",
          sort: "newest",
          to: shiftDate(getTodayDateString(settings["org-timezone"]), -1),
          page: 1,
          pageSize: 10,
        },
      }),
    ]);
    return {
      incidents: incidents.map(normalizeIncident),
      orgId: context.orgId,
      role: context.role,
      grantedPermissions: context.grantedPermissions,
      orgTimezone: settings["org-timezone"],
      initialServiceDate: serviceDate,
      initialShowId: showId ?? null,
      shows: opening.shows,
      comments,
      recentHistory,
    };
  },
  component: IncidentsPage,
});

function IncidentsPage() {
  const { incident: focusedIncidentId } = Route.useSearch();
  const { slug } = Route.useParams();
  const {
    incidents: initialIncidents,
    comments: initialComments,
    recentHistory,
    orgId,
    role,
    grantedPermissions,
    orgTimezone,
    initialServiceDate,
    initialShowId,
    shows,
  } = Route.useLoaderData();
  const [showId, setShowId] = useState<string | null>(initialShowId);
  const [serviceDate, setServiceDate] = useState(initialServiceDate);
  const [incidents, setIncidents] = useState(initialIncidents);
  const [loadingIncidents, setLoadingIncidents] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [comments, setComments] = useState<IncidentComment[]>(initialComments);
  const [openComments, setOpenComments] = useState<Set<string>>(() =>
    focusedIncidentId ? new Set([focusedIncidentId]) : new Set(),
  );
  const [openHistoryIncident, setOpenHistoryIncident] = useState<string | null>(
    null,
  );
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>(
    {},
  );
  const [commentBusy, setCommentBusy] = useState<string | null>(null);
  const [replyTargets, setReplyTargets] = useState<Record<string, string | null>>({});
  const [reactions, setReactions] = useState<ContentReaction[]>([]);
  const [form, setForm] = useState({
    category: "Audio",
    severity: "medium",
    description: "",
    reportedBy: "",
  });
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  const canReportIncidents = hasAnyEffectivePermission(role, grantedPermissions, [
    "incidents:report",
    "incidents:access",
  ]);
  const canManageIncidents = hasEffectivePermission(
    role,
    grantedPermissions,
    "incidents:access",
  );
  const today = getTodayDateString(orgTimezone);

  useEffect(() => {
    if (!focusedIncidentId) return;
    setOpenComments((current) => {
      if (current.has(focusedIncidentId)) return current;
      const next = new Set(current);
      next.add(focusedIncidentId);
      return next;
    });
  }, [focusedIncidentId]);

  const loadIncidents = useCallback(
    async (date: string, targetShowId: string | null) => {
      setLoadingIncidents(true);
      try {
        const [latest, latestComments] = await Promise.all([
          getIncidents({ data: { orgId, serviceDate: date, showId: targetShowId ?? undefined } }),
          getIncidentComments({ data: { orgId, serviceDate: date, showId: targetShowId ?? undefined } }),
        ]);
        setIncidents(latest.map(normalizeIncident));
        setComments(latestComments);
      } finally {
        setLoadingIncidents(false);
      }
    },
    [orgId],
  );

  const { publish: publishIncident } = useCueSheetSync({
    orgId,
    onNote: () => {},
    onColumns: () => {},
    onIncident: (event) => {
      if (event.showId === showId) void loadIncidents(serviceDate, showId);
    },
  });

  useEffect(() => {
    setServiceDate(initialServiceDate);
    setShowId(initialShowId);
    setIncidents(initialIncidents);
    setComments(initialComments);
  }, [initialIncidents, initialComments, initialServiceDate, initialShowId]);

  useEffect(() => {
    if (!showForm) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowForm(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [showForm]);

  useEffect(() => {
    void loadIncidents(serviceDate, showId);
  }, [loadIncidents, serviceDate, showId]);

  useEffect(() => {
    const targetIds = comments.map((comment) => comment.id);
    if (targetIds.length === 0) {
      setReactions([]);
      return;
    }
    void getContentReactions({ data: { orgId, targetType: "incident-comment", targetIds } })
      .then(setReactions)
      .catch(() => setReactions([]));
  }, [comments, orgId]);

  useServiceDateRollover({
    serviceDate,
    timeZone: orgTimezone,
    onTodayChanged: (nextToday) => {
      const nextShow = shows.find((show) => show.serviceDate === nextToday);
      setServiceDate(nextShow?.serviceDate ?? nextToday);
      setShowId(nextShow?.id ?? null);
    },
  });

  const handleDateChange = (direction: number) => {
    const ordered = [...shows].sort((a, b) =>
      `${a.serviceDate}:${a.scheduledStartTime ?? ""}`.localeCompare(`${b.serviceDate}:${b.scheduledStartTime ?? ""}`),
    );
    const index = ordered.findIndex((show) => show.id === showId);
    const next = ordered[index + direction];
    if (!next) return;
    setShowId(next.id);
    setServiceDate(next.serviceDate);
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canReportIncidents) return;
    if (!form.description.trim()) return;
    if (!showId) return;
    await addIncident({ data: { orgId, ...form, serviceDate, showId } });
    publishIncident({
      type: "incident",
      showId,
      incidentId: "new",
      action: "created",
      at: Date.now(),
    });
    setForm({
      category: "Audio",
      severity: "medium",
      description: "",
      reportedBy: "",
    });
    setShowForm(false);
    await loadIncidents(serviceDate, showId);
  };

  const handleDelete = async (id: string) => {
    if (!canManageIncidents) return;
    const ok = await confirm({
      title: "Delete incident",
      description: "Delete this incident? This action cannot be undone.",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    await deleteIncident({ data: { orgId, id } });
    publishIncident({
      type: "incident",
      showId,
      incidentId: id,
      action: "deleted",
      at: Date.now(),
    });
    await loadIncidents(serviceDate, showId);
  };

  const submitComment = async (incidentId: string) => {
    const body = commentDrafts[incidentId]?.trim();
    if (!body) return;
    setCommentBusy(incidentId);
    try {
      const comment = await addIncidentComment({
        data: { orgId, incidentId, parentId: replyTargets[incidentId] ?? null, body },
      });
      setComments((current) => [...current, comment]);
      setCommentDrafts((current) => ({ ...current, [incidentId]: "" }));
      setReplyTargets((current) => ({ ...current, [incidentId]: null }));
      publishIncident({
        type: "incident",
        showId,
        incidentId,
        action: "commented",
        at: Date.now(),
      });
    } finally {
      setCommentBusy(null);
    }
  };

  const reactToComment = async (commentId: string, emoji: (typeof REACTION_EMOJIS)[number]) => {
    await toggleContentReaction({ data: { orgId, targetType: "incident-comment", targetId: commentId, emoji } });
    const targetIds = comments.map((comment) => comment.id);
    setReactions(await getContentReactions({ data: { orgId, targetType: "incident-comment", targetIds } }));
  };

  return (
    <div className="h-full overflow-auto">
      <div className="sticky top-0 z-10 bg-board-bg/80 backdrop-blur-xl border-b border-board-border px-6 py-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-board-text">
            Incident Log
          </h1>
          <div className="flex items-center gap-3">
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
              className="flex items-center gap-1.5 rounded-lg border border-board-border bg-board-card px-3 py-1.5 text-xs font-medium text-board-muted transition-colors hover:border-fire-500/30 hover:text-board-text"
            >
              <History className="h-3.5 w-3.5" />
              History
            </Link>
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleDateChange(-1)}
                className="p-1.5 rounded-lg hover:bg-board-border text-board-muted hover:text-board-text transition-colors"
                aria-label="Previous service date"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <select
                value={showId ?? ""}
                onChange={(event) => {
                  const selected = shows.find((show) => show.id === event.target.value);
                  if (!selected) return;
                  setShowId(selected.id);
                  setServiceDate(selected.serviceDate);
                }}
                aria-label="Select show"
                className="min-w-[210px] rounded-lg border border-board-border bg-board-card px-3 py-1.5 text-xs font-medium text-board-text transition-colors hover:border-fire-500/50"
              >
                {!showId && <option value="">No planned show</option>}
                {shows.map((show) => (
                  <option key={show.id} value={show.id}>
                    {formatServicePickerLabel(show, { timeZone: orgTimezone })}
                  </option>
                ))}
              </select>
              <button
                onClick={() => handleDateChange(1)}
                className="p-1.5 rounded-lg hover:bg-board-border text-board-muted hover:text-board-text transition-colors"
                aria-label="Next service date"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
            {canReportIncidents && showId && (
              <button
                onClick={() => setShowForm(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-black transition-all hover:shadow-lg hover:shadow-fire-500/20 active:scale-[0.98]"
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
      </div>

      <div className="p-6 max-w-3xl mx-auto">
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fire-400">
              {serviceDate === today ? "Today" : "Selected date"}
            </p>
            <h2 className="mt-1 text-sm font-semibold text-board-text">
              {serviceDate === today ? "Current incidents" : "Incident details"}
            </h2>
          </div>
          <span className="text-[11px] text-board-muted">
            {formatDisplayDate(serviceDate)}
          </span>
        </div>
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
                ref={(node) => {
                  if (node && incident.id === focusedIncidentId)
                    window.setTimeout(
                      () =>
                        node.scrollIntoView({
                          behavior: "smooth",
                          block: "center",
                        }),
                      80,
                    );
                }}
                className={`group p-4 rounded-xl bg-board-card border transition-all ${incident.id === focusedIncidentId ? "border-fire-500/70 ring-2 ring-fire-500/15" : "border-board-border hover:border-fire-500/20"}`}
              >
                <div
                  className="flex cursor-pointer items-start justify-between gap-3 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-fire-500/50"
                  role="button"
                  tabIndex={0}
                  aria-expanded={openComments.has(incident.id)}
                  onClick={() =>
                    setOpenComments((current) => {
                      const next = new Set(current);
                      next.has(incident.id)
                        ? next.delete(incident.id)
                        : next.add(incident.id);
                      return next;
                    })
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setOpenComments((current) => {
                        const next = new Set(current);
                        next.has(incident.id)
                          ? next.delete(incident.id)
                          : next.add(incident.id);
                        return next;
                      });
                    }
                  }}
                >
                  <div className="flex items-start gap-3">
                    <AlertTriangle
                      className={`w-4 h-4 mt-0.5 shrink-0 ${incident.severity === "critical" ? "text-red-400" : incident.severity === "high" ? "text-orange-400" : "text-yellow-400"}`}
                    />
                    <div>
                      <p className="text-sm text-board-text">
                        {incident.description}
                      </p>
                      <div className="flex items-center gap-2 mt-2">
                        <span
                          className={`text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded border ${SEVERITY_COLORS[incident.severity] || SEVERITY_COLORS.medium}`}
                        >
                          {incident.severity}
                        </span>
                        <span className="text-[10px] text-board-muted bg-board-bg px-1.5 py-0.5 rounded border border-board-border">
                          {incident.category}
                        </span>
                        {incident.reportedBy && (
                          <span className="text-[10px] text-board-muted">
                            by {incident.reportedBy}
                          </span>
                        )}
                        {incident.timestamp && (
                          <span className="text-[10px] text-board-muted">
                            {formatTime(new Date(incident.timestamp))}
                          </span>
                        )}
                        <span
                          className={`text-[10px] font-medium ${incident.status === "resolved" ? "text-green-400" : "text-board-muted"}`}
                        >
                          {incident.status}
                        </span>
                      </div>
                      <p
                        className={`mt-2 text-[11px] ${incident.assignedTo ? "text-board-text" : "text-red-400"}`}
                      >
                        {incident.assignedTo
                          ? `Assigned to ${incident.assignedName || "team member"}${incident.acknowledgedAt ? " · acknowledged" : " · awaiting acknowledgement"}`
                          : "Unassigned"}
                      </p>
                    </div>
                  </div>
                  {canManageIncidents && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleDelete(incident.id);
                      }}
                      className="rounded-lg p-2 text-board-muted opacity-100 transition-all hover:bg-red-500/20 hover:text-red-400 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus-visible:opacity-100"
                      aria-label={`Delete incident: ${incident.description}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                <div className="mt-3 border-t border-board-border/60 pt-3">
                  <button
                    type="button"
                    onClick={() =>
                      setOpenComments((current) => {
                        const next = new Set(current);
                        next.has(incident.id)
                          ? next.delete(incident.id)
                          : next.add(incident.id);
                        return next;
                      })
                    }
                    className="flex items-center gap-1.5 text-[11px] font-medium text-board-muted hover:text-board-text"
                  >
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
                  </button>
                  {openComments.has(incident.id) && (
                    <div className="mt-3 space-y-3">
                      {comments
                        .filter((comment) => comment.incidentId === incident.id && !comment.parentId)
                        .map((comment) => (
                          <CommentThread
                            key={comment.id}
                            comment={comment}
                            comments={comments.filter((item) => item.incidentId === incident.id)}
                            reactions={reactions}
                            onReply={(commentId) => setReplyTargets((current) => ({ ...current, [incident.id]: commentId }))}
                            onReact={reactToComment}
                          />
                        ))}
                      {replyTargets[incident.id] ? (
                        <div className="flex items-center justify-between rounded-lg border border-fire-500/20 bg-fire-500/[0.04] px-3 py-2 text-[10px] text-board-muted">
                          <span>Replying in thread</span>
                          <button type="button" onClick={() => setReplyTargets((current) => ({ ...current, [incident.id]: null }))} className="text-fire-400">Cancel reply</button>
                        </div>
                      ) : null}
                      <div className="flex items-end gap-2">
                        <textarea
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
                          className="min-w-0 flex-1 resize-none rounded-lg border border-board-border bg-board-bg px-3 py-2 text-xs text-board-text outline-none placeholder:text-board-muted/50 focus:border-fire-500/40"
                        />
                        <button
                          type="button"
                          disabled={
                            commentBusy === incident.id ||
                            !commentDrafts[incident.id]?.trim()
                          }
                          onClick={() => void submitComment(incident.id)}
                          className="rounded-lg bg-fire-500 p-2.5 text-black disabled:opacity-40"
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
        ) : (
          <EmptyState
            icon={ShieldCheck}
            title="No incidents for this date"
            description={
              canReportIncidents
                ? "All clear. Use Report above to log anything that goes wrong during the show — audio dropouts, camera faults, stream issues."
                : "All clear. Issues reported during the show will appear here."
            }
          />
        )}

        <section className="mt-10 border-t border-board-border pt-6">
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-board-muted">
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
              className="text-[11px] font-medium text-fire-400 hover:text-fire-300"
            >
              View and filter all
            </Link>
          </div>
          {recentHistory.incidents.length > 0 ? (
            <div className="overflow-hidden rounded-xl border border-board-border bg-board-card">
              {recentHistory.incidents.map((incident) => (
                <div
                  key={incident.id}
                  className="border-t border-board-border/70 first:border-t-0"
                >
                  <button
                    type="button"
                    aria-expanded={openHistoryIncident === incident.id}
                    onClick={() =>
                      setOpenHistoryIncident((current) =>
                        current === incident.id ? null : incident.id,
                      )
                    }
                    className="grid w-full gap-2 p-4 text-left hover:bg-board-bg/55 sm:grid-cols-[100px_minmax(0,1fr)_auto]"
                  >
                    <div>
                      <p className="text-xs font-medium text-board-text">
                        {incident.serviceDate}
                      </p>
                      <p className="mt-1 text-[10px] text-board-muted">
                        {incident.category}
                      </p>
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm text-board-text">
                        {incident.description}
                      </p>
                      <p className="mt-1 text-[10px] text-board-muted">
                        {incident.assignedName || "Unassigned"} ·{" "}
                        {incident.commentCount} comment
                        {incident.commentCount === 1 ? "" : "s"}
                      </p>
                    </div>
                    <span
                      className={`self-start text-[9px] font-semibold uppercase ${incident.status === "open" ? "text-red-400" : "text-green-400"}`}
                    >
                      {incident.status}
                    </span>
                  </button>
                  {openHistoryIncident === incident.id && (
                    <div className="border-t border-board-border/50 bg-board-bg/35 px-4 py-3 text-xs text-board-muted sm:pl-[120px]">
                      <p>
                        Reported by{" "}
                        <span className="text-board-text">
                          {incident.reportedBy || "Unknown"}
                        </span>
                      </p>
                      <p className="mt-1">
                        Severity{" "}
                        <span className="capitalize text-board-text">
                          {incident.severity}
                        </span>
                        {incident.resolvedBy ? (
                          <>
                            {" "}
                            · Resolved by{" "}
                            <span className="text-board-text">
                              {incident.resolvedBy}
                            </span>
                          </>
                        ) : null}
                      </p>
                      <Link
                        to="/$slug/production/incidents"
                        params={{ slug }}
                        search={{
                          incident: incident.id,
                          date: incident.serviceDate,
                          show: incident.showId ?? undefined,
                        }}
                        className="mt-3 inline-flex text-[11px] font-semibold text-fire-400 hover:text-fire-300"
                      >
                        Open full incident and comments
                      </Link>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-board-border px-4 py-8 text-center">
              <p className="text-xs text-board-muted">
                No previous incidents yet.
              </p>
            </div>
          )}
        </section>
      </div>

      {showForm && canReportIncidents && showId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-md"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowForm(false);
          }}
        >
          <form
            onSubmit={handleAdd}
            role="dialog"
            aria-modal="true"
            aria-labelledby="report-incident-title"
            className="w-full max-w-lg space-y-4 rounded-2xl border border-board-border bg-board-card p-5 shadow-2xl sm:p-6"
          >
            <div className="flex items-center justify-between">
              <div>
                <h3
                  id="report-incident-title"
                  className="text-base font-semibold text-board-text"
                >
                  Report incident
                </h3>
                <p className="mt-1 text-xs text-board-muted">
                  Log an issue for {formatDisplayDate(serviceDate)}.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="rounded-lg p-2 text-board-muted hover:bg-board-border hover:text-board-text"
                aria-label="Close report incident"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <textarea
              autoFocus
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
              placeholder="What happened?"
              rows={3}
              className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-sm text-board-text placeholder:text-board-muted/50 outline-none focus:border-fire-500/50 focus:ring-1 focus:ring-fire-500/20 resize-none"
            />
            <div className="grid gap-3 sm:grid-cols-3">
              <select
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                className="px-3 py-2.5 rounded-xl bg-board-bg border border-board-border text-sm text-board-text outline-none focus:border-fire-500/50"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <select
                value={form.severity}
                onChange={(e) => setForm({ ...form, severity: e.target.value })}
                className="px-3 py-2.5 rounded-xl bg-board-bg border border-board-border text-sm text-board-text outline-none focus:border-fire-500/50"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
              <input
                value={form.reportedBy}
                onChange={(e) =>
                  setForm({ ...form, reportedBy: e.target.value })
                }
                placeholder="Reported by..."
                className="px-3 py-2.5 rounded-xl bg-board-bg border border-board-border text-sm text-board-text placeholder:text-board-muted/50 outline-none focus:border-fire-500/50"
              />
            </div>
            <div className="flex justify-end gap-2 border-t border-board-border pt-4">
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="rounded-xl border border-board-border px-4 py-2.5 text-sm font-medium text-board-muted hover:text-board-text"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!form.description.trim()}
                className="rounded-xl px-4 py-2.5 text-sm font-semibold text-black transition-all hover:shadow-lg hover:shadow-fire-500/20 active:scale-[0.98] disabled:opacity-50"
                style={{
                  background:
                    "linear-gradient(135deg, #FFC107 0%, #FF8F00 100%)",
                }}
              >
                Submit report
              </button>
            </div>
          </form>
        </div>
      )}
      {ConfirmDialogEl}
    </div>
  );
}

function CommentThread({
  comment,
  comments,
  reactions,
  onReply,
  onReact,
}: {
  comment: IncidentComment;
  comments: IncidentComment[];
  reactions: ContentReaction[];
  onReply: (commentId: string) => void;
  onReact: (commentId: string, emoji: (typeof REACTION_EMOJIS)[number]) => Promise<void>;
}) {
  const [reactionPickerFor, setReactionPickerFor] = useState<string | null>(null);
  const renderComment = (item: IncidentComment, depth = 0): ReactNode => {
    const itemReactions = reactions.filter((reaction) => reaction.targetId === item.id);
    const children = comments.filter((candidate) => candidate.parentId === item.id);
    return (
      <div key={item.id} className={depth ? "ml-4 border-l-2 border-board-border pl-3 sm:ml-6" : ""}>
        <div className="rounded-lg bg-board-bg/55 px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold text-board-text">{item.authorName}</span>
            <span className="text-[9px] text-board-muted">{formatTime(new Date(item.createdAt))}</span>
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-board-text/80">{item.body}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1">
          {REACTION_EMOJIS.filter((emoji) => itemReactions.some((reaction) => reaction.emoji === emoji)).map((emoji) => {
            const count = itemReactions.filter((reaction) => reaction.emoji === emoji).length;
            return (
              <button key={emoji} type="button" onClick={() => void onReact(item.id, emoji)} aria-label={`React ${emoji}`} className="rounded-full border border-board-border px-1.5 py-0.5 text-[10px] text-board-muted hover:border-fire-500/30 hover:text-board-text">
                {emoji}{count ? ` ${count}` : ""}
              </button>
            );
          })}
          <span className="relative">
            <button type="button" onClick={() => setReactionPickerFor((current) => current === item.id ? null : item.id)} aria-label="Add reaction" className="rounded-md p-1 text-board-muted hover:bg-board-border/60 hover:text-board-text"><SmilePlus className="h-3.5 w-3.5" /></button>
            {reactionPickerFor === item.id ? <span className="absolute left-0 top-full z-20 mt-1 grid max-h-48 w-64 grid-cols-6 gap-1 overflow-y-auto rounded-lg border border-board-border bg-board-card p-2 shadow-xl">{REACTION_EMOJIS.map((emoji) => <button key={emoji} type="button" onClick={() => { setReactionPickerFor(null); void onReact(item.id, emoji); }} className="rounded-md p-1.5 text-base hover:bg-board-border/60" aria-label={`React ${emoji}`}>{emoji}</button>)}</span> : null}
          </span>
            <button type="button" onClick={() => onReply(item.id)} className="ml-1 text-[10px] font-medium text-board-muted hover:text-fire-400">Reply</button>
          </div>
        </div>
        {children.length ? <div className="mt-2 flex flex-col gap-2">{children.map((child) => renderComment(child, depth + 1))}</div> : null}
      </div>
    );
  };
  return <div className="flex flex-col gap-2">{renderComment(comment)}</div>;
}
