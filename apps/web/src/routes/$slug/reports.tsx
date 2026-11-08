import {
  createFileRoute,
  useBlocker,
  useNavigate,
} from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  ListChecks,
  MessageSquareText,
  Search,
  Users,
  X,
} from "lucide-react";
import { PageSkeleton } from "@/components/ui/Skeleton";
import {
  exportShowReport,
  getShowReportIndex,
  type ShowReport,
  type ShowReportIndexItem,
} from "@/lib/report";
import { getOrgSettings } from "@/lib/settings";
import { getTodayDateString } from "@/lib/utils";
import type { ShowReportLane, ShowReportNote } from "@/lib/show-report-notes";
import { ContextHelp } from "@/components/ui/context-help";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  ConfirmDialog,
  useConfirmDialog,
} from "@/components/ui/confirm-dialog";
import { ReadFailureNotice } from "@/components/layout/ReadFailureNotice";
import { useOperatorRead } from "@/hooks/useOperatorRead";
import {
  ManagerReportNotes,
  type ReportEditingState,
} from "@/components/reports/ManagerReportNotes";
import { withOperationTimeout } from "@/lib/operation-timeout";

const PAGE_SIZE = 10;
const action =
  "min-h-11 min-w-11 rounded-lg border border-board-border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-fire-500 disabled:opacity-40";
function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
function displayDate(date: string) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
function duration(start: string | null, end: string | null) {
  if (!start || !end) return "—";
  const elapsed = new Date(end).getTime() - new Date(start).getTime();
  return !Number.isFinite(elapsed) ||
    elapsed < 0 ||
    elapsed > 12 * 60 * 60 * 1000
    ? "Needs review"
    : plannedDuration(elapsed);
}
function plannedDuration(ms: number) {
  const minutes = Math.round(ms / 60000);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
function percentage(done: number, total: number) {
  return total ? `${Math.round((done / total) * 100)}%` : "—";
}

export const Route = createFileRoute("/$slug/reports")({
  validateSearch: (search: Record<string, unknown>) => ({
    date: typeof search.date === "string" ? search.date : undefined,
    show: typeof search.show === "string" ? search.show : undefined,
    page:
      typeof search.page === "number" &&
      Number.isFinite(search.page) &&
      search.page > 0
        ? Math.floor(search.page)
        : 1,
  }),
  loaderDeps: () => ({}),
  pendingComponent: () => <PageSkeleton />,
  loader: async ({ context, abortController }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(
      context.role,
      "show:view",
      context.slug,
      context.orgId,
    );
    const settings = await getOrgSettings({
      data: { orgId: context.orgId },
      signal: abortController.signal,
    });
    const today = getTodayDateString(settings["org-timezone"]);
    const reportIndex = await getShowReportIndex({
      data: { orgId: context.orgId, from: shiftDate(today, -365), to: today },
      signal: abortController.signal,
    });
    return { services: reportIndex.services, orgId: context.orgId };
  },
  component: ReportsPage,
});

function ReportsPage() {
  const data = Route.useLoaderData(),
    search = Route.useSearch(),
    navigate = useNavigate({ from: Route.fullPath });
  const [query, setQuery] = useState("");
  const listRoot = useRef<HTMLDivElement>(null);
  const restoreReportFocus = (showId: string) => {
    const root = listRoot.current;
    if (!root) return;
    // The table and phone cards are separate elements. Return to the visible
    // counterpart if the viewport changed while the report was open.
    const button = Array.from(
      root.querySelectorAll<HTMLButtonElement>("button[data-report-id]"),
    ).find(
      (node) =>
        node.dataset.reportId === showId && node.getClientRects().length > 0,
    );
    (
      button ?? root.querySelector<HTMLInputElement>('input[type="search"]')
    )?.focus();
  };
  const filtered = useMemo(
    () =>
      data.services.filter((service) =>
        `${service.name} ${service.serviceDate} ${displayDate(service.serviceDate)}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
      ),
    [data.services, query],
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)),
    page = Math.min(search.page, pageCount),
    rows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const selected = search.show
    ? data.services.find((service) => service.id === search.show)
    : data.services.find((service) => service.serviceDate === search.date);
  const openReport = (service: ShowReportIndexItem) =>
    void navigate({
      search: { show: service.id, date: service.serviceDate, page },
    });
  const closeReport = () =>
    void navigate({
      search: { show: undefined, date: undefined, page },
      replace: true,
    });
  useEffect(() => {
    if (search.page > pageCount)
      void navigate({ search: { ...search, page: pageCount }, replace: true });
  }, [search, pageCount, navigate]);
  const reportButton = (service: ShowReportIndexItem) => (
    <button
      type="button"
      data-report-id={service.id}
      aria-label={`Open report: ${service.name}, ${displayDate(service.serviceDate)}`}
      onClick={() => openReport(service)}
      className="min-h-11 w-full break-words rounded text-left text-sm font-semibold text-board-text hover:text-fire-400 focus-visible:outline-2 focus-visible:outline-fire-500"
    >
      {service.name}
      <span className="mt-1 block text-xs font-normal text-fire-400">
        View details
      </span>
    </button>
  );
  return (
    <div ref={listRoot} className="h-full min-w-0 overflow-auto">
      <header className="sticky top-0 z-10 border-b border-board-border bg-board-bg/90 px-4 py-3 backdrop-blur-xl md:px-6">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold">Reports &amp; notes</h1>
          <ContextHelp
            title="Reports & notes"
            description="Everyone on the team can review show outcomes here. Production and Technical Managers can add optional notes, and exports include every saved note."
            className="size-11"
          />
        </div>
      </header>
      <div className="mx-auto max-w-[1500px] p-4 md:p-6">
        <section className="mb-4 flex items-start gap-3 rounded-xl border border-fire-500/20 bg-fire-500/5 p-4">
          <MessageSquareText className="mt-1 size-5 shrink-0 text-fire-400" />
          <div>
            <h2 className="text-sm font-semibold">Post-show notes live here</h2>
            <p className="mt-1 text-sm text-board-muted">
              Open any show to read the team handoff. Production and Technical
              Managers can add or update their notes here at any time.
            </p>
          </div>
        </section>
        <section className="overflow-hidden rounded-xl border border-board-border bg-board-card">
          <div className="flex flex-wrap items-end justify-between gap-3 border-b border-board-border p-3">
            <label className="block w-full max-w-sm text-sm text-board-muted">
              Search reports
              <span className="relative mt-1 block">
                <Search className="pointer-events-none absolute left-3 top-3.5 size-4" />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    void navigate({
                      search: { ...search, page: 1 },
                      replace: true,
                    });
                  }}
                  placeholder="Show name or date"
                  className="min-h-11 w-full rounded-lg border border-board-border bg-board-bg pl-9 pr-3 text-sm text-board-text focus-visible:outline-2 focus-visible:outline-fire-500"
                />
              </span>
            </label>
            <p className="py-3 text-sm text-board-muted">
              {filtered.length} report{filtered.length === 1 ? "" : "s"}
            </p>
          </div>
          <div className="hidden xl:block">
            <table className="w-full table-fixed text-left text-sm">
              <caption className="sr-only">
                Show reports. Open a show to read its full report and manager
                notes.
              </caption>
              <thead>
                <tr className="border-b border-board-border text-xs text-board-muted">
                  <th className="w-[16%] p-3" scope="col">
                    Date
                  </th>
                  <th className="w-[26%] p-3" scope="col">
                    Show
                  </th>
                  <th className="w-[14%] p-3" scope="col">
                    Elapsed time
                  </th>
                  <th className="p-3" scope="col">
                    Rundown
                  </th>
                  <th className="p-3" scope="col">
                    Checklist
                  </th>
                  <th className="p-3" scope="col">
                    Incidents
                  </th>
                  <th className="p-3" scope="col">
                    Crew
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((service) => (
                  <tr
                    key={service.id}
                    className="border-b border-board-border/60 last:border-0"
                  >
                    <td className="p-3">{displayDate(service.serviceDate)}</td>
                    <td className="p-3">{reportButton(service)}</td>
                    <td className="p-3 text-board-muted">
                      {duration(service.actualStart, service.actualEnd)}
                    </td>
                    <td className="p-3 text-board-muted">
                      {percentage(service.completedItems, service.itemCount)}
                    </td>
                    <td className="p-3 text-board-muted">
                      {percentage(
                        service.checklistComplete,
                        service.checklistTotal,
                      )}
                    </td>
                    <td className="p-3 text-board-muted">
                      {service.incidentCount}
                    </td>
                    <td className="p-3 text-board-muted">
                      {service.crewConfirmed}/{service.crewTotal}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="xl:hidden">
            {rows.map((service) => (
              <article
                key={service.id}
                className="space-y-3 border-b border-board-border p-4 last:border-0"
              >
                <p className="text-sm text-board-muted">
                  {displayDate(service.serviceDate)}
                </p>
                <h3>{reportButton(service)}</h3>
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  {[
                    [
                      "Elapsed time",
                      duration(service.actualStart, service.actualEnd),
                    ],
                    [
                      "Rundown complete",
                      percentage(service.completedItems, service.itemCount),
                    ],
                    [
                      "Checklist complete",
                      percentage(
                        service.checklistComplete,
                        service.checklistTotal,
                      ),
                    ],
                    ["Incidents", service.incidentCount],
                    [
                      "Crew confirmed",
                      `${service.crewConfirmed}/${service.crewTotal}`,
                    ],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-board-muted">{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              </article>
            ))}
          </div>
          {!rows.length && (
            <p
              role="status"
              className="p-12 text-center text-sm text-board-muted"
            >
              {query
                ? "No matching reports. Try another show name or date."
                : "No reports in the past year. Reports appear here when a show is created."}
            </p>
          )}
          {filtered.length > PAGE_SIZE && (
            <nav
              aria-label="Report pages"
              className="flex flex-wrap items-center justify-between gap-3 border-t border-board-border p-3"
            >
              <p className="text-sm text-board-muted">
                Page {page} of {pageCount}
              </p>
              <div className="flex gap-2">
                <button
                  className={action}
                  aria-label="Previous page"
                  disabled={page === 1}
                  onClick={() =>
                    void navigate({
                      search: {
                        date: undefined,
                        show: undefined,
                        page: page - 1,
                      },
                    })
                  }
                >
                  <ChevronLeft className="size-4" />
                </button>
                <button
                  className={action}
                  aria-label="Next page"
                  disabled={page === pageCount}
                  onClick={() =>
                    void navigate({
                      search: {
                        date: undefined,
                        show: undefined,
                        page: page + 1,
                      },
                    })
                  }
                >
                  <ChevronRight className="size-4" />
                </button>
              </div>
            </nav>
          )}
        </section>
      </div>
      {selected ? (
        <ReportDetailModal
          key={`${data.orgId}:${selected.id}`}
          orgId={data.orgId}
          service={selected}
          onClose={closeReport}
          onReturnFocus={() => restoreReportFocus(selected.id)}
        />
      ) : search.show || search.date ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) closeReport();
          }}
        >
          <DialogContent showCloseButton={false} className="bg-board-card">
            <DialogTitle>Report unavailable</DialogTitle>
            <DialogDescription>
              This show is not in the accessible report list for the past year.
              Close this dialog to choose another show.
            </DialogDescription>
            <button className={action} onClick={closeReport}>
              Back to reports
            </button>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

function ReportDetailModal({
  orgId,
  service,
  onClose,
  onReturnFocus,
}: {
  orgId: string;
  service: ShowReportIndexItem;
  onClose: () => void;
  onReturnFocus: () => void;
}) {
  const readReport = useCallback(
    (signal: AbortSignal) =>
      exportShowReport({
        data: { orgId, showId: service.id, serviceDate: service.serviceDate },
        signal,
      }),
    [orgId, service.id, service.serviceDate],
  );
  const read = useOperatorRead<ShowReport | null>({
    key: `${orgId}:${service.id}`,
    initialValue: null,
    read: readReport,
    errorMessage:
      "The report details could not be confirmed. Retry the read; no notes will be changed.",
  });
  const [updated, setUpdated] = useState<ShowReport | null>(null),
    report = updated ?? read.value;
  const [editing, setEditing] = useState<ReportEditingState>({
    dirty: false,
    unconfirmed: false,
  });
  const allowClose = useRef(false);
  const guarded = editing.dirty || editing.unconfirmed;
  const blocker = useBlocker({
    shouldBlockFn: () => guarded && !allowClose.current,
    enableBeforeUnload: guarded,
    withResolver: true,
  });
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  const leaveDescription = editing.unconfirmed
    ? "A note save may still complete. Leaving discards your local drafts and retry controls. Reopen the report to check saved notes before making another change."
    : "Your unsaved manager note drafts will be discarded. Saved notes are kept.";
  const requestClose = async () => {
    if (
      guarded &&
      !(await confirm({
        title: "Leave this report?",
        description: leaveDescription,
        confirmLabel: "Leave report",
        variant: "warning",
      }))
    )
      return;
    allowClose.current = true;
    onClose();
  };
  const onNoteChange = (note: ShowReportNote | null, lane: ShowReportLane) =>
    setUpdated((previous) => {
      const value = previous ?? read.value;
      if (!value) return value;
      return {
        ...value,
        managerNotes: [
          ...value.managerNotes.filter(
            (item) => item.userId !== value.viewer.userId || item.role !== lane,
          ),
          ...(note ? [note] : []),
        ],
      };
    });
  const flight = useRef<AbortController | null>(null);
  const [exporting, setExporting] = useState<"pdf" | "csv" | null>(null);
  const [exportFailure, setExportFailure] = useState<{
    format: "pdf" | "csv";
    at: number;
  } | null>(null);
  useEffect(
    () => () => {
      flight.current?.abort();
      flight.current = null;
    },
    [],
  );
  const exportReport = async (format: "pdf" | "csv") => {
    if (flight.current || editing.unconfirmed) return;
    const controller = new AbortController();
    flight.current = controller;
    setExporting(format);
    setExportFailure(null);
    try {
      await withOperationTimeout(
        (async () => {
          const fresh = await readReport(controller.signal);
          const exports = await import("@/lib/rundown-export");
          if (controller.signal.aborted) return;
          if (format === "pdf")
            await exports.exportRundownPdf(fresh, controller.signal);
          else exports.exportRundownCsv(fresh);
        })(),
        15_000,
        "Report export timed out",
      );
    } catch {
      if (flight.current === controller)
        setExportFailure({ format, at: Date.now() });
    } finally {
      controller.abort();
      if (flight.current === controller) {
        flight.current = null;
        setExporting(null);
      }
    }
  };
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) void requestClose();
        }}
      >
        <DialogContent
          showCloseButton={false}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            onReturnFocus();
          }}
          className="flex max-h-[95dvh] min-w-0 flex-col gap-0 overflow-hidden border-board-border bg-board-card p-0 text-board-text sm:max-w-4xl"
        >
          <header className="flex shrink-0 items-start justify-between gap-3 border-b border-board-border p-4">
            <div className="max-h-[30dvh] min-w-0 overflow-y-auto pr-1">
              <p className="text-xs text-fire-400">
                {displayDate(service.serviceDate)}
              </p>
              <DialogTitle className="mt-1 break-words leading-7">
                {service.name}
              </DialogTitle>
              <DialogDescription className="mt-1 text-sm text-board-muted">
                Show report details and saved manager notes.
              </DialogDescription>
            </div>
            <button
              aria-label="Close report"
              className={`${action} grid shrink-0 place-items-center p-2`}
              onClick={() => void requestClose()}
            >
              <X className="size-4" />
            </button>
          </header>
          <div className="min-h-0 min-w-0 overflow-y-auto overscroll-contain">
            <ReadFailureNotice
              error={read.error}
              refreshing={read.refreshing}
              retry={read.retry}
              label="Retry report details"
            />
            {!report ? (
              !read.error && (
                <p
                  role="status"
                  className="p-8 text-center text-sm text-board-muted"
                >
                  Loading full report…
                </p>
              )
            ) : (
              <div className="min-w-0 space-y-5 p-4">
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
                <ManagerReportNotes
                  report={report}
                  onNoteChange={onNoteChange}
                  onEditingChange={setEditing}
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
                <div className="flex flex-wrap gap-2 border-t border-board-border pt-4">
                  {(["pdf", "csv"] as const).map((format) => (
                    <button
                      key={format}
                      className={`${action} inline-flex items-center gap-2`}
                      disabled={!!exporting || editing.unconfirmed}
                      onClick={() => void exportReport(format)}
                    >
                      <Download className="size-4" />
                      {exporting === format
                        ? "Generating…"
                        : `Export ${format.toUpperCase()}`}
                    </button>
                  ))}
                </div>
                {exportFailure && (
                  <div
                    role="alert"
                    className="space-y-2 text-sm text-amber-200"
                  >
                    <p>
                      The export could not be generated. Saved notes are
                      unchanged. Last error{" "}
                      <time dateTime={new Date(exportFailure.at).toISOString()}>
                        {new Date(exportFailure.at).toLocaleTimeString()}
                      </time>
                    </p>
                    <button
                      className={action}
                      onClick={() => void exportReport(exportFailure.format)}
                    >
                      Retry {exportFailure.format.toUpperCase()} export
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
      {ConfirmDialogEl}
      <ConfirmDialog
        open={blocker.status === "blocked"}
        onOpenChange={(open) => {
          if (!open) blocker.reset?.();
        }}
        onConfirm={() => blocker.proceed?.()}
        title="Leave this report?"
        description={leaveDescription}
        confirmLabel="Leave report"
        cancelLabel="Keep editing"
        variant="warning"
      />
    </>
  );
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
