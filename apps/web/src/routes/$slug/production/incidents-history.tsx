import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, MessageCircle, Plus, Search, SearchX } from "lucide-react";
import { useDeviceTimeZone } from "@/hooks/useDeviceTimeZone";
import { parseIncidentTimestamp } from "@/lib/incident-time";
import { getIncidentHistory } from "@/lib/incident-history";
import { getTodayDateString } from "@/lib/utils";
import { card, clockTime, dayMonth, ghostButton, PersonAvatar, primaryButton, secondaryButton, SeverityBars, severityLabel, splitDescription, StatusLabel } from "@/components/incidents/incident-a";

const DEFAULTS = {
  query: "",
  status: "all",
  severity: "all",
  category: "",
  assignee: "",
  from: "",
  to: "",
  sort: "newest",
  page: 1,
} as const;

export const Route = createFileRoute("/$slug/production/incidents-history")({
  validateSearch: (search: Record<string, unknown>) => ({
    query: typeof search.query === "string" ? search.query.slice(0, 200) : "",
    status:
      search.status === "open" || search.status === "resolved"
        ? search.status
        : "all",
    severity: ["low", "medium", "high", "critical"].includes(
      String(search.severity),
    )
      ? (String(search.severity) as "low" | "medium" | "high" | "critical")
      : "all",
    category: typeof search.category === "string" ? search.category.slice(0, 100) : "",
    assignee: typeof search.assignee === "string" ? search.assignee.slice(0, 200) : "",
    from: typeof search.from === "string" ? search.from : "",
    to: typeof search.to === "string" ? search.to : "",
    sort:
      search.sort === "oldest" || search.sort === "severity"
        ? search.sort
        : "newest",
    page: Number.isSafeInteger(Number(search.page)) && Number(search.page) > 0
      ? Math.min(10_000, Number(search.page)) : 1,
  }),
  loaderDeps: ({ search }) => search,
  pendingMs: 800,
  pendingMinMs: 100,
  pendingComponent: () => <HistorySkeleton />,
  loader: async ({ context, deps, abortController }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(
      context.role,
      ["incidents:report", "incidents:access"],
      context.slug,
      context.orgId,
    );
    return getIncidentHistory({
      signal: abortController.signal,
      data: {
        orgId: context.orgId,
        query: deps.query || undefined,
        status: deps.status,
        severity: deps.severity,
        category: deps.category || undefined,
        assignee: deps.assignee || undefined,
        from: deps.from || undefined,
        to: deps.to || undefined,
        sort: deps.sort,
        // "Show more" grows one list instead of paging; past 100 rows, filters narrow it down.
        page: 1,
        pageSize: Math.min(100, 30 * deps.page),
      },
    });
  },
  component: IncidentHistoryPage,
});

function IncidentHistoryPage() {
  const result = Route.useLoaderData();
  const search = Route.useSearch();
  const { slug } = Route.useParams();
  const navigate = useNavigate({ from: Route.fullPath });
  const [queryDraft, setQueryDraft] = useState(search.query);
  const searchRef = useRef<HTMLInputElement>(null);
  const timeZone = useDeviceTimeZone();
  const update = useCallback((patch: Partial<typeof search>) =>
    void navigate({ search: (current) => ({ ...current, ...patch, page: patch.page ?? 1 }) }), [navigate]);

  useEffect(() => setQueryDraft(search.query), [search.query]);
  useEffect(() => {
    if (queryDraft === search.query) return;
    const timeout = setTimeout(() => update({ query: queryDraft }), 350);
    return () => clearTimeout(timeout);
  }, [queryDraft, search.query, update]);
  // "/" jumps to search, like the hint in the box says.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key !== "/" || event.metaKey || event.ctrlKey || target?.closest("input, textarea, select, [contenteditable=true]")) return;
      event.preventDefault(); searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Includes a search still being typed, so it can be cleared before the debounce lands.
  const filtered = !!(queryDraft || search.query || search.status !== "all" || search.severity !== "all" || search.category || search.assignee || search.from || search.to);
  const clearFilters = () => { setQueryDraft(""); void navigate({ search: DEFAULTS }); };
  const today = getTodayDateString(timeZone);
  const shift = (days: number) => { const date = new Date(`${today}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); };
  const presets = [
    { id: "all", label: "All time", from: "", to: "" },
    { id: "7", label: "Last 7 days", from: shift(-6), to: today },
    { id: "30", label: "Last 30 days", from: shift(-29), to: today },
    { id: "90", label: "Last 90 days", from: shift(-89), to: today },
    { id: "year", label: "This year", from: `${today.slice(0, 4)}-01-01`, to: today },
  ];
  const datePreset = presets.find(preset => preset.from === search.from && preset.to === search.to)?.id ?? "custom";
  const [customDates, setCustomDates] = useState(datePreset === "custom");
  const assignees = [...new Set(result.incidents.map(incident => incident.assignedName).filter(Boolean))].sort();
  if (search.assignee && !assignees.includes(search.assignee)) assignees.unshift(search.assignee);
  const describeFilters = [
    search.severity !== "all" ? `${severityLabel(search.severity)} severity` : "",
    search.category ? `in ${search.category}` : "",
    search.status !== "all" ? (search.status === "open" ? "still open" : "resolved") : "",
    search.assignee ? `assigned to ${search.assignee}` : "",
    search.query ? `matching “${search.query}”` : "",
  ].filter(Boolean).join(", ");
  const shown = result.incidents.length;
  const remaining = result.total - shown;
  const sortNote = search.sort === "oldest" ? "Showing oldest first" : search.sort === "severity" ? "Showing most severe first" : "Showing newest first";
  const grid = "grid grid-cols-[16px_minmax(0,1fr)_76px] items-center gap-x-4 md:grid-cols-[16px_minmax(0,1fr)_88px_100px_24px_44px_76px] lg:grid-cols-[16px_minmax(0,1fr)_88px_100px_170px_44px_76px]";

  return (
    <div className="schedule-a h-full overflow-auto bg-board-bg [overflow-wrap:anywhere]">
      <div className="mx-auto flex max-w-[1180px] min-[1800px]:max-w-[1680px] flex-col gap-5 px-4 pb-12 pt-6 md:px-8">
        <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="flex min-w-0 flex-col gap-1.5">
            <Link to="/$slug/production/incidents" params={{ slug }} search={{ incident: undefined, date: undefined, show: undefined, report: undefined }} className="inline-flex w-fit items-center gap-1 text-[13px] text-[var(--sa-ink-2)] hover:text-board-text"><ChevronLeft className="h-3.5 w-3.5" />Incident log</Link>
            <h1 className="text-[26px] font-semibold leading-[1.15] tracking-[-0.02em] text-board-text">Incident history</h1>
            <p className="text-[13px] text-[var(--sa-ink-2)]">Every production issue your crew has reported, across all shows.</p>
          </div>
          <Link to="/$slug/production/incidents" params={{ slug }} search={{ incident: undefined, date: undefined, show: undefined, report: true }} className={primaryButton}><Plus className="h-3.5 w-3.5" strokeWidth={2} />Report incident</Link>
        </header>

        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-[220px] flex-[1_1_260px] md:max-w-[280px]">
            <span className="sr-only">Search incident history</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--sa-ink-3)]" />
            <input ref={searchRef} maxLength={200} value={queryDraft} onChange={event => setQueryDraft(event.target.value)} placeholder="Search incidents, people, notes"
              className="h-11 w-full rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface-2)] pl-9 pr-9 text-base lg:h-9 lg:text-[13px] text-board-text outline-none placeholder:text-[var(--sa-ink-3)] focus:border-fire-500" />
            <kbd aria-hidden="true" className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-[var(--sa-border-strong)] px-1.5 text-[11px] text-[var(--sa-ink-3)]">/</kbd>
          </label>
          <ChipSelect label="Status" value={search.status} onChange={value => update({ status: value as typeof search.status })} options={[["all", "Any"], ["open", "Open"], ["resolved", "Resolved"]]} />
          <ChipSelect label="Severity" value={search.severity} onChange={value => update({ severity: value as typeof search.severity })} options={[["all", "Any"], ["critical", "Critical"], ["high", "High"], ["medium", "Medium"], ["low", "Low"]]} />
          <ChipSelect label="Category" value={search.category} onChange={value => update({ category: value })} options={[["", "Any"], ...result.categories.map(category => [category, category] as [string, string])]} />
          <ChipSelect label="Assignee" value={search.assignee} onChange={value => update({ assignee: value })} options={[["", "Anyone"], ...assignees.map(name => [name, name] as [string, string])]} />
          <ChipSelect label="Dates" value={customDates ? "custom" : datePreset} onChange={value => {
            if (value === "custom") { setCustomDates(true); return; }
            setCustomDates(false); const preset = presets.find(item => item.id === value); if (preset) update({ from: preset.from, to: preset.to });
          }} options={[...presets.map(preset => [preset.id, preset.label] as [string, string]), ["custom", "Custom range…"]]} />
          {customDates ? <span className="flex items-center gap-1.5 text-[13px] text-[var(--sa-ink-3)]">
            <input type="date" aria-label="From date" max={search.to || undefined} value={search.from} onChange={event => update({ from: event.target.value })} className="h-11 rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface-2)] px-2 text-[13px] text-board-text lg:h-9" />
            to
            <input type="date" aria-label="To date" min={search.from || undefined} value={search.to} onChange={event => update({ to: event.target.value })} className="h-11 rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface-2)] px-2 text-[13px] text-board-text lg:h-9" />
          </span> : null}
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {filtered ? <button type="button" onClick={clearFilters} className={`${ghostButton} h-11 lg:h-8`}>Clear filters</button> : null}
            <ChipSelect label="Sort" value={search.sort} onChange={value => update({ sort: value as typeof search.sort })} options={[["newest", "Newest"], ["oldest", "Oldest"], ["severity", "Severity"]]} neutral />
          </span>
        </div>

        <div className="flex items-center justify-between gap-3 text-[13px]">
          <p className="text-[var(--sa-ink-2)]"><span className="font-medium tabular-nums text-board-text">{result.total}</span> {result.total === 1 ? "incident" : "incidents"}{filtered ? " match" : ""}</p>
          <p className="text-xs text-[var(--sa-ink-3)]">{sortNote}</p>
        </div>

        {result.incidents.length ? <div className="flex flex-col gap-2">
          <div aria-hidden="true" className={`${grid} hidden px-4 text-[11px] font-medium uppercase tracking-[0.07em] text-[var(--sa-ink-3)] md:grid`}>
            <span /><span>Incident</span><span>Category</span><span>Status</span><span className="invisible lg:visible">Assignee</span><span /><span className="text-right">Reported</span>
          </div>
          <div className={`${card} overflow-hidden`}>
            {result.incidents.map((incident, index) => {
              const month = incident.serviceDate.slice(0, 7);
              const newMonth = index === 0 || result.incidents[index - 1].serviceDate.slice(0, 7) !== month;
              const monthCount = result.incidents.filter(item => item.serviceDate.slice(0, 7) === month).length;
              const { title, body } = splitDescription(incident.description);
              const reported = parseIncidentTimestamp(incident.timestamp);
              return <Fragment key={incident.id}>
                {newMonth ? <h2 className="flex items-center gap-2 border-t border-[var(--sa-border)] bg-board-bg px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--sa-ink-2)] first:border-t-0">
                  {new Date(`${incident.serviceDate}T12:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })}
                  <span className="font-normal tabular-nums text-[var(--sa-ink-3)]">{monthCount}</span>
                </h2> : null}
                <Link to="/$slug/production/incident/$incidentId" params={{ slug, incidentId: incident.id }}
                  className={`${grid} border-t border-[var(--sa-border)] px-4 py-3 hover:bg-[var(--sa-surface-2)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-fire-500`}>
                  <SeverityBars severity={incident.severity} />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-[13px] font-medium text-board-text">{title}</span>
                    <span className="truncate text-[13px] text-[var(--sa-ink-3)]">{body || `Reported by ${incident.reportedBy || "someone on the crew"}`}</span>
                  </span>
                  <span className="hidden truncate text-[13px] text-[var(--sa-ink-2)] md:block">{incident.category}</span>
                  <span className="hidden md:block"><StatusLabel status={incident.status} /></span>
                  <span className="hidden min-w-0 items-center gap-2 text-[13px] md:flex"><PersonAvatar name={incident.assignedName || null} size={24} /><span className={`truncate max-lg:sr-only ${incident.assignedName ? "text-board-text" : "text-[var(--sa-ink-3)]"}`}>{incident.assignedName || "Unassigned"}</span></span>
                  <span className="hidden items-center gap-1.5 text-[13px] tabular-nums text-[var(--sa-ink-2)] md:inline-flex"><MessageCircle className="h-3.5 w-3.5 text-[var(--sa-ink-3)]" />{incident.commentCount}</span>
                  <span className="flex flex-col items-end text-xs tabular-nums"><span className="text-board-text">{dayMonth(reported, timeZone)}</span><span className="text-[var(--sa-ink-3)]">{clockTime(reported, timeZone)}</span></span>
                </Link>
              </Fragment>;
            })}
            <div className="flex items-center justify-between gap-3 border-t border-[var(--sa-border)] px-4 py-3 text-[13px]">
              <span className="text-[var(--sa-ink-2)]">Showing <span className="tabular-nums text-board-text">{shown}</span> of <span className="tabular-nums text-board-text">{result.total}</span></span>
              {remaining > 0 && shown < 100 ? <button type="button" onClick={() => update({ page: search.page + 1 })} className={ghostButton}>Show {Math.min(remaining, Math.min(100, 30 * (search.page + 1)) - shown)} more</button>
                : remaining > 0 ? <span className="text-xs text-[var(--sa-ink-3)]">Narrow the filters to see older incidents.</span> : null}
            </div>
          </div>
        </div> : <div className="flex flex-wrap items-center gap-4 rounded-xl border border-dashed border-[var(--sa-border-strong)] p-6">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-[var(--sa-surface-2)] text-[var(--sa-ink-2)]"><SearchX className="h-4 w-4" /></span>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-board-text">{filtered ? "No incidents match these filters" : "No incidents yet"}</h2>
            <p className="text-[13px] text-[var(--sa-ink-2)]">{filtered ? `Nothing ${describeFilters || "here"} has been reported. Clear the filters to see everything, or widen the dates.` : "When your crew reports a problem during a show, it shows up here."}</p>
          </div>
          {filtered ? <button type="button" onClick={clearFilters} aria-label="Clear filters and show all incidents" className={secondaryButton}>Clear filters</button> : null}
        </div>}
      </div>
    </div>
  );
}

/** A filter that reads like a chip ("Status Any ▾") but is a native select, so keyboard and screen readers work as usual. */
function ChipSelect({ label, value, onChange, options, neutral = false }: { label: string; value: string; onChange: (value: string) => void; options: [string, string][]; neutral?: boolean }) {
  const display = options.find(([option]) => option === value)?.[1] ?? value;
  const active = !neutral && value !== options[0]?.[0];
  return <label className={`relative inline-flex h-11 shrink-0 lg:h-9 items-center gap-1.5 rounded-lg border px-3 text-[13px] focus-within:border-fire-500 ${active ? "border-[var(--sa-border-strong)] bg-[var(--sa-surface-3)]" : "border-[var(--sa-border-strong)] bg-[var(--sa-surface)]"}`}>
    <span className="text-[var(--sa-ink-3)]">{label}</span>
    <span className={active ? "font-semibold text-board-text" : "text-board-text"}>{display}</span>
    <ChevronDown className="h-3.5 w-3.5 text-[var(--sa-ink-3)]" />
    <select aria-label={label} value={value} onChange={event => onChange(event.target.value)} className="absolute -inset-px cursor-pointer rounded-lg opacity-0">
      {options.map(([option, text]) => <option key={option || "any"} value={option}>{text}</option>)}
    </select>
  </label>;
}

/** One calm skeleton in the real row grid; no copy, no spinner. */
function HistorySkeleton() {
  const bar = (width: string) => <span className={`block h-2.5 rounded bg-[#222226] ${width}`} />;
  return <div className="h-full bg-board-bg">
    <p role="status" className="sr-only">Loading incident history…</p>
    <div aria-hidden="true" className="schedule-skeleton mx-auto flex max-w-[1180px] min-[1800px]:max-w-[1680px] flex-col gap-5 px-4 pt-6 md:px-8">
      <div className="flex flex-col gap-2">{bar("w-24")}<span className="block h-6 w-56 rounded bg-[#222226]" />{bar("w-80")}</div>
      <div className="flex gap-2">{["w-64", "w-24", "w-28", "w-28", "w-32", "w-28"].map((width, index) => <span key={index} className={`block h-9 rounded-lg bg-[#1a1a1d] ${width}`} />)}</div>
      <div className="overflow-hidden rounded-xl border border-[#242428] bg-[#131315]">
        {Array.from({ length: 5 }, (_, row) => <div key={row} className="flex items-center gap-4 border-t border-[#242428] px-4 py-4 first:border-t-0">
          <span className="h-3 w-4 rounded bg-[#222226]" /><span className="flex flex-1 flex-col gap-2">{bar("w-1/2")}{bar("w-2/3")}</span>{bar("w-16")}{bar("w-20")}<span className="h-6 w-6 rounded-full bg-[#222226]" />{bar("w-20")}{bar("w-12")}
        </div>)}
      </div>
    </div>
  </div>;
}
