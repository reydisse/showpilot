import { QuietActivity } from "@/components/ui/QuietActivity";
import { cueDraftKey, cueCellKey, restoreCueDrafts, serializeCueDrafts, type CueDraft } from "@/lib/cue-sheet-offline";
import { plainFailure } from "@showpilot/shared/ui-feedback";
import { CueUndoNotice } from "@/components/cue-sheet/undo-notice";
import { CueReadNotice } from "@/components/cue-sheet/read-notice";
/**
 * Cue sheet.
 *
 * Rows are the rundown for this service date — never retyped, never able
 * to drift. Departments own the columns to the right of the title and
 * write their own instructions against each item, live.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Columns3, Expand, ListOrdered, Palette, Plus, Wifi, WifiOff, X } from "lucide-react";
import { getOrgSettings } from "@/lib/settings";
import { getTodayDateString } from "@/lib/utils";
import { CueShowMenu } from "@/components/cue-sheet/show-menu";
import { CueColumnsMenu } from "@/components/cue-sheet/columns-menu";
import { DepartmentScroller } from "@/components/cue-sheet/department-scroller";
import { useCueLayout } from "@/components/cue-sheet/use-cue-layout";
import { departmentStyle } from "@/components/cue-sheet/department-color";
import "@/components/cue-sheet/cue-sheet.css";
import { hasEffectivePermission } from "@/lib/app-permissions";
import { useCueSheetSync } from "@/hooks/useCueSheetSync";
import { getCueSheet, type CueSheetModel } from "@/lib/cue-sheet";
import { withOperationTimeout } from "@/lib/operation-timeout";
import { useCueSheetWrites } from "@/hooks/useCueSheetWrites";
import { type CueSheetOperation } from "@/lib/cue-sheet-writes";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { CueTable } from "@/components/cue-sheet/cue-table";
import { useRundownSync } from "@/hooks/useRundownSync";
import { toCueRows } from "@/lib/cue-sheet-derive";
import { CallerClockBar } from "@/components/cue-sheet/caller-clock";
import type { RundownItem } from "@/types/rundown";

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
      userId: context.user.id,
      grantedPermissions: context.grantedPermissions,
      orgTimezone: settings["org-timezone"],
    };
  },
  component: CueSheetsPage,
});

function CueSheetsPage() {
  const { orgId, userId } = Route.useLoaderData();
  return <CueSheetsWorkspace key={JSON.stringify([orgId, userId])} />;
}

function CueSheetsWorkspace() {
  const { model: initialModel, orgId, role, grantedPermissions, orgTimezone, initialNow, userId } = Route.useLoaderData();
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
  const [stillLoading, setStillLoading] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { setStillLoading(false); if (!loading) return; const timer = setTimeout(() => setStillLoading(true), 10000); return () => clearTimeout(timer); }, [loading]);
  const loadVersion = useRef(0);
  const loadController = useRef<AbortController | null>(null);
  useEffect(() => () => { loadVersion.current++; loadController.current?.abort(); }, [orgId]);
  const selectedShow = useRef(showId);
  selectedShow.current = showId;
  const noteVersion = useRef(0);
  const localNotes = useRef(new Map<string, CueDraft>());
  const draftStorageKey = cueDraftKey(orgId, userId);
  const draftStorageReady = useRef(false);
  const [draftStorageError, setDraftStorageError] = useState<string | null>(null);
  const [, setDraftRevision] = useState(0);
  const [offline, setOffline] = useState(false);
  const persistDrafts = () => {
    setDraftRevision(version => version + 1);
    if (!draftStorageReady.current) return;
    try { localStorage.setItem(draftStorageKey, serializeCueDrafts(localNotes.current)); setDraftStorageError(null); }
    catch { setDraftStorageError("Couldn't keep offline cues on this device. Keep this page open."); }
  };
  useEffect(() => {
    try {
      const restored = restoreCueDrafts(localStorage.getItem(draftStorageKey), orgId);
      localNotes.current = restored;
      for (const draft of restored.values()) noteVersion.current = Math.max(noteVersion.current, draft.version);
      setNotes(previous => {
        const next = { ...previous };
        for (const draft of restored.values()) if (draft.showId === selectedShow.current) next[draft.itemId] = { ...next[draft.itemId], [draft.columnId]: draft.text };
        return next;
      });
      draftStorageReady.current = true; setDraftRevision(version => version + 1);
    } catch { setDraftStorageError("Couldn't restore offline cues from this device. Keep this page open."); }
  }, [draftStorageKey, orgId]);
  const notePumps = useRef(new Set<string>());
  const writes = useCueSheetWrites(orgId);
  const [undoItems, setUndoItems] = useState<Array<{ requestId: string; label: string; expiresAt: number }>>([]);
  const [confirmedColumnWrite, setConfirmedColumnWrite] = useState<CueSheetOperation | null>(null);
  const [review, setReview] = useState<{ key: string; requestId: string; text: string; saved: string } | null>(null);
  const [managing, setManaging] = useState(false);
  const preferences = useCueLayout(orgId, userId);
  const sheetRef = useRef<HTMLDivElement>(null);
  const previousScroll = useRef(0);
  const hidden = useMemo(() => new Set([...preferences.layout.hidden, ...(preferences.compact ? ["cue", "note", ...(preferences.narrow ? ["start", "end", "duration"] : [])].filter(key => !preferences.layout.tabletShown.includes(key)) : [])]), [preferences.layout, preferences.compact, preferences.narrow]);
  const collapsed = useMemo(() => new Set(preferences.compact && !preferences.layout.collapsed.length && !preferences.layout.customCollapsed ? model.columns.slice(2).map(column => column.id) : preferences.layout.collapsed), [preferences.compact, preferences.layout, model.columns]);
  const focusId = preferences.layout.focus && model.columns.some(column => column.id === preferences.layout.focus) ? preferences.layout.focus : null;
  const focused = model.columns.find(column => column.id === focusId);
  const displayColumns = useMemo(() => model.columns.map(column => ({ ...column, width: preferences.compact ? 182 : column.width })), [model.columns, preferences.compact]);
  const counts = useMemo(() => Object.fromEntries(model.columns.map(column => [column.id, Object.values(notes).filter(notes => notes[column.id]?.trim()).length])), [model.columns, notes]);
  const canAddNotes = hasEffectivePermission(role, grantedPermissions, "cuesheet:add_notes") || hasEffectivePermission(role, grantedPermissions, "cuesheet:edit");
  const canManageColumns = hasEffectivePermission(role, grantedPermissions, "cuesheet:edit");
  const toggleHidden = (id: string) => preferences.update(layout => ({ ...layout, hidden: hidden.has(id) ? layout.hidden.filter(value => value !== id) : [...layout.hidden, id], focus: id === layout.focus ? null : layout.focus, tabletShown: hidden.has(id) ? [...new Set([...layout.tabletShown, id])] : layout.tabletShown.filter(value => value !== id) }));
  const toggleCollapsed = (id: string) => preferences.update(layout => ({ ...layout, collapsed: collapsed.has(id) ? [...collapsed].filter(value => value !== id) : [...collapsed, id], customCollapsed: true }));
  const focusDepartment = (id: string | null) => {
    if (!focusId && id) previousScroll.current = sheetRef.current?.scrollLeft ?? 0;
    preferences.update(layout => ({ ...layout, focus: id, hidden: id ? layout.hidden.filter(value => value !== id) : layout.hidden }));
    requestAnimationFrame(() => { if (sheetRef.current) { sheetRef.current.scrollLeft = id ? 0 : previousScroll.current; sheetRef.current.dataset.scrolled = String(sheetRef.current.scrollLeft > 0); } });
  };

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
        setLoadError(null);
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

  const { connected, publish, syncError, retrySync } = useCueSheetSync({
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
        if (!draft.request) {
          draft.request = { orgId, requestId: crypto.randomUUID(), operation: { kind: "note", showId: draft.showId, serviceDate: draft.serviceDate, itemId: draft.itemId, columnId: draft.columnId, text: draft.text, expectedText: draft.expectedText } };
          persistDrafts();
        }
        if (!navigator.onLine || !canAddNotes) return;
        const ack = await writes.runCaptured(key, draft.request);
        retry = false;
        if (!ack || ack.result.outcome !== "applied" || ack.attempt.operation.kind !== "note") return;
        const op = ack.attempt.operation;
        const latest = localNotes.current.get(key);
        if (!latest) return;
        if (latest.text === op.text) {
          latest.request = undefined;
          latest.pending = false; latest.version = ++noteVersion.current;
          latest.text = ack.result.currentText ?? op.text;
          latest.expectedText = latest.text;
          if (selectedShow.current === latest.showId) setNotes(previous => ({ ...previous, [latest.itemId]: { ...previous[latest.itemId], [latest.columnId]: latest.text } }));
        } else {
          // A newer local edit follows the confirmed value, never the result
          // of another operator's intervening edit. The server checks this base.
          latest.expectedText = op.text; latest.request = undefined;
        }
        persistDrafts();
        publish({ type: "note", showId: op.showId, serviceDate: op.serviceDate, itemId: op.itemId, columnId: op.columnId, text: ack.result.currentText ?? op.text, by: "", at: Date.now() });
        if (!latest.pending) return;
      }
    } finally { notePumps.current.delete(key); }
  };

  const handleNoteChange = (itemId: string, columnId: string, text: string, expectedText: string) => {
    if (!showId || !canAddNotes) return;
    const key = cueCellKey(showId, itemId, columnId);
    const previous = localNotes.current.get(key);
    setNotes(previous => ({ ...previous, [itemId]: { ...previous[itemId], [columnId]: text } }));
    localNotes.current.set(key, { showId, serviceDate, itemId, columnId, text, expectedText: previous?.pending ? previous.expectedText : expectedText, request: previous?.pending ? previous.request : undefined, pending: true, version: ++noteVersion.current });
    persistDrafts();
    void saveNote(key);
  };

  useEffect(() => {
    let active = true, replaying = false;
    const replay = async () => {
      if (!active || replaying || !navigator.onLine || !canAddNotes || !draftStorageReady.current) return;
      replaying = true;
      try {
        for (const [key, draft] of localNotes.current) {
          if (!active || !navigator.onLine) break;
          if (draft.pending && !writes.entries.get(key)?.conflict) await saveNote(key, true);
        }
      } finally { replaying = false; }
    };
    const online = () => { setOffline(false); void replay(); };
    const disconnected = () => setOffline(true);
    setOffline(!navigator.onLine);
    if (connected) void replay();
    window.addEventListener("online", online); window.addEventListener("offline", disconnected);
    return () => { active = false; window.removeEventListener("online", online); window.removeEventListener("offline", disconnected); };
  }, [connected, canAddNotes]);

  const useSavedNote = (key: string) => {
    const entry = writes.entries.get(key), draft = localNotes.current.get(key);
    if (!entry?.conflict || !draft || selectedShow.current !== draft.showId || !writes.clearConflict(key, entry.attempt.requestId)) return;
    draft.text = entry.conflict.currentText ?? ""; draft.expectedText = draft.text; draft.pending = false; draft.request = undefined; draft.version = ++noteVersion.current;
    persistDrafts();
    setNotes(previous => ({ ...previous, [draft.itemId]: { ...previous[draft.itemId], [draft.columnId]: draft.text } }));
    setReview(null); retrySync();
  };
  const reviewNote = (key: string) => {
    const entry = writes.entries.get(key), draft = localNotes.current.get(key);
    if (entry?.conflict && draft && selectedShow.current === draft.showId) setReview({ key, requestId: entry.attempt.requestId, text: draft.text, saved: entry.conflict.currentText ?? "" });
  };
  const replaceReviewedNote = () => {
    if (!review) return;
    const entry = writes.entries.get(review.key), draft = localNotes.current.get(review.key);
    setReview(null);
    if (!draft || draft.text !== review.text || selectedShow.current !== draft.showId || entry?.attempt.requestId !== review.requestId || !writes.clearConflict(review.key, review.requestId)) return;
    draft.expectedText = review.saved; draft.request = undefined; persistDrafts();
    void saveNote(review.key);
  };

  const runColumn = async (operation?: CueSheetOperation) => {
    const ack = await writes.run("columns", operation);
    if (!ack || ack.result.outcome !== "applied") return false;
    setConfirmedColumnWrite(ack.attempt.operation);
    if (ack.attempt.operation.kind === "delete-empty-column" && ack.result.undoExpiresAt) {
      const op = ack.attempt.operation;
      setUndoItems(previous => [...previous.filter(item => item.requestId !== ack.attempt.requestId), { requestId: ack.attempt.requestId, label: op.label, expiresAt: ack.result.undoExpiresAt! }]);
    }
    if (ack.attempt.operation.kind === "restore-column") {
      const deletionRequestId = ack.attempt.operation.deletionRequestId;
      setUndoItems(previous => previous.filter(item => item.requestId !== deletionRequestId));
    }
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
    if (canManageColumns && !columnLocked && column && column.width !== width) void runColumn({ kind: "resize-column", id, before: column.width, width });
  };
  const handleReorder = (fromId: string, toId: string) => {
    if (columnLocked) return;
    const before = model.columns.map(column => column.id), ids = [...before];
    const from = ids.indexOf(fromId), to = ids.indexOf(toId);
    if (from < 0 || to < 0 || from === to) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    void runColumn({ kind: "reorder-columns", before, ids });
  };

  const [focusRequest, setFocusRequest] = useState<{ itemId: string; columnId: string } | null>(null);
  const [savingVisible, setSavingVisible] = useState(false);
  const saving = [...writes.entries.values()].some(entry => entry.pending);
  useEffect(() => { if (!saving) { setSavingVisible(false); return; } const timeout = setTimeout(() => setSavingVisible(true), 400); return () => clearTimeout(timeout); }, [saving]);
  const pendingDrafts = [...localNotes.current.values()].filter(draft => draft.pending).length;
  const hasRows = rows.length > 0;
  const visibleDepartments = displayColumns.filter(column => !hidden.has(column.id));
  const runningIndex = rows.filter(row => !row.isSection).findIndex(row => row.itemId === currentItemId);
  const runItems = rows.filter(row => !row.isSection);
  const focusRows = [{ label: "Now", row: runningIndex >= 0 ? runItems[runningIndex] : null }, { label: "Next", row: runItems[runningIndex + 1] ?? null }];

  const cellNotices = Object.fromEntries(noteFailures.flatMap(([key, entry]) => {
    const op = entry.attempt.operation;
    if (op.kind !== "note") return [];
    const notice = (() => {
        const department = model.columns.find(column => column.id === op.columnId)?.label ?? "Department";
        const title = rows.find(row => row.itemId === op.itemId)?.title ?? "Cue";
        return <div key={key} role="alert" className="cue-cell-recovery"><p>{entry.conflict ? `${department} · ${title} was saved by someone else` : "Couldn't save this cue. Your edit is kept."}</p>
          {entry.conflict ? <><p>Your text wasn't saved because the cue note changed after you started editing. Yours is still here.</p><button type="button" className="cue-button" onClick={() => useSavedNote(key)}>Use saved note</button><button type="button" className="cue-button" data-primary onClick={() => reviewNote(key)}>Review saved note</button></> : <button type="button" className="cue-button" disabled={entry.pending} onClick={() => void saveNote(key, true)}>Try again</button>}
        </div>;

    })();
    return [[JSON.stringify([op.itemId, op.columnId]), notice]];
  }));
  const revealIssue = () => {
    const op = noteFailures[0]?.[1].attempt.operation;
    if (op?.kind !== "note") return;
    preferences.update(layout => ({ ...layout, focus: null, hidden: layout.hidden.filter(id => id !== op.columnId), collapsed: collapsed.has(op.columnId) ? [...collapsed].filter(id => id !== op.columnId) : [...collapsed], customCollapsed: true }));
    setFocusRequest({ itemId: op.itemId, columnId: op.columnId });
  };
  const orphanNotices = noteFailures.flatMap(([key, entry]) => {
    const op = entry.attempt.operation;
    if (op.kind !== "note" || (rows.some(row => row.itemId === op.itemId) && model.columns.some(column => column.id === op.columnId))) return [];
    return [<div key={key}>{cellNotices[JSON.stringify([op.itemId, op.columnId])]}</div>];
  });
  const undoNotice = undoItems.map(item => <CueUndoNotice key={item.requestId} label={item.label} expiresAt={item.expiresAt} disabled={columnLocked} onUndo={() => void runColumn({ kind: "restore-column", deletionRequestId: item.requestId })} onExpire={() => setUndoItems(previous => previous.filter(undo => undo.requestId !== item.requestId))} />);
  return <div className="cue-page">
    <Dialog open={!!review} onOpenChange={open => { if (!open) setReview(null); }}><DialogContent className="cue-portal">
      <DialogTitle>Replace the saved cue note?</DialogTitle><DialogDescription className="sr-only">Compare the saved note with your text before replacing it.</DialogDescription>
      <div className="cue-conflict-values"><div><span>Saved now</span><p>{review?.saved || "(empty)"}</p></div><div><span>Your text</span><p>{review?.text || "(empty)"}</p></div></div>
      <DialogFooter><button type="button" className="cue-button" onClick={() => { if (review) useSavedNote(review.key); }}>Use saved note</button><button type="button" className="cue-button" data-primary onClick={replaceReviewedNote}>Replace saved note</button></DialogFooter>
    </DialogContent></Dialog>
    <div className="shrink-0"><h1 ref={headingRef} tabIndex={-1} className="cue-heading">Cue sheet</h1><header className="cue-toolbar">
      <CueShowMenu selectedId={showId} shows={model.shows} today={today} onSelect={selected => { pickedRef.current = true; setShowId(selected.id); }} />
      <div className="cue-actions">
        {noteFailures.length > 0 && <button type="button" className="cue-button" data-danger onClick={revealIssue}>{noteFailures.some(([, entry]) => entry.conflict) ? `${noteFailures.filter(([, entry]) => entry.conflict).length} conflict${noteFailures.filter(([, entry]) => entry.conflict).length === 1 ? "" : "s"}` : `${noteFailures.length} unsaved cue${noteFailures.length === 1 ? "" : "s"}`}</button>}
        <span className={`cue-quiet flex items-center gap-1.5 ${offline ? "text-amber-400" : ""}`} role="status" aria-live="polite">{offline ? <><WifiOff className="h-3 w-3" />{pendingDrafts && !draftStorageError ? "Offline, changes saved locally" : "Offline"}</> : savingVisible ? <><QuietActivity label="Saving cues" />Saving…</> : !saving && !pendingDrafts && connected ? <><Wifi className="h-3 w-3" />Synced</> : null}</span>
        {canManageColumns && <button type="button" data-cue-departments-trigger className="cue-button" onClick={() => setManaging(true)} aria-haspopup="dialog" aria-expanded={managing}><Palette />Departments</button>}
        <CueColumnsMenu columns={model.columns} hidden={hidden} counts={counts} canManage={canManageColumns} locked={columnLocked} onToggle={toggleHidden}
          onShowAll={() => preferences.update(layout => ({ ...layout, hidden: [], collapsed: [], tabletShown: ["cue", "start", "end", "duration", "owner", "note"], customCollapsed: true }))} onManage={() => setManaging(true)} onReorder={handleReorder} />
      </div>
    </header></div>
    {draftStorageError && <p role="alert" className="rounded-lg border border-red-400/30 p-3 text-sm">{draftStorageError}</p>}
    {pickedRef.current && stateShowId && stateShowId !== showId && <button type="button" className="cue-button self-start" onClick={() => { pickedRef.current = false; setShowId(stateShowId); }}>Follow the active rundown</button>}
    {!offline && (loadError || (model.showId === showId && syncError)) && <CueReadNotice pending={loading} onRetry={async () => { if (showId) await load(showId); retrySync(); headingRef.current?.focus(); }} />}
    <span className="sr-only" role="status" aria-live="polite">{loading && model.showId !== showId ? "Loading cue sheet…" : "Cue sheet loaded"}</span>
    {orphanNotices}

    {columnWrite?.failure && !managing && <div role="alert" className="flex items-center gap-3 rounded-lg border border-red-400/30 p-3 text-sm"><p className="flex-1">{plainFailure(columnWrite.failure.message, "Couldn't save this department change.")}</p><button type="button" className="cue-button" disabled={columnWrite.pending} onClick={() => { if (columnWrite.conflict) { if (writes.clearConflict("columns", columnWrite.attempt.requestId)) retrySync(); } else void runColumn(); }}>Try again</button></div>}
    {hasRows && model.showId === showId && <CallerClockBar rows={rows} currentItemId={currentItemId} timer={liveMatches ? liveTimer : null} initialNow={initialNow} />}
    {hasRows && model.showId === showId && model.columns.length > 0 && <div className="cue-viewbar shrink-0"><div className="cue-segment"><button type="button" aria-pressed={!focusId} onClick={() => focusDepartment(null)}><Columns3 className="h-3.5 w-3.5" />All departments</button><label className="flex items-center gap-1.5 px-2 text-[13px] text-board-muted"><Expand className="h-3 w-3" />{focused && <><span>Focus:</span><span className="cue-dept-dot" style={departmentStyle(focused.color)} /></>}<select aria-label="Focus department" value={focusId ?? ""} onChange={event => focusDepartment(event.target.value || null)} className="max-w-[180px] bg-transparent py-1.5 outline-none"><option value="">Focus department</option>{model.columns.map(column => <option key={column.id} value={column.id}>{column.label}</option>)}</select></label></div>
      {focusId && <span className="cue-quiet ml-auto">Your view</span>}{focusId && <button type="button" className="cue-quiet ml-auto flex items-center gap-1.5" onClick={() => focusDepartment(null)}><X className="h-3 w-3" />Exit focus</button>}
    </div>}
    <div className="cue-grid-area"><div className="cue-grid-wrap"><div ref={sheetRef} aria-busy={loading} className="cue-grid-scroll">
      {model.showId !== showId ? !loadError && <><CueTable rows={[]} columns={displayColumns} hidden={hidden} collapsed={collapsed} compact={preferences.compact} narrow={preferences.narrow} currentItemId={null} canEdit={false} onNoteChange={() => {}} onWidthChange={() => {}} onReorder={() => {}} /><CueSheetSkeleton />{stillLoading && <p className="cue-quiet p-3">Still loading</p>}</> : <>
        <CueTable rows={rows} columns={displayColumns} hidden={hidden} collapsed={collapsed} compact={preferences.compact} narrow={preferences.narrow} focusedDepartment={focusId} currentItemId={currentItemId} timer={liveMatches ? liveTimer : null} initialNow={initialNow} canEdit={canAddNotes} canManageColumns={canManageColumns && !columnLocked} canAdjustLayout={canManageColumns && !columnLocked && !preferences.compact} cellNotices={cellNotices} focusRequest={focusRequest} onCollapse={toggleCollapsed} onFocusDepartment={focusDepartment} onNoteChange={handleNoteChange} onWidthChange={handleWidthChange} onReorder={handleReorder} />
        {!hasRows && <div className="cue-empty m-4"><ListOrdered className="mx-auto h-5 w-5 text-board-muted" /><h2>No items in this show yet</h2><p>Cue sheet rows follow the rundown. Add items there and they appear here with their times.</p><Link to={`/${slug}/rundown` as never} className="cue-button" data-primary>Open rundown</Link></div>}
      </>}
    </div>{hasRows && !focusId && <DepartmentScroller columns={visibleDepartments} scrollRef={sheetRef} />}</div>
      {focused && <aside className="cue-focus-rail" aria-label={`${focused.label} now and next`} style={departmentStyle(focused.color)}>{focusRows.map(({ label, row }) => <section key={label} className="cue-focus-card"><h3>{focused.label} · {label}</h3><p>{row?.title ?? (label === "Now" ? "Nothing running" : "End of rundown")}</p><div className="cue-focus-note">{row?.notes[focused.id] || "—"}</div></section>)}<p className="cue-quiet">Focus is your view only. It never changes the shared column layout.</p></aside>}
      {hasRows && !model.columns.length && <div className="cue-empty self-start"><Palette className="mx-auto h-5 w-5 text-board-muted" /><h2>Add your first department</h2><p>Each department gets a column for its cues, for example LX or Sound.</p>{canManageColumns && <button type="button" className="cue-button" data-primary onClick={() => setManaging(true)}><Plus />Add department</button>}</div>}
    </div>
    {!managing && undoNotice.length > 0 && <div className="cue-undo-stack">{undoNotice}</div>}
    {managing && canManageColumns && <ColumnManager undoNotice={undoNotice} columns={model.columns} counts={counts} onMutation={runColumn} locked={columnLocked} confirmedOperation={confirmedColumnWrite} onClose={() => setManaging(false)} onReorder={handleReorder} failure={columnWrite?.failure ? plainFailure(columnWrite.failure.message, "Couldn't save this department change.") : null} onRetry={() => { if (columnWrite?.conflict) { if (writes.clearConflict("columns", columnWrite.attempt.requestId)) retrySync(); } else void runColumn(); }} />}
  </div>;
}
function CueSheetSkeleton() {
  return <div role="status" aria-label="Loading cue sheet"><span className="sr-only">Loading cue sheet…</span><div aria-hidden="true">{Array.from({ length: 8 }, (_, index) => <div key={index} className="cue-grid-skeleton"><span /><span /><span /><span /></div>)}</div></div>;
}
