import { QuietActivity } from "@/components/ui/QuietActivity";
import { createFileRoute, useBlocker, useNavigate } from "@tanstack/react-router";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDownUp,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  FileText,
  Info,
  ListChecks,
  Search,
  Users,
  X,
} from "lucide-react";
import { exportShowReport, getShowReportIndex, type ShowReport, type ShowReportIndexItem } from "@/lib/report";
import { getOrgSettings } from "@/lib/settings";
import { getTodayDateString } from "@/lib/utils";
import type { ShowReportLane, ShowReportNote } from "@/lib/show-report-notes";
import { ContextHelp } from "@/components/ui/context-help";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ConfirmDialog, useConfirmDialog } from "@/components/ui/confirm-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ReadFailureNotice } from "@/components/layout/ReadFailureNotice";
import { useOperatorRead } from "@/hooks/useOperatorRead";
import { ManagerReportNotes, type ReportEditingState } from "@/components/reports/ManagerReportNotes";
import { withOperationTimeout } from "@/lib/operation-timeout";

/** Reports — A (Doop canvas aneicgaHqk, "Reports" page). Colours come from `.schedule-a`. */

const ROW_OPTIONS = [10, 25, 50] as const;
const PREF_KEY = "showpilot:reports-view";
const chip = "inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface)] px-3 text-[13px] text-board-text hover:bg-[var(--sa-surface-2)] data-[state=open]:border-fire-500 max-lg:h-11";
const secondary = "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface-2)] px-3 text-[13px] font-medium text-board-text hover:bg-[var(--sa-surface-3)] disabled:opacity-40 max-lg:h-11";
const eyebrow = "text-xs font-medium uppercase tracking-[0.07em] text-[var(--sa-ink-3)]";

function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
function displayDate(date: string) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}
function monthLabel(date: string) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", year: "numeric" });
}
function hm(ms: number) {
  const minutes = Math.round(ms / 60000);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
type Elapsed = { kind: "none" } | { kind: "long" } | { kind: "invalid" } | { kind: "ok"; ms: number };
/** Span from the earliest item start to the latest item end. Over 12 hours means the times need review. */
function elapsedOf(start: string | null, end: string | null): Elapsed {
  if (!start || !end) return { kind: "none" };
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return { kind: "invalid" };
  if (ms > 12 * 60 * 60 * 1000) return { kind: "long" };
  return { kind: "ok", ms };
}
const percent = (done: number, total: number) => (total ? Math.round((done / total) * 100) : null);
const isTestShow = (name: string) => /^test\b/i.test(name.trim());

export const Route = createFileRoute("/$slug/reports")({
  validateSearch: (search: Record<string, unknown>) => ({
    date: typeof search.date === "string" ? search.date : undefined,
    show: typeof search.show === "string" ? search.show : undefined,
    page: typeof search.page === "number" && Number.isFinite(search.page) && search.page > 0 ? Math.floor(search.page) : 1,
  }),
  loaderDeps: () => ({}),
  pendingComponent: () => <ReportsSkeleton />,
  loader: async ({ context, abortController }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, "show:view", context.slug, context.orgId);
    const settings = await getOrgSettings({ data: { orgId: context.orgId }, signal: abortController.signal });
    const today = getTodayDateString(settings["org-timezone"]);
    const reportIndex = await getShowReportIndex({ data: { orgId: context.orgId, from: shiftDate(today, -365), to: today }, signal: abortController.signal });
    return { services: reportIndex.services, orgId: context.orgId, today };
  },
  component: ReportsPage,
});

type DateRange = "any" | "7" | "30" | "90" | "year";
type SortKey = "newest" | "oldest" | "incidents" | "longest";
const DATE_LABEL: Record<DateRange, string> = { any: "Any date", "7": "Last 7 days", "30": "Last 30 days", "90": "Last 90 days", year: "This year" };
const SORT_LABEL: Record<SortKey, string> = { newest: "Newest first", oldest: "Oldest first", incidents: "Most incidents", longest: "Longest" };

function ReportsPage() {
  const data = Route.useLoaderData(),
    search = Route.useSearch(),
    navigate = useNavigate({ from: Route.fullPath });
  const [query, setQuery] = useState("");
  const [showName, setShowName] = useState("");
  const [range, setRange] = useState<DateRange>("any");
  const [hasIncidents, setHasIncidents] = useState(false);
  const [hasNotes, setHasNotes] = useState(false);
  const [hideTests, setHideTests] = useState(false);
  const [sort, setSort] = useState<SortKey>("newest");
  const [rowsPer, setRowsPer] = useState<number>(10);
  const listRoot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PREF_KEY) ?? "null");
      if (saved?.sort in SORT_LABEL) setSort(saved.sort);
      if (ROW_OPTIONS.includes(saved?.rows)) setRowsPer(saved.rows);
      if (typeof saved?.hideTests === "boolean") setHideTests(saved.hideTests);
    } catch { /* Preferences are optional. */ }
  }, []);
  const remember = (patch: Partial<{ sort: SortKey; rows: number; hideTests: boolean }>) => {
    try { localStorage.setItem(PREF_KEY, JSON.stringify({ sort, rows: rowsPer, hideTests, ...patch })); } catch { /* Still applied for this visit. */ }
  };
  const toFirstPage = () => { if (search.page !== 1) void navigate({ search: { ...search, page: 1 }, replace: true }); };
  const restoreReportFocus = (showId: string) => {
    const root = listRoot.current;
    if (!root) return;
    const button = Array.from(root.querySelectorAll<HTMLElement>("[data-report-id]")).find(node => node.dataset.reportId === showId && node.getClientRects().length > 0);
    (button ?? root.querySelector<HTMLInputElement>('input[type="search"]'))?.focus();
  };

  const showNames = useMemo(() => [...new Set(data.services.map(service => service.name))].sort((a, b) => a.localeCompare(b)), [data.services]);
  const since = range === "any" ? null : range === "year" ? `${data.today.slice(0, 4)}-01-01` : shiftDate(data.today, -Number(range));
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = data.services.filter(service =>
      (!q || `${service.name} ${service.serviceDate} ${displayDate(service.serviceDate)}`.toLowerCase().includes(q)) &&
      (!showName || service.name === showName) &&
      (!since || service.serviceDate >= since) &&
      (!hasIncidents || service.incidentCount > 0) &&
      (!hasNotes || service.noteLanes.length > 0) &&
      (!hideTests || !isTestShow(service.name)));
    const elapsedMs = (service: ShowReportIndexItem) => { const e = elapsedOf(service.actualStart, service.actualEnd); return e.kind === "ok" ? e.ms : -1; };
    return [...list].sort((a, b) =>
      sort === "oldest" ? a.serviceDate.localeCompare(b.serviceDate)
        : sort === "incidents" ? b.incidentCount - a.incidentCount || b.serviceDate.localeCompare(a.serviceDate)
        : sort === "longest" ? elapsedMs(b) - elapsedMs(a)
        : b.serviceDate.localeCompare(a.serviceDate));
  }, [data.services, query, showName, since, hasIncidents, hasNotes, hideTests, sort]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / rowsPer)),
    page = Math.min(search.page, pageCount),
    rows = filtered.slice((page - 1) * rowsPer, page * rowsPer);
  const months = useMemo(() => {
    const groups: { label: string; rows: ShowReportIndexItem[] }[] = [];
    for (const row of rows) {
      const label = sort === "newest" || sort === "oldest" ? monthLabel(row.serviceDate) : "";
      const last = groups.at(-1);
      if (last && last.label === label) last.rows.push(row); else groups.push({ label, rows: [row] });
    }
    return groups;
  }, [rows, sort]);
  const selected = search.show ? data.services.find(service => service.id === search.show) : data.services.find(service => service.serviceDate === search.date);
  const openReport = (service: ShowReportIndexItem) => void navigate({ search: { show: service.id, date: service.serviceDate, page } });
  const closeReport = () => void navigate({ search: { show: undefined, date: undefined, page }, replace: true });
  useEffect(() => {
    if (search.page > pageCount) void navigate({ search: { ...search, page: pageCount }, replace: true });
  }, [search, pageCount, navigate]);
  const filteredOn = !!query.trim() || !!showName || range !== "any" || hasIncidents || hasNotes;
  const clearFilters = () => { setQuery(""); setShowName(""); setRange("any"); setHasIncidents(false); setHasNotes(false); toFirstPage(); };
  const toggle = (label: string, value: boolean, set: (next: boolean) => void) => <button type="button" role="checkbox" aria-checked={value} onClick={() => { set(!value); toFirstPage(); }}
    className={`${chip} ${value ? "border-board-text/50 bg-[var(--sa-surface-2)]" : ""}`}>
    <span aria-hidden="true" className={`flex h-3.5 w-3.5 items-center justify-center rounded-[3px] ${value ? "bg-board-text text-board-bg" : "shadow-[inset_0_0_0_1.5px_var(--sa-border-strong)]"}`}>{value ? <Check className="h-2.5 w-2.5" strokeWidth={3} /> : null}</span>{label}
  </button>;
  const grid = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 xl:grid-cols-[110px_minmax(0,1fr)_96px_120px_80px_76px_76px_72px_24px]";

  return (
    <div ref={listRoot} className="schedule-a h-full min-w-0 overflow-auto bg-board-bg">
      <div className="mx-auto flex max-w-[1280px] flex-col gap-5 px-4 pb-12 pt-6 md:px-8">
        <header className="flex items-center gap-2">
          <h1 className="text-[26px] font-semibold leading-[1.15] tracking-[-0.02em] text-board-text">Reports &amp; notes</h1>
          <ContextHelp title="Reports & notes" description="Everyone on the team can review show outcomes here. Production and Technical Managers can add optional notes, and exports include every saved note." className="size-11 lg:size-8" />
        </header>

        {data.services.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-[var(--sa-border-strong)] px-6 py-16 text-center">
            <span aria-hidden="true" className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-[var(--sa-surface-2)] text-[var(--sa-ink-2)]"><FileText className="h-4 w-4" /></span>
            <h2 className="text-[15px] font-semibold text-board-text">No reports yet</h2>
            <p className="max-w-[420px] text-[13px] leading-[1.6] text-[var(--sa-ink-2)]">A report appears here after each show runs. Open any report to read the team handoff; Production and Technical Managers can add notes at any time.</p>
          </div>
        ) : <>
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative min-w-[200px] flex-[1_1_220px] md:max-w-[220px]">
              <span className="sr-only">Search reports</span>
              <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--sa-ink-3)]" />
              <input type="search" value={query} onChange={event => { setQuery(event.target.value); toFirstPage(); }} placeholder="Show name or date" aria-label="Search reports"
                className="h-9 w-full rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface)] pl-9 pr-3 text-base text-board-text outline-none placeholder:text-[var(--sa-ink-3)] focus:border-fire-500 lg:text-[13px] max-lg:h-11" />
            </label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><button type="button" className={chip} aria-label={`Show: ${showName || "All shows"}`}><span className="text-[var(--sa-ink-3)]">Show</span><span className="max-w-[180px] truncate font-semibold">{showName || "All shows"}</span><ChevronDown aria-hidden="true" className="h-3.5 w-3.5 text-[var(--sa-ink-3)]" /></button></DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="schedule-a max-h-[60vh] min-w-[240px] overflow-y-auto">
                <DropdownMenuRadioGroup value={showName} onValueChange={value => { setShowName(value); toFirstPage(); }}>
                  <DropdownMenuRadioItem value="">All shows</DropdownMenuRadioItem>
                  {showNames.map(name => <DropdownMenuRadioItem key={name} value={name}>{name}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><button type="button" className={chip} aria-label={`Date: ${DATE_LABEL[range]}`}><CalendarDays aria-hidden="true" className="h-3.5 w-3.5 text-[var(--sa-ink-3)]" /><span className="text-[var(--sa-ink-3)]">Date</span><span className="font-semibold">{DATE_LABEL[range]}</span><ChevronDown aria-hidden="true" className="h-3.5 w-3.5 text-[var(--sa-ink-3)]" /></button></DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="schedule-a min-w-[200px]">
                <DropdownMenuRadioGroup value={range} onValueChange={value => { setRange(value as DateRange); toFirstPage(); }}>
                  {(Object.keys(DATE_LABEL) as DateRange[]).map(key => <DropdownMenuRadioItem key={key} value={key}>{DATE_LABEL[key]}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            {toggle("Has incidents", hasIncidents, setHasIncidents)}
            {toggle("Has notes", hasNotes, setHasNotes)}
            {toggle("Hide tests", hideTests, next => { setHideTests(next); remember({ hideTests: next }); })}
            <DropdownMenu>
              <DropdownMenuTrigger asChild><button type="button" className={`${chip} ml-auto`} aria-label={`Sort: ${SORT_LABEL[sort]}`}><ArrowDownUp aria-hidden="true" className="h-3.5 w-3.5 text-[var(--sa-ink-3)]" /><span className="text-[var(--sa-ink-3)]">Sort</span><span className="font-semibold">{SORT_LABEL[sort]}</span><ChevronDown aria-hidden="true" className="h-3.5 w-3.5 text-[var(--sa-ink-3)]" /></button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="schedule-a min-w-[200px]">
                <DropdownMenuLabel className={eyebrow}>Sort by</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={sort} onValueChange={value => { setSort(value as SortKey); remember({ sort: value as SortKey }); toFirstPage(); }}>
                  {(Object.keys(SORT_LABEL) as SortKey[]).map(key => <DropdownMenuRadioItem key={key} value={key}>{SORT_LABEL[key]}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <section aria-label="Show reports" className="overflow-hidden rounded-xl border border-[var(--sa-border)] bg-[var(--sa-surface)]">
            <div className={`${grid} hidden border-b border-[var(--sa-border)] px-4 py-3 xl:grid ${eyebrow}`}>
              <button type="button" onClick={() => { const next = sort === "newest" ? "oldest" : "newest"; setSort(next); remember({ sort: next }); }} className="flex items-center gap-1 text-left font-semibold uppercase text-board-text">Date {sort === "oldest" ? "↑" : "↓"}</button>
              <span>Show</span><span>Elapsed</span><span>Rundown</span><span>Checklist</span><span>Incidents</span><span>Crew</span><span>Notes</span><span />
            </div>
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
                <h2 className="text-[15px] font-semibold text-board-text">{query.trim() ? `No reports match “${query.trim()}”` : "No reports match these filters"}</h2>
                <p className="text-[13px] text-[var(--sa-ink-2)]">{query.trim() ? "Search looks at show names and dates. Try part of a name, or clear the search." : "Try another show or date range, or clear the filters."}</p>
                {filteredOn ? <button type="button" onClick={clearFilters} className={`${secondary} mt-2`}>{query.trim() && !showName && range === "any" && !hasIncidents && !hasNotes ? "Clear search" : "Clear filters"}</button> : null}
              </div>
            ) : months.map(group => <Fragment key={`${group.label}-${group.rows[0].id}`}>
              {group.label ? <div className="flex items-baseline gap-2 border-b border-[var(--sa-border)] bg-board-bg px-4 py-2.5"><span className="text-[13px] font-semibold text-board-text">{group.label}</span><span className="tabular-nums text-xs text-[var(--sa-ink-3)]">{filtered.filter(service => monthLabel(service.serviceDate) === group.label).length}</span></div> : null}
              {group.rows.map(service => {
                const elapsed = elapsedOf(service.actualStart, service.actualEnd);
                const rundown = percent(service.completedItems, service.itemCount);
                const checklist = percent(service.checklistComplete, service.checklistTotal);
                const crewLow = service.crewTotal > 0 && service.crewConfirmed / service.crewTotal < 0.75;
                const active = selected?.id === service.id;
                return <button key={service.id} type="button" data-report-id={service.id} onClick={() => openReport(service)}
                  aria-label={`Open report: ${service.name}, ${displayDate(service.serviceDate)}`}
                  className={`group ${grid} min-h-[52px] w-full border-b border-[var(--sa-border)] px-4 py-2.5 text-left outline-none last:border-b-0 hover:bg-[var(--sa-surface-2)] focus-visible:shadow-[inset_0_0_0_2px_var(--color-fire-500)] ${active ? "bg-[var(--sa-surface-2)] shadow-[inset_2px_0_0_var(--color-fire-500)]" : ""}`}>
                  <span className="hidden tabular-nums text-[13px] text-[var(--sa-ink-2)] xl:block">{displayDate(service.serviceDate)}</span>
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="break-words text-[13px] font-medium text-board-text">{service.name}</span>
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--sa-ink-3)] xl:hidden">
                      <span className="tabular-nums">{displayDate(service.serviceDate)}</span>
                      <ElapsedCell elapsed={elapsed} compact />
                      {rundown !== null ? <span className="tabular-nums">Rundown {rundown}%</span> : null}
                      {service.incidentCount ? <IncidentsCell service={service} /> : null}
                      {service.crewTotal ? <CrewCell service={service} low={crewLow} /> : null}
                    </span>
                  </span>
                  <span className="hidden xl:block"><ElapsedCell elapsed={elapsed} /></span>
                  <span className="hidden items-center gap-2 xl:flex">
                    {rundown === null ? <NoData title="No rundown data for this show" /> : <>
                      <span aria-hidden="true" className="h-1.5 w-16 overflow-hidden rounded-full bg-[var(--sa-surface-3)]"><span className={`block h-full rounded-full ${rundown >= 100 ? "bg-[var(--sa-ok)]" : rundown < 50 ? "bg-[var(--sa-warn)]" : "bg-[var(--sa-ink-2)]"}`} style={{ width: `${rundown}%` }} /></span>
                      <span className={`tabular-nums text-xs ${rundown < 50 ? "text-[var(--sa-warn)]" : "text-board-text"}`}>{rundown}%</span>
                    </>}
                  </span>
                  <span className="hidden tabular-nums text-xs text-board-text xl:block">{checklist === null ? <NoData title="No checklist data for this show" /> : `${checklist}%`}</span>
                  <span className="hidden xl:block"><IncidentsCell service={service} /></span>
                  <span className="hidden xl:block"><CrewCell service={service} low={crewLow} /></span>
                  <span className="hidden items-center gap-1 xl:flex">{(["pm", "tm"] as const).map(lane => <span key={lane} title={`${lane === "pm" ? "Production" : "Technical"} Manager note ${service.noteLanes.includes(lane) ? "saved" : "not submitted"}`}
                    className={`inline-flex h-5 items-center rounded border px-1 text-[11px] font-semibold ${service.noteLanes.includes(lane) ? "border-board-text/40 bg-board-text/10 text-board-text" : "border-[var(--sa-border)] text-[var(--sa-ink-3)]"}`}>{lane.toUpperCase()}<span className="sr-only">{service.noteLanes.includes(lane) ? " note saved" : " note not submitted"}</span></span>)}</span>
                  <ChevronRight aria-hidden="true" className="h-4 w-4 justify-self-end text-[var(--sa-ink-3)] opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 max-xl:opacity-100" />
                </button>;
              })}
            </Fragment>)}
            {filtered.length > 0 ? <nav aria-label="Report pages" className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--sa-border)] px-4 py-3">
              <p className="text-[13px] text-[var(--sa-ink-2)]">Showing <span className="tabular-nums">{(page - 1) * rowsPer + 1}–{Math.min(page * rowsPer, filtered.length)}</span> of <span className="tabular-nums">{filtered.length}</span></p>
              <div className="flex items-center gap-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild><button type="button" className={chip} aria-label={`Rows per page: ${rowsPer}`}><span className="text-[var(--sa-ink-3)]">Rows</span><span className="font-semibold tabular-nums">{rowsPer}</span><ChevronDown aria-hidden="true" className="h-3.5 w-3.5 text-[var(--sa-ink-3)]" /></button></DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="schedule-a">
                    <DropdownMenuRadioGroup value={String(rowsPer)} onValueChange={value => { setRowsPer(Number(value)); remember({ rows: Number(value) }); toFirstPage(); }}>
                      {ROW_OPTIONS.map(option => <DropdownMenuRadioItem key={option} value={String(option)}>{option}</DropdownMenuRadioItem>)}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
                <span className="text-[13px] text-[var(--sa-ink-2)]">Page <span className="tabular-nums">{page}</span> of <span className="tabular-nums">{pageCount}</span></span>
                <button type="button" aria-label="Previous page" disabled={page <= 1} onClick={() => void navigate({ search: { ...search, page: page - 1 } })} className={`${secondary} w-9 shrink-0 px-0 max-lg:w-11`}><ChevronLeft className="h-4 w-4" /></button>
                <button type="button" aria-label="Next page" disabled={page >= pageCount} onClick={() => void navigate({ search: { ...search, page: page + 1 } })} className={`${secondary} w-9 shrink-0 px-0 max-lg:w-11`}><ChevronRight className="h-4 w-4" /></button>
              </div>
            </nav> : null}
          </section>
        </>}
      </div>
      {selected ? (
        <ReportDetailDrawer key={`${data.orgId}:${selected.id}`} orgId={data.orgId} service={selected} onClose={closeReport} onReturnFocus={() => restoreReportFocus(selected.id)} />
      ) : search.show || search.date ? (
        <Dialog open onOpenChange={open => { if (!open) closeReport(); }}>
          <DialogContent showCloseButton={false} className="schedule-a bg-[var(--sa-surface)]">
            <DialogTitle>Report unavailable</DialogTitle>
            <DialogDescription>This show is not in the accessible report list for the past year. Close this dialog to choose another show.</DialogDescription>
            <button type="button" className={secondary} onClick={closeReport}>Back to reports</button>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

function NoData({ title }: { title: string }) {
  return <span title={title} className="cursor-help border-b border-dotted border-[var(--sa-ink-3)] text-[var(--sa-ink-3)]">—<span className="sr-only">{title}</span></span>;
}

function ElapsedCell({ elapsed, compact = false }: { elapsed: Elapsed; compact?: boolean }) {
  if (elapsed.kind === "ok") return <span className="tabular-nums text-[13px] text-board-text">{hm(elapsed.ms)}</span>;
  if (elapsed.kind === "none") return compact ? null : <NoData title="Start or end time missing — never run, or the rundown was reset" />;
  const label = elapsed.kind === "long" ? "Over 12 hours" : "Invalid times";
  const title = elapsed.kind === "long" ? "Elapsed time is over 12 hours. This can happen if a show ran that long, or if times from an earlier run were not cleared." : "Start and end times don't produce a valid duration.";
  return <span title={title} className="inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-full border border-[var(--sa-warn)]/40 px-2 text-xs text-[var(--sa-warn)]"><Clock3 aria-hidden="true" className="h-3 w-3" />{label}</span>;
}

function IncidentsCell({ service }: { service: ShowReportIndexItem }) {
  if (!service.incidentCount) return <span className="tabular-nums text-xs text-[var(--sa-ink-3)]">0<span className="sr-only"> incidents</span></span>;
  if (!service.incidentOpen) return <span className="inline-flex items-center gap-1 tabular-nums text-xs text-[var(--sa-ink-3)]"><Check aria-hidden="true" className="h-3.5 w-3.5 text-[var(--sa-ok)]" />{service.incidentCount}<span className="sr-only"> incidents, all resolved</span></span>;
  const severe = service.incidentOpenSevere > 0;
  return <span className={`inline-flex items-center gap-1 tabular-nums text-xs font-medium ${severe ? "text-[var(--sa-danger)]" : "text-[var(--sa-warn)]"}`}><AlertTriangle aria-hidden="true" className="h-3.5 w-3.5" />{service.incidentOpen}<span className="sr-only"> open {service.incidentOpen === 1 ? "incident" : "incidents"}{severe ? ", high severity" : ""}</span></span>;
}

function CrewCell({ service, low }: { service: ShowReportIndexItem; low: boolean }) {
  if (!service.crewTotal) return <NoData title="No crew assigned" />;
  return <span title={`${service.crewConfirmed} confirmed of ${service.crewTotal} assigned`} className={`inline-flex items-center gap-1 tabular-nums text-xs ${low ? "text-[var(--sa-warn)]" : "text-board-text"}`}><Users aria-hidden="true" className="h-3.5 w-3.5" />{service.crewConfirmed}/{service.crewTotal}</span>;
}

function ReportDetailDrawer({ orgId, service, onClose, onReturnFocus }: { orgId: string; service: ShowReportIndexItem; onClose: () => void; onReturnFocus: () => void }) {
  const readReport = useCallback(
    (signal: AbortSignal) => exportShowReport({ data: { orgId, showId: service.id, serviceDate: service.serviceDate }, signal }),
    [orgId, service.id, service.serviceDate],
  );
  const read = useOperatorRead<ShowReport | null>({ key: `${orgId}:${service.id}`, initialValue: null, read: readReport, errorMessage: "This change needs attention." });
  const [updated, setUpdated] = useState<ShowReport | null>(null),
    report = updated ?? read.value;
  const [editing, setEditing] = useState<ReportEditingState>({ dirty: false, unconfirmed: false });
  const allowClose = useRef(false);
  const guarded = editing.dirty || editing.unconfirmed;
  const blocker = useBlocker({ shouldBlockFn: () => guarded && !allowClose.current, enableBeforeUnload: guarded, withResolver: true });
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  const leaveDescription = editing.unconfirmed
    ? "A note save may still complete. Leaving discards your local drafts and retry controls. Reopen the report to check saved notes before making another change."
    : "Your unsaved manager note drafts will be discarded. Saved notes are kept.";
  const requestClose = async () => {
    if (guarded && !(await confirm({ title: "Leave this report?", description: leaveDescription, confirmLabel: "Leave report", variant: "warning" }))) return;
    allowClose.current = true;
    onClose();
  };
  const onNoteChange = (note: ShowReportNote | null, lane: ShowReportLane) =>
    setUpdated(previous => {
      const value = previous ?? read.value;
      if (!value) return value;
      return { ...value, managerNotes: [...value.managerNotes.filter(item => item.userId !== value.viewer.userId || item.role !== lane), ...(note ? [note] : [])] };
    });
  const flight = useRef<AbortController | null>(null);
  const [exporting, setExporting] = useState<"pdf" | "csv" | null>(null);
  const [exportFailure, setExportFailure] = useState<{ format: "pdf" | "csv"; at: number } | null>(null);
  useEffect(() => () => { flight.current?.abort(); flight.current = null; }, []);
  const exportReport = async (format: "pdf" | "csv") => {
    if (flight.current || editing.unconfirmed) return;
    const controller = new AbortController();
    flight.current = controller;
    setExporting(format);
    setExportFailure(null);
    try {
      await withOperationTimeout((async () => {
        const fresh = await readReport(controller.signal);
        const exports = await import("@/lib/rundown-export");
        if (controller.signal.aborted) return;
        if (format === "pdf") await exports.exportRundownPdf(fresh, controller.signal);
        else exports.exportRundownCsv(fresh);
      })(), 15_000, "Report export timed out");
    } catch {
      if (flight.current === controller) setExportFailure({ format, at: Date.now() });
    } finally {
      controller.abort();
      if (flight.current === controller) { flight.current = null; setExporting(null); }
    }
  };

  const elapsed = elapsedOf(service.actualStart, service.actualEnd);
  const neverRan = elapsed.kind === "none" && !service.completedItems;
  const rundown = percent(service.completedItems, service.itemCount);
  const metric = (label: string, value: React.ReactNode, note?: React.ReactNode) => <div className="flex min-w-0 flex-col gap-1.5 px-4 py-3">
    <span className={eyebrow}>{label}</span>
    <span className="text-[15px] tabular-nums text-board-text">{value}</span>
    {note ? <span className="text-xs text-[var(--sa-ink-3)]">{note}</span> : null}
  </div>;
  const confirmedCrew = report?.crew.filter(person => person.status === "confirmed") ?? [];
  const otherCrew = report?.crew.filter(person => person.status !== "confirmed") ?? [];
  const [crewOpen, setCrewOpen] = useState(false);
  const shownCrew = crewOpen ? confirmedCrew : confirmedCrew.slice(0, 3);
  const incidents = [...(report?.incidents ?? [])].sort((a, b) => Number(a.status === "resolved") - Number(b.status === "resolved") || ["critical", "high", "medium", "low"].indexOf(a.severity) - ["critical", "high", "medium", "low"].indexOf(b.severity));

  return (
    <>
      <Dialog open onOpenChange={open => { if (!open) void requestClose(); }}>
        <DialogContent showCloseButton={false} onCloseAutoFocus={event => { event.preventDefault(); onReturnFocus(); }}
          className="schedule-a !left-auto !right-0 !top-0 flex h-dvh !max-w-[680px] !translate-x-0 !translate-y-0 flex-col gap-0 rounded-none border-y-0 border-r-0 border-l-[var(--sa-border-strong)] bg-[var(--sa-surface)] p-0 text-board-text data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100 sm:!max-w-[680px]">
          <header className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--sa-border)] px-6 py-5">
            <div className="flex min-w-0 flex-col gap-1">
              <p className="tabular-nums text-xs text-[var(--sa-ink-3)]">{displayDate(service.serviceDate)}</p>
              <DialogTitle className="break-words text-xl font-semibold tracking-[-0.01em]">{service.name}</DialogTitle>
              <DialogDescription className="text-[13px] text-[var(--sa-ink-2)]">Show report details and saved manager notes.</DialogDescription>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" aria-label="Export report" disabled={!report || !!exporting || editing.unconfirmed} className={secondary}>{exporting ? <QuietActivity label="Exporting…" /> : <><Download className="h-3.5 w-3.5" />Export</>}<ChevronDown className="h-3.5 w-3.5 text-[var(--sa-ink-3)]" /></button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="schedule-a min-w-[200px]">
                  <DropdownMenuItem onSelect={() => void exportReport("pdf")}><FileText className="h-3.5 w-3.5" />Export PDF</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void exportReport("csv")}><ListChecks className="h-3.5 w-3.5" />Export CSV</DropdownMenuItem>
                  <p className="px-2 pb-1.5 pt-1 text-xs text-[var(--sa-ink-3)]">Includes saved notes only</p>
                </DropdownMenuContent>
              </DropdownMenu>
              <button type="button" aria-label="Close report" onClick={() => void requestClose()} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-[var(--sa-ink-3)] hover:bg-[var(--sa-surface-2)] hover:text-board-text max-lg:h-11 max-lg:w-11"><X className="h-4 w-4" /></button>
            </div>
          </header>
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="flex min-w-0 flex-col gap-6 px-6 py-5">
              <ReadFailureNotice variant="panel" error={read.error} refreshing={read.refreshing} retry={read.retry} label="Retry report details" title="We couldn't load this report." description="Check your connection and try again." />
              {exportFailure && (
                <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-[var(--sa-danger)]/30 bg-[var(--sa-danger)]/[0.07] px-4 py-3 text-[13px]">
                  <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--sa-danger)]" />
                  <span className="min-w-0 flex-1">The {exportFailure.format.toUpperCase()} export didn't finish. Nothing was downloaded.</span>
                  <button type="button" className={secondary} onClick={() => void exportReport(exportFailure.format)}>Retry {exportFailure.format.toUpperCase()} export</button>
                </div>
              )}
              {neverRan ? (
                <div className="flex gap-3 rounded-xl border border-dashed border-[var(--sa-border-strong)] px-4 py-3.5">
                  <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--sa-ink-2)]" />
                  <div><p className="text-[13px] font-semibold text-board-text">No run data</p><p className="mt-1 text-[13px] leading-[1.5] text-[var(--sa-ink-2)]">This show was never run, so there's no elapsed time, rundown or checklist to report. Crew and incidents are below.</p></div>
                </div>
              ) : (
                <div className="grid grid-cols-2 divide-[var(--sa-border)] overflow-hidden rounded-xl border border-[var(--sa-border)] sm:grid-cols-5 sm:divide-x">
                  {metric("Elapsed", <ElapsedCell elapsed={elapsed} />)}
                  {metric("Rundown", rundown === null ? "—" : <span className="inline-flex items-center gap-2"><span aria-hidden="true" className="h-1.5 w-12 overflow-hidden rounded-full bg-[var(--sa-surface-3)]"><span className="block h-full rounded-full bg-board-text" style={{ width: `${rundown}%` }} /></span><span className="text-xs">{rundown}%</span></span>)}
                  {metric("Checklist", service.checklistTotal ? `${percent(service.checklistComplete, service.checklistTotal)}%` : "—", service.checklistTotal ? undefined : "No checklist run")}
                  {metric("Incidents", <IncidentsCell service={service} />)}
                  {metric("Crew", <CrewCell service={service} low={service.crewTotal > 0 && service.crewConfirmed / service.crewTotal < 0.75} />, service.crewTotal ? `${service.crewConfirmed} of ${service.crewTotal} confirmed` : undefined)}
                </div>
              )}
              {!report ? (!read.error && <div className="flex flex-col gap-3" aria-busy="true"><p role="status" className="sr-only">Loading full report…</p>{[0, 1, 2].map(n => <span key={n} className="schedule-skeleton block h-20 rounded-xl bg-[var(--sa-surface-2)]" />)}</div>) : <>
                <ManagerReportNotes report={report} onNoteChange={onNoteChange} onEditingChange={setEditing} />

                <section aria-label="Crew" className="flex flex-col gap-3">
                  <h3 className="flex items-center gap-2 text-[15px] font-semibold"><Users aria-hidden="true" className="h-4 w-4 text-[var(--sa-ink-3)]" strokeWidth={1.75} />Crew {report.crew.length ? <span className="tabular-nums text-[13px] font-normal text-[var(--sa-warn)]">{confirmedCrew.length}/{report.crew.length}</span> : null}</h3>
                  {report.crew.length === 0 ? <p className="rounded-xl border border-dashed border-[var(--sa-border-strong)] px-4 py-3 text-[13px] text-[var(--sa-ink-2)]">No crew were assigned to this show.</p> : (
                    <ul className="overflow-hidden rounded-xl border border-[var(--sa-border)]">
                      {shownCrew.map((person, index) => <li key={`${person.role}-${index}`} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-3 border-b border-[var(--sa-border)] px-4 py-2.5 text-[13px] last:border-b-0">
                        <span className="truncate text-board-text">{person.role}</span><span className="truncate text-[var(--sa-ink-2)]">{person.name}</span><span className={eyebrow}>Confirmed</span>
                      </li>)}
                      {confirmedCrew.length > 3 ? <li className="border-b border-[var(--sa-border)] last:border-b-0"><button type="button" onClick={() => setCrewOpen(open => !open)} className="w-full px-4 py-2.5 text-left text-[13px] text-[var(--sa-ink-2)] hover:bg-[var(--sa-surface-2)] max-lg:min-h-11">{crewOpen ? "Show fewer" : `+ ${confirmedCrew.length - 3} more confirmed`}</button></li> : null}
                      {otherCrew.length ? (otherCrew.length <= 3 || crewOpen ? otherCrew.map((person, index) => <li key={`other-${index}`} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-3 border-b border-[var(--sa-border)] px-4 py-2.5 text-[13px] last:border-b-0">
                        <span className="truncate text-board-text">{person.role}</span><span className="truncate text-[var(--sa-ink-2)]">{person.name}</span><span className={`${eyebrow} text-[var(--sa-warn)]`}>{person.status || "Assigned"}</span>
                      </li>) : <li className="flex items-center justify-between gap-3 px-4 py-2.5 text-[13px]"><button type="button" onClick={() => setCrewOpen(true)} className="text-left text-[var(--sa-warn)] hover:underline">{otherCrew.length} not confirmed yet</button><span className={eyebrow}>Assigned or declined</span></li>) : null}
                    </ul>
                  )}
                </section>

                <section aria-label="Incidents" className="flex flex-col gap-3">
                  <h3 className="flex items-center gap-2 text-[15px] font-semibold"><AlertTriangle aria-hidden="true" className="h-4 w-4 text-[var(--sa-ink-3)]" strokeWidth={1.75} />Incidents <span className="tabular-nums text-[13px] font-normal text-[var(--sa-ink-3)]">{report.incidents.length}</span></h3>
                  {incidents.length === 0 ? <p className="rounded-xl border border-dashed border-[var(--sa-border-strong)] px-4 py-3 text-[13px] text-[var(--sa-ink-2)]">No incidents were logged during this show.</p> : (
                    <ul className="overflow-hidden rounded-xl border border-[var(--sa-border)]">
                      {incidents.map(incident => {
                        const resolved = incident.status === "resolved";
                        const severe = incident.severity === "critical" || incident.severity === "high";
                        return <li key={incident.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 border-b border-[var(--sa-border)] px-4 py-3 last:border-b-0">
                          <span className={`inline-flex h-5 items-center rounded-full border px-2 text-xs capitalize ${resolved ? "border-[var(--sa-border)] text-[var(--sa-ink-3)]" : severe ? "border-[var(--sa-danger)]/40 bg-[var(--sa-danger)]/10 text-[var(--sa-danger)]" : "border-[var(--sa-warn)]/40 bg-[var(--sa-warn)]/10 text-[var(--sa-warn)]"}`}>{incident.severity}</span>
                          <span className="flex min-w-0 flex-col gap-0.5"><span className="break-words text-[13px] text-board-text">{incident.description.split("\n")[0] || "Untitled incident"}</span><span className="text-xs text-[var(--sa-ink-3)]">{incident.category}{incident.reportedBy ? ` · reported by ${incident.reportedBy}` : ""}</span></span>
                          <span className={`inline-flex items-center gap-1 text-xs ${resolved ? "text-[var(--sa-ok)]" : "text-[var(--sa-ink-2)]"}`}>{resolved ? <><Check aria-hidden="true" className="h-3.5 w-3.5" />Resolved</> : "Open"}</span>
                        </li>;
                      })}
                    </ul>
                  )}
                </section>

                <section aria-label="Checklist" className="flex flex-col gap-3">
                  <h3 className="flex items-center gap-2 text-[15px] font-semibold"><ListChecks aria-hidden="true" className="h-4 w-4 text-[var(--sa-ink-3)]" strokeWidth={1.75} />Checklist {report.checklist.length ? <span className="tabular-nums text-[13px] font-normal text-[var(--sa-ink-3)]">{report.checklist.filter(item => item.checked).length}/{report.checklist.length}</span> : null}</h3>
                  {report.checklist.length === 0 ? <p className="rounded-xl border border-dashed border-[var(--sa-border-strong)] px-4 py-3 text-[13px] text-[var(--sa-ink-2)]">No checklist was run for this show.</p> : (
                    <ul className="overflow-hidden rounded-xl border border-[var(--sa-border)]">
                      {report.checklist.map(item => <li key={item.id} className="grid grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-3 border-b border-[var(--sa-border)] px-4 py-2.5 text-[13px] last:border-b-0">
                        {item.checked ? <Check aria-hidden="true" className="h-3.5 w-3.5 text-[var(--sa-ok)]" /> : <span aria-hidden="true" className="h-3 w-3 rounded-[3px] shadow-[inset_0_0_0_1.5px_var(--sa-border-strong)]" />}
                        <span className="min-w-0 break-words text-board-text">{item.label}<span className="ml-2 text-xs text-[var(--sa-ink-3)]">{item.category}</span></span>
                        <span className={`${eyebrow} ${item.checked ? "" : "text-[var(--sa-warn)]"}`}>{item.checked ? "Complete" : "Incomplete"}</span>
                      </li>)}
                    </ul>
                  )}
                </section>
              </>}
            </div>
          </div>
        </DialogContent>
      </Dialog>
      {ConfirmDialogEl}
      <ConfirmDialog open={blocker.status === "blocked"} onOpenChange={open => { if (!open) blocker.reset?.(); }} onConfirm={() => blocker.proceed?.()}
        title="Leave this report?" description={leaveDescription} confirmLabel="Leave report" cancelLabel="Keep editing" variant="warning" />
    </>
  );
}

/** One calm skeleton in the real table shape. Count and pager wait for real numbers. */
function ReportsSkeleton() {
  const bar = (width: string) => <span className={`block h-2.5 rounded bg-[var(--sa-surface-3)] ${width}`} />;
  return <div className="schedule-a h-full bg-board-bg">
    <p role="status" className="sr-only">Loading reports…</p>
    <div aria-hidden="true" className="schedule-skeleton mx-auto flex max-w-[1280px] flex-col gap-5 px-4 pt-6 md:px-8">
      <span className="block h-7 w-56 rounded bg-[var(--sa-surface-3)]" />
      <div className="flex gap-2">{["w-56", "w-36", "w-36", "w-28", "w-28"].map((w, i) => <span key={i} className={`block h-9 rounded-lg bg-[var(--sa-surface-2)] ${w}`} />)}</div>
      <div className="overflow-hidden rounded-xl border border-[var(--sa-border)] bg-[var(--sa-surface)]">
        <div className="h-11 border-b border-[var(--sa-border)]" />
        {Array.from({ length: 6 }, (_, row) => <div key={row} className="flex items-center gap-6 border-b border-[var(--sa-border)] px-4 py-4 last:border-b-0">{bar("w-20")}{bar("w-1/3")}<span className="ml-auto flex gap-6">{bar("w-16")}{bar("w-10")}</span></div>)}
      </div>
    </div>
  </div>;
}
