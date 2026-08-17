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
  Search,
  Users,
  X,
} from "lucide-react";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { exportShowReport, type ShowReport } from "@/lib/report";
import { getSchedule } from "@/lib/schedule";
import { getOrgSettings } from "@/lib/settings";
import { getTodayDateString } from "@/lib/utils";

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
  const minutes = Math.max(
    0,
    Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000),
  );
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function plannedDuration(milliseconds: number) {
  const minutes = Math.round(milliseconds / 60000);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export const Route = createFileRoute("/$slug/reports")({
  validateSearch: (search: Record<string, unknown>) => ({
    date: typeof search.date === "string" ? search.date : undefined,
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
  const [detailDate, setDetailDate] = useState<string | null>(() =>
    search.date &&
    data.services.some((item) => item.serviceDate === search.date)
      ? search.date
      : null,
  );
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<"pdf" | "csv" | null>(null);

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
  const selected = data.services.find(
    (service) => service.serviceDate === detailDate,
  );

  useEffect(() => {
    if (search.page <= pageCount) return;
    void navigate({ search: { ...search, page: pageCount }, replace: true });
  }, [navigate, pageCount, search]);

  useEffect(() => {
    if (!detailDate || detail || detailLoading || detailError) return;
    let active = true;
    setDetailLoading(true);
    void exportShowReport({
      data: { orgId: data.orgId, serviceDate: detailDate },
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
  }, [data.orgId, detail, detailDate, detailError]);

  const openReport = async (serviceDate: string) => {
    setDetailDate(serviceDate);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    void navigate({ search: { date: serviceDate, page }, replace: true });
    try {
      setDetail(
        await exportShowReport({ data: { orgId: data.orgId, serviceDate } }),
      );
    } catch {
      setDetailError("The report details could not be loaded.");
    } finally {
      setDetailLoading(false);
    }
  };

  const closeReport = () => {
    setDetailDate(null);
    setDetail(null);
    setDetailError(null);
    void navigate({ search: { date: undefined, page }, replace: true });
  };

  const exportReport = async (format: "pdf" | "csv") => {
    if (!detailDate) return;
    setExporting(format);
    try {
      const report =
        detail ??
        (await exportShowReport({
          data: { orgId: data.orgId, serviceDate: detailDate },
        }));
      const exports = await import("@/lib/rundown-export");
      if (format === "pdf") exports.exportRundownPdf(report);
      else exports.exportRundownCsv(report);
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="h-full overflow-auto">
      <header className="sticky top-0 z-10 border-b border-board-border bg-board-bg/90 px-4 py-3 backdrop-blur-xl md:px-6">
        <h1 className="text-lg font-semibold text-board-text">Show reports</h1>
        <p className="mt-0.5 text-xs text-board-muted">
          Review operational history and open any show for full details
        </p>
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
                    search: { date: undefined, page: 1 },
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
                    key={service.serviceDate}
                    onClick={() => void openReport(service.serviceDate)}
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
                      search: { date: undefined, page: page - 1 },
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
                      search: { date: undefined, page: page + 1 },
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

      {detailDate ? (
        <ReportDetailModal
          service={selected}
          report={detail}
          loading={detailLoading}
          error={detailError}
          exporting={exporting}
          onClose={closeReport}
          onExport={exportReport}
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
  onClose,
  onExport,
}: {
  service:
    | ReturnType<typeof Route.useLoaderData>["services"][number]
    | undefined;
  report: ShowReport | null;
  loading: boolean;
  error: string | null;
  exporting: "pdf" | "csv" | null;
  onClose: () => void;
  onExport: (format: "pdf" | "csv") => void;
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
          </div>
        )}
      </div>
    </div>
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
