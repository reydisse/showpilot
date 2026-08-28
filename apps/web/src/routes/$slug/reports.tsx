import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  ListChecks,
  MessageSquareText,
  Save,
  Search,
  Users,
  X,
} from "lucide-react";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { exportShowReport, type ShowReport } from "@/lib/report";
import { getSchedule } from "@/lib/schedule";
import { getOrgSettings } from "@/lib/settings";
import { getTodayDateString } from "@/lib/utils";
import { saveShowReportNote, type ShowReportLane } from "@/lib/show-report-notes";
import { ContextHelp } from "@/components/ui/context-help";

const PAGE_SIZE = 10;

function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() + days);
  return value.toISOString().slice(0, 10);
}

function displayDate(date: string) {
  return new Date(`${date}T12:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function duration(start: string | null, end: string | null) {
  if (!start || !end) return "—";
  const elapsed = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 12 * 60 * 60 * 1000) {
    return "Needs review";
  }
  const minutes = Math.round(elapsed / 60000);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function plannedDuration(milliseconds: number) {
  const minutes = Math.round(milliseconds / 60000);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export const Route = createFileRoute("/$slug/reports")({
  validateSearch: (search: Record<string, unknown>) => ({
    date: typeof search.date === "string" ? search.date : undefined,
    show: typeof search.show === "string" ? search.show : undefined,
    page:
      typeof search.page === "number" && search.page > 0
        ? Math.floor(search.page)
        : 1,
  }),
  // The report list is loaded once. Selecting a row or page is local UI
  // state reflected in the URL, not a reason to reload the whole route.
  loaderDeps: () => ({}),
  pendingComponent: () => <PageSkeleton />,
  loader: async ({ context }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(
      context.role,
      "schedule:view",
      context.slug,
      context.orgId,
    );
    const settings = await getOrgSettings({ data: { orgId: context.orgId } });
    const today = getTodayDateString(settings["org-timezone"]);
    const schedule = await getSchedule({
      data: {
        orgId: context.orgId,
        from: shiftDate(today, -365),
        to: today,
      },
    });
    return {
      services: [...schedule.services].reverse(),
      orgId: context.orgId,
    };
  },
  component: ReportsPage,
});

function ReportsPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<ShowReport | null>(null);
  const [detailShowId, setDetailShowId] = useState<string | null>(() =>
    data.services.find((item) => item.id === search.show)?.id ??
    data.services.find((item) => item.serviceDate === search.date)?.id ??
    null,
  );
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<"pdf" | "csv" | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const filtered = useMemo(
    () =>
      data.services.filter((service) =>
        `${service.name} ${service.serviceDate}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
      ),
    [data.services, query],
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(search.page, pageCount);
  const rows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const selected = data.services.find((service) => service.id === detailShowId);
  const detailDate = selected?.serviceDate ?? null;

  useEffect(() => {
    if (search.page <= pageCount) return;
    void navigate({ search: { ...search, page: pageCount }, replace: true });
  }, [navigate, pageCount, search]);

  useEffect(() => {
    if (!detailDate || detail || detailLoading || detailError) return;
    let active = true;
    setDetailLoading(true);
    void exportShowReport({
      data: { orgId: data.orgId, serviceDate: detailDate, showId: detailShowId ?? undefined },
    })
      .then((result) => {
        if (active) setDetail(result);
      })
      .catch(() => {
        if (active) setDetailError("The report details could not be loaded.");
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => {
      active = false;
    };
  }, [data.orgId, detail, detailDate, detailError, detailShowId]);

  const openReport = async (showId: string, serviceDate: string) => {
    setDetailShowId(showId);
    setDetail(null);
    setDetailError(null);
    setExportError(null);
    setDetailLoading(true);
    void navigate({ search: { date: serviceDate, show: showId, page }, replace: true });
    try {
      setDetail(
        await exportShowReport({ data: { orgId: data.orgId, serviceDate, showId } }),
      );
    } catch {
      setDetailError("The report details could not be loaded.");
    } finally {
      setDetailLoading(false);
    }
  };

  const closeReport = () => {
    setDetailShowId(null);
    setDetail(null);
    setDetailError(null);
    setExportError(null);
    void navigate({ search: { date: undefined, show: undefined, page }, replace: true });
  };

  const exportReport = async (format: "pdf" | "csv") => {
    if (!detailDate) return;
    setExporting(format);
    setExportError(null);
    try {
      const report =
        detail ??
        (await exportShowReport({
          data: { orgId: data.orgId, serviceDate: detailDate, showId: detailShowId ?? undefined },
        }));
      const exports = await import("@/lib/rundown-export");
      if (format === "pdf") await exports.exportRundownPdf(report);
      else exports.exportRundownCsv(report);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "The export could not be generated.");
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="h-full overflow-auto">
      <header className="sticky top-0 z-10 border-b border-board-border bg-board-bg/90 px-4 py-3 backdrop-blur-xl md:px-6">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold text-board-text">Show reports</h1>
          <ContextHelp title="Show reports" description="Review what happened during each show, add optional production or technical manager notes, and export the report with those notes included." className="size-7" />
        </div>
      </header>

      <div className="mx-auto max-w-[1500px] p-4 md:p-6">
        <section className="overflow-hidden rounded-xl border border-board-border bg-board-card">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-board-border p-3">
            <label className="relative block w-full max-w-sm">
              <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-board-muted" />
              <input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  void navigate({
                    search: { date: undefined, show: undefined, page: 1 },
                    replace: true,
                  });
                }}
                placeholder="Search reports"
                className="w-full rounded-lg border border-board-border bg-board-bg py-2 pl-9 pr-3 text-xs text-board-text outline-none focus:border-fire-500/50"
              />
            </label>
            <p className="text-[11px] text-board-muted">
              {filtered.length} report{filtered.length === 1 ? "" : "s"}
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left">
              <thead>
                <tr className="border-b border-board-border text-[9px] uppercase tracking-wider text-board-muted">
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Show</th>
                  <th className="px-4 py-3">Actual</th>
                  <th className="px-4 py-3">Rundown</th>
                  <th className="px-4 py-3">Checklist</th>
                  <th className="px-4 py-3">Incidents</th>
                  <th className="px-4 py-3">Crew</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {rows.map((service) => (
                  <tr
                    key={service.id}
                    onClick={() => void openReport(service.id, service.serviceDate)}
                    className="cursor-pointer border-b border-board-border/60 text-xs last:border-0 hover:bg-fire-500/[0.04]"
                  >
                    <td className="px-4 py-3 text-board-text">
                      {displayDate(service.serviceDate)}
                    </td>
                    <td className="max-w-[190px] truncate px-4 py-3 font-medium text-board-text">
                      {service.name}
                    </td>
                    <td className="px-4 py-3 text-board-muted">
                      {duration(service.actualStart, service.actualEnd)}
                    </td>
                    <td className="px-4 py-3 text-board-muted">
                      {service.itemCount
                        ? `${Math.round((service.completedItems / service.itemCount) * 100)}%`
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-board-muted">
                      {service.checklistTotal
                        ? `${Math.round((service.checklistComplete / service.checklistTotal) * 100)}%`
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-board-muted">
                      {service.incidentCount}
                    </td>
                    <td className="px-4 py-3 text-board-muted">
                      {service.crewConfirmed}/{service.crewTotal}
                    </td>
                    <td className="px-4 py-3 text-right text-fire-400">
                      View details
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {!rows.length ? (
            <p className="py-16 text-center text-xs text-board-muted">
              No matching reports.
            </p>
          ) : null}

          {filtered.length > PAGE_SIZE ? (
            <div className="flex items-center justify-between border-t border-board-border px-4 py-3">
              <p className="text-[11px] text-board-muted">
                Page {page} of {pageCount}
              </p>
              <div className="flex gap-2">
                <PageButton
                  label="Previous page"
                  disabled={page === 1}
                  onClick={() =>
                    void navigate({
                      search: { date: undefined, show: undefined, page: page - 1 },
                    })
                  }
                >
                  <ChevronLeft className="h-4 w-4" />
                </PageButton>
                <PageButton
                  label="Next page"
                  disabled={page === pageCount}
                  onClick={() =>
                    void navigate({
                      search: { date: undefined, show: undefined, page: page + 1 },
                    })
                  }
                >
                  <ChevronRight className="h-4 w-4" />
                </PageButton>
              </div>
            </div>
          ) : null}
        </section>
      </div>

      {detailShowId && detailDate ? (
        <ReportDetailModal
          service={selected}
          report={detail}
          loading={detailLoading}
          error={detailError}
          exporting={exporting}
          exportError={exportError}
          onClose={closeReport}
          onExport={exportReport}
          onReportChange={setDetail}
        />
      ) : null}
    </div>
  );
}

function PageButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid h-8 w-8 place-items-center rounded-lg border border-board-border text-board-text disabled:opacity-30"
    >
      {children}
    </button>
  );
}

function ReportDetailModal({
  service,
  report,
  loading,
  error,
  exporting,
  exportError,
  onClose,
  onExport,
  onReportChange,
}: {
  service:
    | ReturnType<typeof Route.useLoaderData>["services"][number]
    | undefined;
  report: ShowReport | null;
  loading: boolean;
  error: string | null;
  exporting: "pdf" | "csv" | null;
  exportError: string | null;
  onClose: () => void;
  onExport: (format: "pdf" | "csv") => void;
  onReportChange: (report: ShowReport) => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Show report details"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 backdrop-blur-md sm:items-center sm:p-5"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="max-h-[95dvh] w-full max-w-4xl overflow-auto rounded-t-2xl border border-board-border bg-board-card shadow-2xl sm:rounded-2xl">
        <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-board-border bg-board-card/95 p-5 backdrop-blur-xl">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-fire-400">
              {service ? displayDate(service.serviceDate) : "Show report"}
            </p>
            <h2 className="mt-1 text-xl font-semibold text-board-text">
              {service?.name || "Report details"}
            </h2>
          </div>
          <button
            aria-label="Close report"
            onClick={onClose}
            className="grid h-9 w-9 place-items-center rounded-lg border border-board-border text-board-muted hover:text-board-text"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {error ? (
          <div className="grid min-h-72 place-items-center px-6 text-center text-sm text-red-300">
            {error}
          </div>
        ) : loading || !report ? (
          <div className="grid min-h-72 place-items-center text-sm text-board-muted">
            Loading full report…
          </div>
        ) : (
          <div className="space-y-5 p-5">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <ReportMetric
                icon={Clock3}
                label="Planned duration"
                value={plannedDuration(report.summary.plannedDurationMs)}
              />
              <ReportMetric
                icon={CheckCircle2}
                label="Rundown complete"
                value={`${report.summary.completedItems}/${report.summary.totalItems}`}
              />
              <ReportMetric
                icon={Users}
                label="Crew positions"
                value={report.crew.length}
              />
              <ReportMetric
                icon={AlertTriangle}
                label="Incidents"
                value={report.incidents.length}
              />
            </div>

            <ManagerNotes
              orgId={report.organization.id}
              report={report}
              onReportChange={onReportChange}
            />

            <DetailSection
              title="Crew"
              icon={Users}
              empty={!report.crew.length}
            >
              {report.crew.map((person, index) => (
                <DetailRow
                  key={`${person.role}-${index}`}
                  title={person.role}
                  detail={person.name}
                  meta={person.status}
                />
              ))}
            </DetailSection>

            <DetailSection
              title="Incidents"
              icon={AlertTriangle}
              empty={!report.incidents.length}
            >
              {report.incidents.map((incident) => (
                <DetailRow
                  key={incident.id}
                  title={`${incident.category} · ${incident.severity}`}
                  detail={incident.description}
                  meta={incident.reportedBy || "Unknown reporter"}
                />
              ))}
            </DetailSection>

            <DetailSection
              title="Checklist"
              icon={ListChecks}
              empty={!report.checklist.length}
            >
              {report.checklist.map((item) => (
                <DetailRow
                  key={item.id}
                  title={item.label}
                  detail={item.category}
                  meta={item.checked ? "Complete" : "Incomplete"}
                />
              ))}
            </DetailSection>

            <div className="flex flex-wrap gap-2 border-t border-board-border pt-5">
              <button
                disabled={Boolean(exporting)}
                onClick={() => onExport("pdf")}
                className="rounded-lg bg-fire-500 px-3 py-2 text-xs font-semibold text-black disabled:opacity-50"
              >
                <Download className="mr-1.5 inline h-3.5 w-3.5" />
                {exporting === "pdf" ? "Generating…" : "Export PDF"}
              </button>
              <button
                disabled={Boolean(exporting)}
                onClick={() => onExport("csv")}
                className="rounded-lg border border-board-border px-3 py-2 text-xs font-medium text-board-text disabled:opacity-50"
              >
                Export CSV
              </button>
            </div>
            {exportError ? <p className="text-xs text-red-300">{exportError}</p> : null}
          </div>
        )}
      </div>
    </div>
  );
}

function ManagerNotes({
  orgId,
  report,
  onReportChange,
}: {
  orgId: string;
  report: ShowReport;
  onReportChange: (report: ShowReport) => void;
}) {
  const writable = report.viewer.writableNoteLanes;
  const ownNote = report.managerNotes.find((note) => note.userId === report.viewer.userId);
  const [lane, setLane] = useState<ShowReportLane>(ownNote?.role ?? writable[0] ?? "pm");
  const [draft, setDraft] = useState(() => ({
    summary: ownNote?.summary ?? "",
    wins: ownNote?.wins ?? "",
    issues: ownNote?.issues ?? "",
    followUps: ownNote?.followUps ?? "",
  }));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const save = async () => {
    setSaving(true);
    setMessage("");
    try {
      const note = await saveShowReportNote({
        data: { orgId, showId: report.showId, role: lane, ...draft },
      });
      const notes = [...report.managerNotes.filter((item) => item.userId !== note.userId), note]
        .sort((left, right) => left.role.localeCompare(right.role) || left.updatedAt.localeCompare(right.updatedAt));
      onReportChange({ ...report, managerNotes: notes });
      setMessage("Notes saved and included in exports.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "The notes could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="overflow-hidden rounded-xl border border-board-border">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-board-border bg-board-bg/40 px-4 py-3">
        <div>
          <h3 className="flex items-center gap-2 text-xs font-semibold text-board-text">
            <MessageSquareText className="h-3.5 w-3.5 text-fire-400" />
            Manager notes
          </h3>
          <p className="mt-1 text-[11px] leading-5 text-board-muted">Optional context from PMs and TMs travels with the PDF and CSV.</p>
        </div>
        {writable.length > 1 ? (
          <div className="flex rounded-lg border border-board-border bg-board-card p-1">
            {writable.map((value) => (
              <button key={value} type="button" onClick={() => setLane(value)} className={`rounded-md px-2.5 py-1 text-[10px] font-semibold ${lane === value ? "bg-fire-500 text-black" : "text-board-muted"}`}>
                {value === "pm" ? "PM note" : "TM note"}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {report.managerNotes.length ? (
        <div className="grid gap-3 border-b border-board-border p-4 md:grid-cols-2">
          {report.managerNotes.map((note) => (
            <article key={note.id} className="rounded-lg border border-board-border/70 bg-board-bg/45 p-3">
              <p className="text-xs font-semibold text-board-text">{note.role === "pm" ? "Production Manager" : "Technical Manager"} · {note.authorName}</p>
              {note.summary ? <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-board-text/85">{note.summary}</p> : null}
              {note.wins ? <NoteLine label="What worked" value={note.wins} /> : null}
              {note.issues ? <NoteLine label="Issues / changes" value={note.issues} /> : null}
              {note.followUps ? <NoteLine label="Follow-up" value={note.followUps} /> : null}
            </article>
          ))}
        </div>
      ) : null}

      {writable.length ? (
        <div className="space-y-3 p-4">
          <div className="grid gap-3 md:grid-cols-2">
            <NoteField label="Overall summary" value={draft.summary} onChange={(summary) => setDraft((current) => ({ ...current, summary }))} placeholder="How did the show go overall?" />
            <NoteField label="What worked" value={draft.wins} onChange={(wins) => setDraft((current) => ({ ...current, wins }))} placeholder="People, process, cues, or systems to repeat" />
            <NoteField label="Issues or changes" value={draft.issues} onChange={(issues) => setDraft((current) => ({ ...current, issues }))} placeholder="What changed, failed, or ran differently?" />
            <NoteField label="Follow-up" value={draft.followUps} onChange={(followUps) => setDraft((current) => ({ ...current, followUps }))} placeholder="Owner, action, and next deadline" />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className={`text-[11px] ${message.includes("could not") || message.includes("do not have") ? "text-red-300" : "text-board-muted"}`}>{message || "Nothing here is compulsory; save only useful operational context."}</p>
            <button type="button" disabled={saving} onClick={() => void save()} className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-fire-500 px-3 text-xs font-semibold text-black disabled:opacity-50">
              <Save className="h-3.5 w-3.5" />{saving ? "Saving…" : "Save my notes"}
            </button>
          </div>
        </div>
      ) : report.managerNotes.length === 0 ? (
        <p className="px-4 py-5 text-xs text-board-muted">No PM or TM notes were submitted for this show.</p>
      ) : null}
    </section>
  );
}

function NoteField({ label, value, placeholder, onChange }: { label: string; value: string; placeholder: string; onChange: (value: string) => void }) {
  return (
    <label className="space-y-1.5 text-[11px] font-medium text-board-muted">
      {label}
      <textarea value={value} onChange={(event) => onChange(event.target.value)} maxLength={4_000} rows={3} placeholder={placeholder} className="w-full resize-y rounded-lg border border-board-border bg-board-bg px-3 py-2 text-xs leading-5 text-board-text outline-none placeholder:text-board-muted/45 focus:border-fire-500/50" />
    </label>
  );
}

function NoteLine({ label, value }: { label: string; value: string }) {
  return <p className="mt-2 whitespace-pre-wrap text-[11px] leading-5 text-board-muted"><span className="font-semibold text-board-text/80">{label}:</span> {value}</p>;
}

function DetailSection({
  title,
  icon: Icon,
  empty,
  children,
}: {
  title: string;
  icon: React.ElementType;
  empty: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-board-border">
      <h3 className="flex items-center gap-2 border-b border-board-border bg-board-bg/40 px-4 py-3 text-xs font-semibold text-board-text">
        <Icon className="h-3.5 w-3.5 text-fire-400" />
        {title}
      </h3>
      {empty ? (
        <p className="px-4 py-5 text-xs text-board-muted">No records.</p>
      ) : (
        children
      )}
    </section>
  );
}

function DetailRow({
  title,
  detail,
  meta,
}: {
  title: string;
  detail: string;
  meta: string;
}) {
  return (
    <div className="grid gap-1 border-b border-board-border/60 px-4 py-3 last:border-0 md:grid-cols-[minmax(160px,.7fr)_1.5fr_auto] md:gap-4">
      <p className="text-xs font-medium text-board-text">{title}</p>
      <p className="text-xs text-board-muted">{detail}</p>
      <p className="text-[10px] uppercase tracking-wide text-board-muted">
        {meta}
      </p>
    </div>
  );
}

function ReportMetric({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
}) {
  return (
    <div className="rounded-xl border border-board-border bg-board-bg/40 p-4">
      <Icon className="h-4 w-4 text-board-muted" />
      <p className="mt-3 text-lg font-semibold text-board-text">{value}</p>
      <p className="mt-1 text-[10px] text-board-muted">{label}</p>
    </div>
  );
}
