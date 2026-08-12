/**
 * Cue sheet.
 *
 * Rows are the rundown for this service date — never retyped, never able
 * to drift. Departments own the columns to the right of the title and
 * write their own instructions against each item, live.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, ListOrdered, Plus, Settings2, Wifi, WifiOff } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { getOrgSettings } from "@/lib/settings";
import { getTodayDateString } from "@/lib/utils";
import { hasPermission } from "@/lib/app-permissions";
import { useServiceDateRollover } from "@/hooks/useServiceDateRollover";
import { useCueSheetSync } from "@/hooks/useCueSheetSync";
import { getCueSheet, type CueSheetModel } from "@/lib/cue-sheet";
import { CueTable } from "@/components/cue-sheet/cue-table";
import { ColumnManager } from "@/components/cue-sheet/column-manager";
import { PageSkeleton } from "@/components/ui/Skeleton";

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDisplayDate(dateStr: string): string {
  return new Date(`${dateStr}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Which columns an operator has hidden is a personal view preference, not
 * org data — LX hiding Sound must not hide it for the sound engineer. It
 * lives in localStorage, keyed per org.
 */
function hiddenKey(orgId: string) {
  return `showpilot:cue-hidden:${orgId}`;
}

export const Route = createFileRoute("/$slug/production/cue-sheets")({
  pendingComponent: () => <PageSkeleton />,
  loader: async ({ context }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(
      context.role,
      ["cuesheet:view", "cuesheet:edit", "cuesheet:add_notes"],
      context.slug,
      context.orgId,
    );
    const settings = await getOrgSettings({ data: { orgId: context.orgId } });
    const today = getTodayDateString(settings["org-timezone"]);
    const model = await getCueSheet({ data: { orgId: context.orgId, serviceDate: today } });
    return {
      model,
      orgId: context.orgId,
      role: context.role,
      orgTimezone: settings["org-timezone"],
    };
  },
  component: CueSheetsPage,
});

function CueSheetsPage() {
  const { model: initialModel, orgId, role, orgTimezone } = Route.useLoaderData();
  const { slug } = Route.useParams();
  const [serviceDate, setServiceDate] = useState(() => getTodayDateString(orgTimezone));
  const [model, setModel] = useState<CueSheetModel>(initialModel);
  const [loading, setLoading] = useState(false);
  const [managing, setManaging] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const canAddNotes = hasPermission(role, "cuesheet:add_notes") || hasPermission(role, "cuesheet:edit");
  const canManageColumns = hasPermission(role, "cuesheet:edit");

  useEffect(() => {
    try {
      const raw = localStorage.getItem(hiddenKey(orgId));
      if (raw) setHidden(new Set(JSON.parse(raw) as string[]));
    } catch {
      // A corrupt preference is not worth failing the page over.
    }
  }, [orgId]);

  const toggleHidden = useCallback(
    (columnId: string) => {
      setHidden((prev) => {
        const next = new Set(prev);
        if (next.has(columnId)) next.delete(columnId);
        else next.add(columnId);
        try {
          localStorage.setItem(hiddenKey(orgId), JSON.stringify([...next]));
        } catch {
          // Private browsing. The toggle still works for this session.
        }
        return next;
      });
    },
    [orgId],
  );

  const load = useCallback(
    async (date: string) => {
      setLoading(true);
      try {
        setModel(await getCueSheet({ data: { orgId, serviceDate: date } }));
      } finally {
        setLoading(false);
      }
    },
    [orgId],
  );

  useEffect(() => {
    void load(serviceDate);
  }, [load, serviceDate]);

  useServiceDateRollover({
    serviceDate,
    timeZone: orgTimezone,
    onTodayChanged: setServiceDate,
  });

  // ── Live ──────────────────────────────────────────────────

  const applyRemoteNote = useCallback(
    (event: { serviceDate: string; itemId: string; columnId: string; text: string }) => {
      // Another date's edit is not ours to show.
      if (event.serviceDate !== serviceDate) return;
      setModel((prev) => ({
        ...prev,
        rows: prev.rows.map((row) =>
          row.itemId === event.itemId
            ? { ...row, notes: { ...row.notes, [event.columnId]: event.text } }
            : row,
        ),
      }));
    },
    [serviceDate],
  );

  const { connected, publish } = useCueSheetSync({
    orgId,
    onNote: applyRemoteNote,
    onColumns: () => void load(serviceDate),
  });

  // ── Edits ─────────────────────────────────────────────────

  const handleNoteChange = useCallback(
    async (itemId: string, columnId: string, text: string) => {
      // Optimistic: the cell already shows what was typed. Reverting on a
      // failed write would be worse than a stale cell — the operator has
      // moved on and the rundown is running.
      setModel((prev) => ({
        ...prev,
        rows: prev.rows.map((row) =>
          row.itemId === itemId ? { ...row, notes: { ...row.notes, [columnId]: text } } : row,
        ),
      }));
      publish({ type: "note", serviceDate, itemId, columnId, text, by: "", at: Date.now() });
      const { setCueNote } = await import("@/lib/cue-sheet");
      await setCueNote({ data: { orgId, serviceDate, itemId, columnId, text } });
    },
    [orgId, serviceDate, publish],
  );

  const handleWidthChange = useCallback(
    async (columnId: string, width: number) => {
      setModel((prev) => ({
        ...prev,
        columns: prev.columns.map((c) => (c.id === columnId ? { ...c, width } : c)),
      }));
      const { updateCueColumn } = await import("@/lib/cue-sheet");
      await updateCueColumn({ data: { orgId, id: columnId, width } });
    },
    [orgId],
  );

  const handleReorder = useCallback(
    async (fromId: string, toId: string) => {
      const ids = model.columns.map((c) => c.id);
      const from = ids.indexOf(fromId);
      const to = ids.indexOf(toId);
      if (from < 0 || to < 0) return;
      ids.splice(to, 0, ...ids.splice(from, 1));
      setModel((prev) => ({
        ...prev,
        columns: [...prev.columns].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)),
      }));
      const { reorderCueColumns } = await import("@/lib/cue-sheet");
      await reorderCueColumns({ data: { orgId, ids } });
      publish({ type: "columns", at: Date.now() });
    },
    [model.columns, orgId, publish],
  );

  const visibleCount = useMemo(
    () => model.columns.filter((c) => !hidden.has(c.id)).length,
    [model.columns, hidden],
  );

  const hasRows = model.rows.length > 0;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <header className="shrink-0 bg-board-bg/85 backdrop-blur-xl border-b border-board-border">
        <div className="flex items-center gap-3 flex-wrap px-6 py-3">
          <h1 className="text-[15px] font-semibold text-board-text">Cue sheet</h1>
          {model.serviceName && (
            <span className="text-xs text-board-text">{model.serviceName}</span>
          )}

          <span className="w-px h-5 bg-board-border" aria-hidden="true" />

          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setServiceDate((d) => shiftDate(d, -1))}
              aria-label="Previous day"
              className="p-1.5 rounded-lg hover:bg-board-border text-board-muted hover:text-board-text transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              onClick={() => setServiceDate(getTodayDateString(orgTimezone))}
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-board-text bg-board-card border border-board-border hover:border-fire-500/50 transition-colors min-w-[160px] text-center"
            >
              {formatDisplayDate(serviceDate)}
            </button>
            <button
              onClick={() => setServiceDate((d) => shiftDate(d, 1))}
              aria-label="Next day"
              className="p-1.5 rounded-lg hover:bg-board-border text-board-muted hover:text-board-text transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          <div className="ml-auto flex items-center gap-3">
            {/* Connection state is worth showing here, unlike in the
                operator UI: a cue sheet that has silently stopped
                receiving other people's notes looks identical to one
                where nobody is typing. */}
            <span
              className={`flex items-center gap-1.5 text-[11px] ${connected ? "text-board-muted" : "text-yellow-400"}`}
              title={connected ? "Live" : "Reconnecting — your edits still save"}
            >
              {connected ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
              {connected ? "Live" : "Offline"}
            </span>
            {canManageColumns && (
              <button
                onClick={() => setManaging((v) => !v)}
                aria-expanded={managing}
                className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-board-border/70 text-board-muted hover:text-board-text hover:border-board-border transition-colors"
              >
                <Settings2 className="w-3.5 h-3.5" />
                Columns
              </button>
            )}
          </div>
        </div>

        {/* Visibility toggles. Always available, even without edit rights:
            hiding a column is a view preference, not a change to the sheet. */}
        {model.columns.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap px-6 pb-2.5">
            <span className="text-[10px] uppercase tracking-[0.12em] text-board-muted mr-1">
              Show
            </span>
            {model.columns.map((column) => {
              const isHidden = hidden.has(column.id);
              return (
                <button
                  key={column.id}
                  onClick={() => toggleHidden(column.id)}
                  aria-pressed={!isHidden}
                  className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
                    isHidden
                      ? "border-board-border text-board-muted/60 hover:text-board-text"
                      : "border-fire-500/40 bg-fire-500/10 text-fire-400"
                  }`}
                >
                  {column.label}
                </button>
              );
            })}
            {visibleCount === 0 && (
              <span className="text-[11px] text-yellow-400 ml-1">
                Every column is hidden — the sheet is just the running order.
              </span>
            )}
          </div>
        )}
      </header>

      {managing && canManageColumns && (
        <ColumnManager
          orgId={orgId}
          columns={model.columns}
          onChanged={() => {
            void load(serviceDate);
            publish({ type: "columns", at: Date.now() });
          }}
          onClose={() => setManaging(false)}
        />
      )}

      <div className="flex-1 overflow-auto">
        {loading ? (
          <p className="text-center text-sm text-board-muted py-16">Loading cue sheet…</p>
        ) : hasRows ? (
          <CueTable
            rows={model.rows}
            columns={model.columns}
            hidden={hidden}
            currentItemId={model.currentItemId}
            canEdit={canAddNotes}
            onNoteChange={handleNoteChange}
            onWidthChange={handleWidthChange}
            onReorder={handleReorder}
          />
        ) : (
          // The honest empty state. The old page offered "Add cue", which
          // is what created two competing running orders in the first
          // place — the only way to add a row now is to plan the service.
          <div className="py-10">
            <EmptyState
              icon={ListOrdered}
              title="No rundown for this date"
              description="The cue sheet follows the rundown. Build the running order and every item appears here for each department to write against."
              action={
                <Link
                  to={`/${slug}/rundown` as never}
                  className="inline-flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-fire-500/15 border border-fire-500/30 text-fire-400 hover:bg-fire-500/25 transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Open the rundown
                </Link>
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}
