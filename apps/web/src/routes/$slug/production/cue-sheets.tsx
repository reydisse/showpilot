import { RelaySyncNotice } from "@/components/RelaySyncNotice";
/**
 * Cue sheet.
 *
 * Rows are the rundown for this service date — never retyped, never able
 * to drift. Departments own the columns to the right of the title and
 * write their own instructions against each item, live.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ListOrdered, Plus, Settings2, Wifi, WifiOff } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { getOrgSettings } from "@/lib/settings";
import { getTodayDateString } from "@/lib/utils";
import { ShowSwitcherMenu } from "@/components/show-switcher-menu";
import { hasEffectivePermission } from "@/lib/app-permissions";
import { useCueSheetSync } from "@/hooks/useCueSheetSync";
import { getCueSheet, type CueSheetModel } from "@/lib/cue-sheet";
import { withOperationTimeout } from "@/lib/operation-timeout";
import { useCueSheetWrites } from "@/hooks/useCueSheetWrites";
import { describeCueSheetWrite, type CueSheetOperation } from "@/lib/cue-sheet-writes";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { CueTable, TOGGLEABLE_COLUMNS } from "@/components/cue-sheet/cue-table";
import { useRundownSync } from "@/hooks/useRundownSync";
import { toCueRows } from "@/lib/cue-sheet-derive";
import { CallerClockBar } from "@/components/cue-sheet/caller-clock";
import type { RundownItem } from "@/types/rundown";
import { ScrollEdges, useEdgeScroll } from "@/components/ui/scroll-edges";
import { ColumnManager } from "@/components/cue-sheet/column-manager";
import { PageSkeleton } from "@/components/ui/Skeleton";

/** Flatten the server's row-attached notes into the page's cell map. */
function notesFromRows(rows: { itemId: string; notes: Record<string, string> }[]) {
  const out: Record<string, Record<string, string>> = {};
  for (const row of rows) {
    if (Object.keys(row.notes).length > 0) out[row.itemId] = { ...row.notes };
  }
  return out;
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
    // No serviceDate: the server opens on the next service that actually
    // has a rundown. A church runs one service a week, so defaulting to
    // today would show an empty sheet six days out of seven.
    const model = await getCueSheet({ data: { orgId: context.orgId, today } });
    return {
      model,
      initialNow: Date.now(),
      orgId: context.orgId,
      role: context.role,
      grantedPermissions: context.grantedPermissions,
      orgTimezone: settings["org-timezone"],
    };
  },
  component: CueSheetsPage,
});

function CueSheetsPage() {
  const { model: initialModel, orgId, role, grantedPermissions, orgTimezone, initialNow } = Route.useLoaderData();
  const { slug } = Route.useParams();
  const today = getTodayDateString(orgTimezone);
  const [showId, setShowId] = useState(initialModel.showId);
  const [serviceDate, setServiceDate] = useState(initialModel.serviceDate);
  const [model, setModel] = useState<CueSheetModel>(initialModel);
  // itemId → columnId → text. Held apart from the rows because the rows
  // now arrive from the rundown relay and the cells do not: keying notes
  // off the last server row list would drop a note typed on an item that
  // was added to the rundown after this page loaded.
  const [notes, setNotes] = useState<Record<string, Record<string, string>>>(() =>
    notesFromRows(initialModel.rows),
  );
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadErrorAt, setLoadErrorAt] = useState<number | null>(null);
  const loadVersion = useRef(0);
  const loadController = useRef<AbortController | null>(null);
  useEffect(() => () => { loadVersion.current++; loadController.current?.abort(); }, [orgId]);
  const selectedShow = useRef(showId);
  selectedShow.current = showId;
  const noteVersion = useRef(0);
  const localNotes = useRef(new Map<string, { showId: string; itemId: string; columnId: string; text: string; expectedText: string; pending: boolean; version: number }>());
  const notePumps = useRef(new Set<string>());
  const writes = useCueSheetWrites(orgId);
  const [confirmedColumnWrite, setConfirmedColumnWrite] = useState<CueSheetOperation | null>(null);
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  const [managing, setManaging] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const sheetScroll = useEdgeScroll();

  const canAddNotes =
    hasEffectivePermission(role, grantedPermissions, "cuesheet:add_notes") ||
    hasEffectivePermission(role, grantedPermissions, "cuesheet:edit");
  const canManageColumns = hasEffectivePermission(role, grantedPermissions, "cuesheet:edit");

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
    async (nextShowId: string, signal?: AbortSignal) => {
      loadController.current?.abort();
      const controller = new AbortController();
      loadController.current = controller;
      const cancel = () => controller.abort();
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      const version = ++loadVersion.current;
      const startedNotes = noteVersion.current;
      setLoading(true);
      try {
        const next = await withOperationTimeout(
          getCueSheet({ data: { orgId, showId: nextShowId, today }, signal: controller.signal }),
          8000, "Cue sheet refresh timed out. Your current sheet is kept. Try again.",
        );
        if (controller.signal.aborted || version !== loadVersion.current || selectedShow.current !== nextShowId) {
          throw new Error("Cue sheet changed during refresh. Refresh again to confirm live changes.");
        }
        setLoadError(null); setLoadErrorAt(null);
        setModel(next);
        setShowId(next.showId);
        setServiceDate(next.serviceDate);
        const nextNotes = notesFromRows(next.rows);
        for (const [key, draft] of localNotes.current) {
          if (draft.showId !== next.showId) continue;
          if (draft.pending || draft.version > startedNotes) nextNotes[draft.itemId] = { ...nextNotes[draft.itemId], [draft.columnId]: draft.text };
          else localNotes.current.delete(key);
        }
        setNotes(nextNotes);
      } catch (cause) {
        if (controller.signal.aborted || version !== loadVersion.current) throw cause;
        setLoadError(cause instanceof Error ? cause.message : "Could not load the cue sheet.");
        setLoadErrorAt(Date.now());
        throw cause;
      } finally {
        signal?.removeEventListener("abort", cancel);
        controller.abort();
        if (loadController.current === controller) loadController.current = null;
        if (version === loadVersion.current) setLoading(false);
      }
    },
    [orgId, today],
  );

  // The loader already fetched the opening date; re-reading it here would
  // be a wasted round trip on every mount.
  const loadedRef = useRef(initialModel.showId);
  useEffect(() => {
    if (!showId || loadedRef.current === showId) return;
    loadedRef.current = showId;
    void load(showId).catch(() => {});
  }, [load, showId]);

  // ── Live ──────────────────────────────────────────────────

  const { connected, status: syncStatus, publish, syncError, syncErrorAt, retrySync } = useCueSheetSync({
    orgId,
    scope: showId ?? "",
    // Notifications invalidate the D1 read. A delayed receipt retry must never
    // replace a newer note using an older notification payload.
    onNote: (event) => { if (event.showId === showId) retrySync(); },
    onRefresh: async (signal) => { if (showId) await load(showId, signal); },
  });

  // ── Continuity with the rundown ───────────────────────────
  //
  // The same relay the rundown editor drives. Reading the rows once at
  // load was the gap: rename an item, drag it, change a duration, and
  // the cue sheet sat on a stale copy until someone reloaded — which is
  // the drift this rebuild exists to remove, just with a slower clock.
  //
  // Rows are re-derived from the live items, and the notes already on
  // screen are carried across by itemId. Server rows remain the fallback
  // until the relay hydrates, and for a service nobody has open in the
  // editor (the DO holds no state for it), so an unreachable socket
  // degrades to what the page did before rather than to a blank sheet.
  //
  const {
    items: liveItems,
    timer: liveTimer,
    hydrated,
    stateShowId,
  } = useRundownSync(orgId, serviceDate, showId ?? undefined);

  /** Live items are this service's only if the relay says so. */
  const liveMatches = hydrated && stateShowId === showId && liveItems.length > 0;

  // Follow the editor. If the rundown moves to another service, the cue
  // sheet goes with it — that is what "the cue sheet follows the
  // rundown" has to mean, or the two sit on different Sundays and the
  // sheet looks broken while being perfectly correct.
  //
  // An explicit pick in the sheet's own control wins: someone who has
  // deliberately opened last week to read their notes should not be
  // dragged back the moment a colleague opens the editor.
  const pickedRef = useRef(false);
  useEffect(() => {
    if (pickedRef.current) return;
    if (!hydrated || !stateShowId || stateShowId === showId) return;
    const relayShow = model.shows.find((show) => show.id === stateShowId);
    if (relayShow) setShowId(relayShow.id);
  }, [hydrated, model.shows, showId, stateShowId]);

  const cells = useMemo(
    () =>
      Object.entries(notes).flatMap(([itemId, byColumn]) =>
        Object.entries(byColumn).map(([columnId, text]) => ({ itemId, columnId, text })),
      ),
    [notes],
  );

  const rows = useMemo(() => {
    // Before the relay hydrates — and for a service nobody has open in
    // the editor, where the DO holds nothing — the server's rows stand
    // in. An unreachable socket degrades to what the page did before,
    // never to a blank sheet.
    const source: RundownItem[] =
      liveMatches
        ? (liveItems as unknown as RundownItem[])
        : (model.rows.map((row) => ({
            id: row.itemId,
            title: row.title,
            type: row.type,
            duration: row.durationMs,
            notes: row.note,
            assignee: row.assignee,
            cue: row.cue,
            status: row.status,
            sortOrder: 0,
            hardStop: false,
          })) as RundownItem[]);

    return toCueRows(
      source,
      {
        serviceDate,
        scheduledStartTime: model.scheduledStartTime,
        status: model.rundownStatus,
      },
      cells,
    );
  }, [cells, liveMatches, liveItems, model.rows, model.scheduledStartTime, model.rundownStatus, serviceDate]);

  const currentItemId = liveMatches ? liveTimer.currentItemId : model.currentItemId;

  // ── Edits ─────────────────────────────────────────────────

  const saveNote = async (key: string, retry = false) => {
    if (notePumps.current.has(key)) return;
    notePumps.current.add(key);
    try {
      while (true) {
        const draft = localNotes.current.get(key);
        if (!draft?.pending || (!retry && writes.has(key))) return;
        const ack = await writes.run(key, retry ? undefined : {
          kind: "note", showId: draft.showId, serviceDate, itemId: draft.itemId,
          columnId: draft.columnId, text: draft.text, expectedText: draft.expectedText,
        });
        retry = false;
        if (!ack || ack.result.outcome !== "applied" || ack.attempt.operation.kind !== "note") return;
        const op = ack.attempt.operation;
        const latest = localNotes.current.get(key);
        if (!latest) return;
        if (latest.text === op.text) {
          latest.pending = false; latest.version = ++noteVersion.current;
          latest.text = ack.result.currentText ?? op.text;
          latest.expectedText = latest.text;
          if (selectedShow.current === latest.showId) setNotes(previous => ({ ...previous, [latest.itemId]: { ...previous[latest.itemId], [latest.columnId]: latest.text } }));
        } else {
          // A newer local edit follows the confirmed value, never the result
          // of another operator's intervening edit. The server checks this base.
          latest.expectedText = op.text;
        }
        publish({ type: "note", showId: op.showId, serviceDate: op.serviceDate, itemId: op.itemId, columnId: op.columnId, text: ack.result.currentText ?? op.text, by: "", at: Date.now() });
        if (!latest.pending) return;
      }
    } finally { notePumps.current.delete(key); }
  };

  const handleNoteChange = (itemId: string, columnId: string, text: string, expectedText: string) => {
    if (!showId) return;
    const key = JSON.stringify([showId, itemId, columnId]);
    setNotes(previous => ({ ...previous, [itemId]: { ...previous[itemId], [columnId]: text } }));
    localNotes.current.set(key, { showId, itemId, columnId, text, expectedText, pending: true, version: ++noteVersion.current });
    void saveNote(key);
  };

  const reviewNote = async (key: string) => {
    const entry = writes.entries.get(key), draft = localNotes.current.get(key);
    if (!entry?.conflict || !draft || selectedShow.current !== draft.showId) return;
    const text = draft.text, saved = entry.conflict.currentText ?? "";
    const accepted = await confirm({ title: "Replace the saved cue note?", description: `Saved note: ${saved || "(empty)"}\nYour edit: ${text || "(empty)"}\nThe saved note will be checked again before replacement.`, confirmLabel: "Replace with my edit", variant: "warning" });
    if (!accepted || localNotes.current.get(key)?.text !== text || selectedShow.current !== draft.showId) return;
    if (!writes.clearConflict(key, entry.attempt.requestId)) return;
    draft.expectedText = saved;
    void saveNote(key);
  };

  const runColumn = async (operation?: CueSheetOperation) => {
    const ack = await writes.run("columns", operation);
    if (!ack || ack.result.outcome !== "applied") return false;
    setConfirmedColumnWrite(ack.attempt.operation);
    publish({ type: "columns", at: Date.now() });
    if (selectedShow.current) await load(selectedShow.current).catch(() => {});
    return true;
  };
  const columnWrite = writes.entries.get("columns");
  const columnLocked = !!columnWrite || loading;
  const noteWrites = [...writes.entries].filter(([, entry]) => entry.attempt.operation.kind === "note" && entry.attempt.operation.showId === showId);
  const noteFailures = noteWrites.filter(([, entry]) => entry.failure);
  const handleWidthChange = (id: string, width: number) => {
    const column = model.columns.find(column => column.id === id);
    if (!column || columnLocked || column.width === width) return;
    void runColumn({ kind: "resize-column", id, before: column.width, width });
  };
  const handleReorder = (fromId: string, toId: string) => {
    if (columnLocked) return;
    const before = model.columns.map(column => column.id), ids = [...before];
    const from = ids.indexOf(fromId), to = ids.indexOf(toId);
    if (from < 0 || to < 0 || from === to) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    void runColumn({ kind: "reorder-columns", before, ids });
  };

  const pickerShows = useMemo(() => [...model.shows].reverse(), [model.shows]);

  const visibleCount = useMemo(
    () => model.columns.filter((c) => !hidden.has(c.id)).length,
    [model.columns, hidden],
  );

  const hasRows = rows.length > 0;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {ConfirmDialogEl}
      <div className="shrink-0 max-h-[50%] overflow-y-auto" aria-label="Cue sheet controls">
      <header className="shrink-0 bg-board-bg/85 backdrop-blur-xl border-b border-board-border">
        <div className="flex items-center gap-3 flex-wrap px-6 py-3">
          <h1 className="text-[15px] font-semibold text-board-text">Cue sheet</h1>
          {pickedRef.current && stateShowId && stateShowId !== showId && (
            <button
              onClick={() => {
                pickedRef.current = false;
                setShowId(stateShowId);
              }}
              className="text-[11px] px-2 py-0.5 rounded-full border border-yellow-400/40 bg-yellow-400/10 text-yellow-300"
            >
              Rundown changed — follow it
            </button>
          )}
          {model.serviceName && (
            <span className="text-xs text-board-text">{model.serviceName}</span>
          )}

          <ShowSwitcherMenu
            selectedId={showId}
            shows={pickerShows}
            timeZone={orgTimezone}
            onSelect={(selected) => {
              pickedRef.current = true;
              setShowId(selected.id);
            }}
          />

          <RelaySyncNotice error={loadError ?? syncError} occurredAt={loadError ? loadErrorAt : syncErrorAt} status={syncStatus} onRetry={retrySync} />
          {noteWrites.some(([, entry]) => entry.pending) && <p role="status" className="text-sm text-board-muted">Saving cue notes…</p>}
          {noteFailures.length > 0 && <div role="alert" className="min-w-0 basis-full space-y-2 text-sm text-amber-300">
            <p>{noteFailures.length} cue note(s) have not saved. Your edits are kept.</p>
            {noteFailures.map(([key, entry]) => {
              const failure = entry.failure, op = entry.attempt.operation;
              if (!failure || op.kind !== "note") return null;
              const column = model.columns.find(column => column.id === op.columnId)?.label ?? "Removed department";
              const title = rows.find(row => row.itemId === op.itemId)?.title ?? "Cue note";
              return <div key={key} className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 flex-1"><strong>{title} · {column}</strong> {failure.message} <time dateTime={new Date(failure.occurredAt).toISOString()}>{new Date(failure.occurredAt).toLocaleTimeString()}</time></p>
                {entry.conflict && <>
                  <button type="button" className="min-h-11 px-3 underline" onClick={() => void reviewNote(key)}>Review saved note</button>
                  <button type="button" className="min-h-11 px-3 underline" onClick={() => {
                    if (!writes.clearConflict(key, entry.attempt.requestId)) return;
                    const draft = localNotes.current.get(key);
                    if (draft) { draft.text = entry.conflict?.currentText ?? ""; draft.expectedText = draft.text; draft.pending = false; draft.version = ++noteVersion.current; }
                    setNotes(previous => ({ ...previous, [op.itemId]: { ...previous[op.itemId], [op.columnId]: entry.conflict?.currentText ?? "" } }));
                    retrySync();
                  }}>Use saved note</button>
                </>}
              </div>;
            })}
            {noteFailures.some(([, entry]) => !entry.conflict) && <button type="button" className="min-h-11 px-3 font-semibold underline" disabled={noteFailures.every(([, entry]) => entry.pending || entry.conflict)} onClick={() => { for (const [key, entry] of noteFailures) if (!entry.conflict) void saveNote(key, true); }}>Retry saves</button>}
          </div>}
          {columnWrite?.pending && <p role="status" className="text-sm text-board-muted">Saving column change…</p>}
          {columnWrite?.failure && <div role="alert" className="min-w-0 basis-full flex flex-wrap items-center gap-2 text-sm text-amber-300">
            <div className="min-w-0 flex-1 basis-40"><p>{describeCueSheetWrite(columnWrite.attempt.operation)}. {columnWrite.failure.message}</p><time dateTime={new Date(columnWrite.failure.occurredAt).toISOString()}>{new Date(columnWrite.failure.occurredAt).toLocaleTimeString()}</time></div>
            {columnWrite.conflict ? <button type="button" className="min-h-11 px-3 underline" onClick={() => { if (writes.clearConflict("columns", columnWrite.attempt.requestId)) retrySync(); }}>Refresh saved columns</button> : <button type="button" className="min-h-11 px-3 underline disabled:opacity-50" disabled={columnWrite.pending} onClick={() => void runColumn()}>Retry column change</button>}
          </div>}
          <div className="ml-auto flex items-center gap-3">
            {/* Connection state is worth showing here, unlike in the
                operator UI: a cue sheet that has silently stopped
                receiving other people's notes looks identical to one
                where nobody is typing. */}
            {/* Whether other people's notes are reaching this tab. It is
                deliberately not called "live": on a cue sheet that word
                means a service is on air, and two meanings for one word
                is exactly the ambiguity an operator cannot afford. Only
                the failure state is worth words — a working connection
                should not take up the page saying so. */}
            <span
              className={`flex items-center gap-1.5 text-[11px] ${connected ? "text-board-muted/50" : "text-yellow-400"}`}
              title={
                connected
                  ? "Other people's notes appear here as they type"
                  : "Refreshing live changes. The last confirmed sheet and your edits are kept; check any save errors before leaving."
              }
            >
              {connected ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
              {connected ? "Synced" : syncStatus === "connecting" ? "Connecting…" : syncStatus === "refreshing" ? "Refreshing…" : "Reconnecting…"}
            </span>
            {canManageColumns && (
              <button
                onClick={() => setManaging((v) => !v)}
                aria-expanded={managing}
                className="min-h-11 flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-board-border/70 text-board-muted hover:text-board-text hover:border-board-border transition-colors"
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
            {/* The rundown columns toggle too. On a laptop the clock
                columns are often dead weight next to eight departments,
                and the width they free up is the whole point. */}
            {TOGGLEABLE_COLUMNS.map((column) => {
              const isHidden = hidden.has(column.key);
              return (
                <button
                  key={column.key}
                  onClick={() => toggleHidden(column.key)}
                  aria-pressed={!isHidden}
                  className={`min-h-11 text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
                    isHidden
                      ? "border-board-border text-board-muted/60 hover:text-board-text"
                      : "border-board-border bg-board-card text-board-text"
                  }`}
                >
                  {column.label}
                </button>
              );
            })}
            <span className="w-px h-4 bg-board-border mx-1" aria-hidden="true" />
            {model.columns.map((column) => {
              const isHidden = hidden.has(column.id);
              return (
                <button
                  key={column.id}
                  onClick={() => toggleHidden(column.id)}
                  aria-pressed={!isHidden}
                  className={`min-h-11 text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
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

      {hasRows && <CallerClockBar rows={rows} currentItemId={currentItemId} timer={liveMatches ? liveTimer : null} initialNow={initialNow} />}

      {managing && canManageColumns && (
        <ColumnManager
          columns={model.columns}
          onMutation={runColumn}
          locked={columnLocked}
          confirmedOperation={confirmedColumnWrite}
          onClose={() => setManaging(false)}
        />
      )}

      </div>

      {/* A real service sheet is wider than any screen. One scroller for
          the whole grid — both axes — with the left block pinned inside
          it, rather than a table scrolling within a page that scrolls. */}
      <div className="flex-1 relative min-h-0">
        <div ref={sheetScroll.ref} aria-busy={loading} className="absolute inset-0 overflow-auto">
        {model.showId !== showId ? (
          <p className="text-center text-sm text-board-muted py-16">{loadError ? "Cue sheet unavailable. Retry above." : "Loading cue sheet…"}</p>
        ) : hasRows ? (
          <CueTable
            rows={rows}
            columns={model.columns}
            hidden={hidden}
            currentItemId={currentItemId}
            canEdit={canAddNotes}
            canManageColumns={canManageColumns && !columnLocked}
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
        {hasRows && model.showId === showId && (
          <ScrollEdges edges={sheetScroll.edges} scrollBy={sheetScroll.scrollBy} step={320} />
        )}
      </div>
    </div>
  );
}
