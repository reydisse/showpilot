import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  Archive,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  MessageCircle,
  Search,
} from "lucide-react";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { getIncidentHistory } from "@/lib/incident-history";

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
    query: typeof search.query === "string" ? search.query : "",
    status:
      search.status === "open" || search.status === "resolved"
        ? search.status
        : "all",
    severity: ["low", "medium", "high", "critical"].includes(
      String(search.severity),
    )
      ? (String(search.severity) as "low" | "medium" | "high" | "critical")
      : "all",
    category: typeof search.category === "string" ? search.category : "",
    assignee: typeof search.assignee === "string" ? search.assignee : "",
    from: typeof search.from === "string" ? search.from : "",
    to: typeof search.to === "string" ? search.to : "",
    sort:
      search.sort === "oldest" || search.sort === "severity"
        ? search.sort
        : "newest",
    page: Math.max(1, Number(search.page) || 1),
  }),
  loaderDeps: ({ search }) => search,
  pendingMs: 800,
  pendingMinMs: 100,
  pendingComponent: () => <PageSkeleton />,
  loader: async ({ context, deps }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(
      context.role,
      ["incidents:report", "incidents:access"],
      context.slug,
      context.orgId,
    );
    return getIncidentHistory({
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
        page: deps.page,
        pageSize: 30,
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
  const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
  const update = (patch: Partial<typeof search>) =>
    void navigate({ search: { ...search, ...patch, page: patch.page ?? 1 } });

  useEffect(() => setQueryDraft(search.query), [search.query]);
  useEffect(() => {
    if (queryDraft === search.query) return;
    const timeout = setTimeout(() => update({ query: queryDraft }), 350);
    return () => clearTimeout(timeout);
  }, [queryDraft, search.query]);

  return (
    <div className="h-full overflow-auto">
      <header className="sticky top-0 z-10 border-b border-board-border bg-board-bg/90 px-4 py-3 backdrop-blur-xl md:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <Link
            to="/$slug/production/incidents"
            params={{ slug }}
            search={{ incident: undefined, date: undefined }}
            className="rounded-lg border border-board-border p-2 text-board-muted hover:text-board-text"
            aria-label="Back to current incidents"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div>
            <h1 className="text-base font-semibold text-board-text">
              Incident history
            </h1>
            <p className="text-[11px] text-board-muted">
              Search and review every reported production issue
            </p>
          </div>
          <span className="ml-auto text-xs tabular-nums text-board-muted">
            {result.total} result{result.total === 1 ? "" : "s"}
          </span>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(180px,1fr)_120px_120px_140px_140px_140px]">
          <label className="relative">
            <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-board-muted" />
            <input
              value={queryDraft}
              onChange={(e) => setQueryDraft(e.target.value)}
              placeholder="Search issues, people, categories…"
              className="w-full rounded-lg border border-board-border bg-board-card py-2 pl-9 pr-3 text-xs text-board-text outline-none focus:border-fire-500/50"
            />
          </label>
          <Filter
            value={search.status}
            onChange={(value) =>
              update({ status: value as typeof search.status })
            }
            options={["all", "open", "resolved"]}
          />
          <Filter
            value={search.severity}
            onChange={(value) =>
              update({ severity: value as typeof search.severity })
            }
            options={["all", "critical", "high", "medium", "low"]}
          />
          <select
            value={search.category}
            onChange={(e) => update({ category: e.target.value })}
            className="rounded-lg border border-board-border bg-board-card px-3 py-2 text-xs text-board-text outline-none focus:border-fire-500/50"
          >
            <option value="">All categories</option>
            {result.categories.map((category) => (
              <option key={category}>{category}</option>
            ))}
          </select>
          <input
            value={search.assignee}
            onChange={(e) => update({ assignee: e.target.value })}
            placeholder="Assignee"
            className="rounded-lg border border-board-border bg-board-card px-3 py-2 text-xs text-board-text outline-none focus:border-fire-500/50"
          />
          <Filter
            value={search.sort}
            onChange={(value) => update({ sort: value as typeof search.sort })}
            options={["newest", "oldest", "severity"]}
          />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={search.from}
            onChange={(e) => update({ from: e.target.value })}
            className="w-auto rounded-lg border border-board-border bg-board-card px-3 py-2 text-xs text-board-text outline-none"
          />
          <span className="text-[10px] text-board-muted">to</span>
          <input
            type="date"
            value={search.to}
            onChange={(e) => update({ to: e.target.value })}
            className="w-auto rounded-lg border border-board-border bg-board-card px-3 py-2 text-xs text-board-text outline-none"
          />
          <button
            onClick={() => void navigate({ search: DEFAULTS })}
            className="ml-auto text-[11px] text-board-muted hover:text-board-text"
          >
            Clear filters
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-5xl p-4 md:p-6">
        {result.incidents.length ? (
          <div className="overflow-hidden rounded-xl border border-board-border bg-board-card">
            {result.incidents.map((incident) => (
              <Link
                key={incident.id}
                to="/$slug/production/incidents"
                params={{ slug }}
                search={{ incident: incident.id, date: incident.serviceDate }}
                className="grid gap-2 border-t border-board-border/70 p-4 first:border-t-0 hover:bg-board-bg/55 md:grid-cols-[110px_minmax(0,1fr)_150px]"
              >
                <div>
                  <p className="text-xs font-medium text-board-text">
                    {incident.serviceDate}
                  </p>
                  <p className="mt-1 text-[10px] text-board-muted">
                    {new Date(incident.timestamp).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`text-[9px] font-semibold uppercase ${incident.status === "open" ? "text-red-400" : "text-green-400"}`}
                    >
                      {incident.status}
                    </span>
                    <span className="text-[9px] uppercase text-board-muted">
                      {incident.severity}
                    </span>
                    <span className="text-[9px] text-board-muted">
                      {incident.category}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-board-text">
                    {incident.description}
                  </p>
                  <p className="mt-1 text-[10px] text-board-muted">
                    Reported by {incident.reportedBy || "Unknown"}
                  </p>
                </div>
                <div className="md:text-right">
                  <p className="text-[11px] text-board-text">
                    {incident.assignedName || "Unassigned"}
                  </p>
                  <p className="mt-1 inline-flex items-center gap-1 text-[10px] text-board-muted">
                    <MessageCircle className="h-3 w-3" />
                    {incident.commentCount}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="py-20 text-center">
            <Archive className="mx-auto h-9 w-9 text-board-muted/40" />
            <h2 className="mt-3 text-sm font-medium text-board-text">
              No matching incidents
            </h2>
            <p className="mt-1 text-xs text-board-muted">
              Try broadening the filters.
            </p>
          </div>
        )}
        {pages > 1 && (
          <div className="mt-4 flex items-center justify-center gap-3">
            <button
              disabled={result.page <= 1}
              onClick={() => update({ page: result.page - 1 })}
              className="rounded-lg border border-board-border p-2 text-board-muted disabled:opacity-30"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-xs text-board-muted">
              Page {result.page} of {pages}
            </span>
            <button
              disabled={result.page >= pages}
              onClick={() => update({ page: result.page + 1 })}
              className="rounded-lg border border-board-border p-2 text-board-muted disabled:opacity-30"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

function Filter({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: string[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-lg border border-board-border bg-board-card px-3 py-2 text-xs text-board-text outline-none focus:border-fire-500/50"
    >
      {options.map((option) => (
        <option key={option} value={option}>
          {option[0].toUpperCase() + option.slice(1)}
        </option>
      ))}
    </select>
  );
}
