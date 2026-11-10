import { workspaceCopy } from "@showpilot/shared";
import { useTerms as useWorkspaceTerms } from "@/components/workspace/WorkspaceProvider";
import { createFileRoute, useBlocker } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { useCallback, useState } from "react";
import { CheckCircle2, Circle, ListChecks, Loader2, Plus, Sparkles, Trash2 } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import {
  getChecklistEntries,
  getSmartChecklistDraft,
  type SmartChecklistDraft,
} from "@/lib/data";
import {
  DEPARTMENT_LABELS,
  DEPARTMENT_ORDER,
  normalizeCategory,
  type DepartmentKey,
} from "@/lib/departments";
import { hasEffectivePermission } from "@/lib/app-permissions";
import { getOrgSettings } from "@/lib/settings";
import { getTodayDateString } from "@/lib/utils";
import { ShowSwitcherMenu } from "@/components/show-switcher-menu";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { useServiceDateRollover } from "@/hooks/useServiceDateRollover";
import { getRundownOpeningDate } from "@/lib/rundown";
import { ReadFailureNotice } from "@/components/layout/ReadFailureNotice";
import { Button } from "@/components/ui/button";
import { useOperatorRead } from "@/hooks/useOperatorRead";
import { useChecklistWrite } from "@/hooks/useChecklistWrite";
import type { ChecklistOperation } from "@/lib/checklist-writes";
import { normalizeChecklistLabel } from "@/lib/smart-checklist-rules";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function formatDisplayDate(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

export const Route = createFileRoute("/$slug/production/checklist")({
  pendingComponent: () => <PageSkeleton />,
  loader: async ({ context, abortController }) => {
    const signal = abortController.signal;
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, ["checklist:view", "checklist:access"], context.slug, context.orgId);
    const settings = await getOrgSettings({ data: { orgId: context.orgId }, signal });
    const today = getTodayDateString(settings["org-timezone"]);
    const opening = await getRundownOpeningDate({ data: { orgId: context.orgId, today }, signal });
    const entries = await getChecklistEntries({ data: { orgId: context.orgId, serviceDate: opening.serviceDate, showId: opening.showId }, signal });
    return {
      entries,
      serviceDate: opening.serviceDate,
      showId: opening.showId,
      shows: opening.shows,
      orgId: context.orgId,
      role: context.role,
      grantedPermissions: context.grantedPermissions,
      orgTimezone: settings["org-timezone"],
    };
  },
  component: ChecklistPage,
});

function ChecklistPage() {
  const initial = Route.useLoaderData();
  return <ChecklistWorkspace key={initial.orgId} initial={initial} />;
}

type ChecklistInitial = Awaited<ReturnType<typeof Route.useLoaderData>>;
type ChecklistEntry = Awaited<ReturnType<typeof getChecklistEntries>>[number];

export function ChecklistWorkspace({ initial }: { initial: ChecklistInitial }) {
  const workspaceTerms = useWorkspaceTerms();
  const { entries: initialEntries, serviceDate: initialServiceDate, showId: initialShowId, shows, orgId, role, grantedPermissions, orgTimezone } = initial;
  const [selection, setSelection] = useState({ serviceDate: initialServiceDate, showId: initialShowId });
  const { serviceDate } = selection;
  const scopeKey = JSON.stringify([orgId, serviceDate, selection.showId]);
  const readEntries = useCallback(async (signal: AbortSignal) => {
    const opening = await getRundownOpeningDate({ data: { orgId, today: serviceDate, serviceDate, showId: selection.showId }, signal });
    signal.throwIfAborted();
    const entries = await getChecklistEntries({ data: { orgId, serviceDate, showId: opening.showId }, signal });
    return { showId: opening.showId, entries };
  }, [orgId, serviceDate, selection.showId]);
  const entryRead = useOperatorRead<{ showId: string | undefined; entries: ChecklistEntry[] } | null>({
    key: scopeKey,
    initialValue: serviceDate === initialServiceDate && selection.showId === initialShowId ? { showId: initialShowId, entries: initialEntries } : null,
    read: readEntries, errorMessage: "Could not refresh this checklist. Previously confirmed checks are kept. Retry to get the latest state.",
  });
  const showId = entryRead.value?.showId ?? selection.showId;
  const entries = entryRead.value?.entries ?? [];
  const loadingEntries = !entryRead.value && !entryRead.error;
  const writes = useChecklistWrite({ orgId, serviceDate, showId: showId ?? "" });
  const writeLocked = writes.state.kind !== "idle";
  const [savedNotice, setSavedNotice] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newCategory, setNewCategory] = useState<DepartmentKey>("general");
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [draftSelection, setDraftSelection] = useState<Set<string> | null>(null);
  const readDraft = useCallback((signal: AbortSignal) => getSmartChecklistDraft({ data: { orgId, serviceDate, showId }, signal }), [orgId, serviceDate, showId]);
  const draftRead = useOperatorRead<SmartChecklistDraft[] | null>({
    key: scopeKey, initialValue: null, read: readDraft, enabled: generatorOpen,
    errorMessage: "Could not analyze this rundown. Retry to load suggestions.",
  });
  const draft = draftRead.value ?? [];
  const generating = !draftRead.value && !draftRead.error;
  const applyingDraft = writes.state.kind === "pending" && writes.state.attempt.operation.kind === "draft";
  const selectedSuggestionIds = new Set(draft.filter(item => draftSelection === null || draftSelection.has(item.id)).map(item => item.id));
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  const dirty = writeLocked || !!newLabel.trim();
  const blocker = useBlocker({ shouldBlockFn: () => dirty, enableBeforeUnload: dirty, withResolver: true });
  const selectShow = async (next: typeof selection) => {
    if (dirty && !await confirm({ title: "Leave this checklist?", description: "An unconfirmed save may still complete. Leaving discards the local draft and its retry controls. Review this checklist when you return.", confirmLabel: "Leave checklist" })) return;
    setSelection(next); setNewLabel(""); setSavedNotice(""); setGeneratorOpen(false);
  };
  useServiceDateRollover({ serviceDate, timeZone: orgTimezone, onTodayChanged: nextToday => {
    if (!dirty) void selectShow({ serviceDate: nextToday, showId: undefined });
  } });

  // Empty departments are omitted, and the headings only appear once
  // there is more than one department to distinguish — a list that is
  // entirely General should not grow a "General" banner.
  const grouped = DEPARTMENT_ORDER.map((key) => ({
    key,
    items: entries.filter((e) => normalizeCategory(e.template?.category ?? "") === key),
  })).filter((group) => group.items.length > 0);
  const showGroupHeadings = grouped.length > 1;

  const checkedCount = entries.filter((e) => e.checked).length;
  const totalCount = entries.length;
  const progress = totalCount > 0 ? Math.round((checkedCount / totalCount) * 100) : 0;
  const canManageChecklist = hasEffectivePermission(role, grantedPermissions, "checklist:access") && Boolean(showId);
  const canWrite = canManageChecklist && !!entryRead.value && !entryRead.refreshing && !entryRead.error && !writeLocked;
  const save = async (operation?: ChecklistOperation) => {
    if (operation && !canWrite) return;
    setSavedNotice("");
    const ack = await writes.run(operation);
    if (!ack) return;
    // The write has its own acknowledgement. A following read cannot turn it
    // back into a failed save, and Retry of that read never repeats the write.
    entryRead.invalidate();
    if (ack.result.outcome !== "applied") return;
    setSavedNotice("Change saved. Refreshing the checklist does not repeat it.");
    if (ack.attempt.operation.kind === "add") setNewLabel("");
    if (ack.attempt.operation.kind === "draft") setGeneratorOpen(false);
  };
  const expected = (entry: ChecklistEntry) => ({ id: entry.id, expectedRevision: entry.revision, expectedCategory: entry.category });
  const handleToggle = (entry: ChecklistEntry) => save({ kind: "toggle", ...expected(entry), checked: !entry.checked });
  const handleAddTemplate = (e: React.FormEvent) => {
    e.preventDefault();
    if (normalizeChecklistLabel(newLabel)) void save({ kind: "add", label: newLabel.trim(), category: newCategory });
  };
  const handleCategoryChange = (entry: ChecklistEntry, category: DepartmentKey) => save({ kind: "category", ...expected(entry), category });
  const handleDeleteEntry = async (entry: ChecklistEntry) => {
    if (!canWrite) return;
    const ok = await confirm({ title: "Remove checklist item", description: workspaceCopy("Remove this item from the selected service? Other services and the reusable checklist template will not be changed.", workspaceTerms), confirmLabel: "Remove" });
    if (ok) await save({ kind: "delete", ...expected(entry) });
  };
  const handleApplyDraft = () => { if (selectedSuggestionIds.size > 0) void save({ kind: "draft", suggestionIds: [...selectedSuggestionIds] }); };
  const writeNotice = writes.state.kind === "uncertain" || writes.state.kind === "conflict" ? (
    <ReadFailureNotice error={writes.state.failure} refreshing={writes.state.kind === "conflict" && (entryRead.refreshing || !!entryRead.error)}
      retry={() => writes.state.kind === "conflict" ? writes.clearConflict() : void save()}
      label={writes.state.kind === "conflict" ? "I reviewed the refreshed checklist" : "Retry checklist save"} />
  ) : writes.state.kind === "pending" ? <p role="status" className="px-4 py-3 text-sm text-board-muted">Saving checklist change…</p> : null;

  return (
    <div className="h-full overflow-auto">
      <div className="sticky top-0 z-10 border-b border-board-border bg-board-bg/80 px-4 py-4 backdrop-blur-xl sm:px-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <h1 className="text-lg font-semibold text-board-text">Pre-Show Checklist</h1>
          </div>
          <div className="flex w-full items-center justify-between gap-2 sm:w-auto sm:justify-end [&_button]:min-h-11">
            <ShowSwitcherMenu
              disabled={writes.state.kind === "pending"}
              selectedId={showId}
              shows={shows}
              timeZone={orgTimezone}
              onSelect={(selected) => {
                void selectShow({ showId: selected.id, serviceDate: selected.serviceDate });
              }}
            />
            {canManageChecklist && (
              <button
                type="button"
                disabled={!canWrite}
                aria-label="Generate checklist from rundown"
                onClick={() => { setDraftSelection(null); setGeneratorOpen(true); }}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-fire-500/30 bg-fire-500/10 px-2.5 text-xs font-semibold text-fire-400 transition-colors hover:bg-fire-500/20"
              >
                <Sparkles className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Generate from rundown</span>
                <span className="sm:hidden">Generate</span>
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-4">
        <ReadFailureNotice error={entryRead.error} refreshing={entryRead.refreshing} retry={entryRead.retry} label="Retry checklist" />
        {!generatorOpen && writeNotice}
        {savedNotice && <p role="status" className="text-sm text-emerald-400">{savedNotice}</p>}
        {/* Progress */}
        {totalCount > 0 && (
          <div className="mb-6">
            <div className="flex items-center justify-between text-sm mb-2">
              <span className="text-board-muted">{checkedCount} of {totalCount} complete</span>
              <span className="font-semibold text-board-text">{progress}%</span>
            </div>
            <div className="h-2 rounded-full bg-board-border overflow-hidden">
              <div className="h-full rounded-full bg-fire-500 transition-all duration-500" style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}

        {/* Progress */}
        <div className="space-y-5 mb-6">
          {grouped.map(({ key, items }) => (
            <div key={key}>
              {showGroupHeadings && (
                <div className="flex items-baseline justify-between mb-2 px-1">
                  <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-board-muted">
                    {DEPARTMENT_LABELS[key]}
                  </h2>
                  <span className="text-xs text-board-muted tabular-nums">
                    {items.filter((e) => e.checked).length}/{items.length}
                  </span>
                </div>
              )}
              <div className="space-y-2">
                {items.map((entry) => (
                  <div key={entry.id} className="group flex flex-wrap items-center gap-2 p-3 rounded-xl bg-board-card border border-board-border hover:border-fire-500/20 transition-all">
                    <button onClick={() => handleToggle(entry)} className="min-h-11 min-w-11 flex items-center justify-center shrink-0 rounded-lg focus-visible:outline-2 focus-visible:outline-fire-500 disabled:opacity-50" disabled={!canWrite} aria-label={`${entry.checked ? "Mark incomplete" : "Mark complete"}: ${entry.template?.label || "Untitled"}`}>
                      {entry.checked ? (
                        <CheckCircle2 className="w-5 h-5 text-green-500" />
                      ) : (
                        <Circle className="w-5 h-5 text-board-muted" />
                      )}
                    </button>
                    <div className="min-w-0 flex-1 basis-32">
                      <span className={`block text-sm ${entry.checked ? "text-board-muted line-through" : "text-board-text"}`}>
                        {entry.template?.label || "Untitled"}
                      </span>
                      {entry.checked && entry.checkedBy && (
                        <span className="mt-0.5 block truncate text-xs text-board-muted">
                          Completed by {entry.checkedBy}{entry.checkedAt ? ` · ${new Date(entry.checkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}
                        </span>
                      )}
                    </div>
                    {canManageChecklist && (
                      <>
                        {/* Retagging has to be possible in place: every
                            existing item was written before categories
                            existed, and nobody will retype 32 checks. */}
                        <label className="sr-only" htmlFor={`cat-${entry.id}`}>
                          Department for {entry.template?.label || "this item"}
                        </label>
                        <select
                          id={`cat-${entry.id}`}
                          disabled={!canWrite}
                          value={normalizeCategory(entry.template?.category ?? "")}
                          onChange={(e) =>
                            void handleCategoryChange(entry, normalizeCategory(e.target.value))
                          }
                          className="min-h-11 max-w-full shrink-0 text-xs bg-transparent border border-board-border rounded-lg px-2 py-1 text-board-muted hover:text-board-text hover:border-fire-500/30 outline-none focus:border-fire-500/50 transition-colors"
                        >
                          {DEPARTMENT_ORDER.map((key) => (
                            <option key={key} value={key}>
                              {DEPARTMENT_LABELS[key]}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          disabled={!canWrite}
                          onClick={() => handleDeleteEntry(entry)}
                          className="min-h-11 min-w-11 rounded-lg p-2 text-board-muted transition-all hover:bg-red-500/20 hover:text-red-400 focus-visible:outline-2 focus-visible:outline-fire-500 disabled:opacity-50"
                          aria-label={`Remove ${entry.template?.label || "checklist item"} from this service`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}

          {loadingEntries ? (
            <p className="text-center text-sm text-board-muted py-8">Loading checklist...</p>
          ) : (
            !entryRead.error && totalCount === 0 && (
              <EmptyState
                icon={ListChecks}
                title="No checklist items for this date"
                description={
                  canManageChecklist
                    ? "Build your pre-show checklist — camera checks, audio line check, stream key verified. Add the first item below."
                    : workspaceCopy(
                        "Nothing to check off yet. A producer can add checklist items for this service.",
                        workspaceTerms,
                      )
                }
              />
            )
          )}
        </div>

        {/* Add new */}
        {canManageChecklist ? (
          <form onSubmit={handleAddTemplate} className="flex flex-wrap gap-2">
            <label htmlFor="checklist-new-label" className="sr-only">Checklist item</label>
            <input
              id="checklist-new-label"
              type="text"
              maxLength={200}
              disabled={writeLocked}
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="Add checklist item..."
              className="min-h-11 flex-1 basis-48 min-w-0 px-4 py-2.5 rounded-xl bg-board-card border border-board-border text-sm text-board-text placeholder:text-board-muted/50 outline-none focus:border-fire-500/50 focus:ring-1 focus:ring-fire-500/20 transition-all"
            />
            <label className="sr-only" htmlFor="new-category">
              Department
            </label>
            <select
              id="new-category"
              disabled={writeLocked}
              value={newCategory}
              onChange={(e) => setNewCategory(normalizeCategory(e.target.value))}
              className="min-h-11 shrink-0 px-3 py-2.5 rounded-xl bg-board-card border border-board-border text-sm text-board-text outline-none focus:border-fire-500/50 transition-all"
            >
              {DEPARTMENT_ORDER.map((key) => (
                <option key={key} value={key}>
                  {DEPARTMENT_LABELS[key]}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={!canWrite || !normalizeChecklistLabel(newLabel)}
              className="min-h-11 min-w-11 px-4 py-2.5 rounded-xl font-semibold text-sm text-black disabled:opacity-50 transition-all hover:shadow-lg hover:shadow-fire-500/20 active:scale-[0.98]"
              style={{ background: "linear-gradient(135deg, #FFC107 0%, #FF8F00 100%)" }}
              aria-label="Add checklist item"
            >
              <Plus className="w-4 h-4" />
            </button>
          </form>
        ) : (
          <p className="text-xs text-board-muted text-center">View only</p>
        )}
      </div>
      {ConfirmDialogEl}
      <Dialog open={blocker.status === "blocked"} onOpenChange={open => { if (!open) blocker.reset?.(); }}>
        <DialogContent><DialogHeader><DialogTitle>Leave this checklist?</DialogTitle>
          <DialogDescription>An unconfirmed save may still complete. Leaving discards the local draft and its retry controls. Review this checklist when you return.</DialogDescription></DialogHeader>
          <DialogFooter><Button variant="outline" onClick={() => blocker.reset?.()}>Stay</Button><Button onClick={() => blocker.proceed?.()}>Leave checklist</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={generatorOpen} onOpenChange={setGeneratorOpen}>
        <DialogContent className="max-h-[85vh] overflow-hidden border-board-border bg-board-card p-0 text-board-text sm:max-w-2xl">
          <DialogHeader className="border-b border-board-border px-6 py-5 pr-12">
            <div className="flex items-center gap-2">
              <span className="rounded-lg bg-fire-500/15 p-2 text-fire-400">
                <Sparkles className="h-4 w-4" />
              </span>
              <DialogTitle>Smart checklist draft</DialogTitle>
            </div>
            <DialogDescription className="text-board-muted">
              Based on the {formatDisplayDate(serviceDate)} rundown. Review every suggestion before adding it.
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[55vh] overflow-y-auto px-6 py-4">
            <ReadFailureNotice error={entryRead.error} refreshing={entryRead.refreshing} retry={entryRead.retry} label="Retry checklist" />
            {writeNotice}
            {generating ? (
              <div className="flex items-center justify-center gap-2 py-12 text-sm text-board-muted">
                <Loader2 className="h-4 w-4 animate-spin" /> Analyzing rundown cues…
              </div>
            ) : draftRead.error ? (
              <ReadFailureNotice error={draftRead.error} refreshing={draftRead.refreshing} retry={draftRead.retry} label="Retry checklist suggestions" />
            ) : draft.length === 0 ? (
              <div className="py-10 text-center">
                <ListChecks className="mx-auto mb-3 h-8 w-8 text-board-muted" />
                <p className="font-medium text-board-text">No new checks found</p>
                <p className="mt-1 text-sm text-board-muted">
                  Add more detail to rundown titles, notes, or cues—or the relevant checks may already be on this date.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="mb-3 flex items-center justify-between text-xs text-board-muted">
                  <span>{selectedSuggestionIds.size} of {draft.length} selected</span>
                  <button
                    type="button"
                    disabled={writeLocked}
                    onClick={() => setDraftSelection(
                      selectedSuggestionIds.size === draft.length
                        ? new Set()
                        : new Set(draft.map((suggestion) => suggestion.id)),
                    )}
                    className="min-h-11 px-2 font-medium text-fire-400 hover:text-fire-300"
                  >
                    {selectedSuggestionIds.size === draft.length ? "Clear all" : "Select all"}
                  </button>
                </div>
                {draft.map((suggestion) => {
                  const selected = selectedSuggestionIds.has(suggestion.id);
                  return (
                    <label
                      key={suggestion.id}
                      className={`flex cursor-pointer gap-3 rounded-xl border p-4 transition-colors ${
                        selected ? "border-fire-500/35 bg-fire-500/8" : "border-board-border bg-board-bg/30"
                      }`}
                    >
                      <input
                        type="checkbox"
                        disabled={writeLocked}
                        checked={selected}
                        onChange={() => setDraftSelection(() => {
                          const next = new Set(selectedSuggestionIds);
                          if (next.has(suggestion.id)) next.delete(suggestion.id);
                          else next.add(suggestion.id);
                          return next;
                        })}
                        className="mt-1 h-4 w-4 accent-amber-500"
                      />
                      <span className="min-w-0 flex-1 basis-32">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium text-board-text">{suggestion.label}</span>
                          <span className="rounded-full border border-board-border px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-board-muted">
                            {DEPARTMENT_LABELS[suggestion.category]}
                          </span>
                          {suggestion.existingTemplateId && (
                            <span className="text-xs font-medium text-emerald-400">Existing template</span>
                          )}
                        </span>
                        <span className="mt-1 block text-xs leading-relaxed text-board-muted">
                          {suggestion.reason}
                          {suggestion.sourceItemIds.length > 0 && (
                            <> Matched {suggestion.sourceItemIds.length} rundown {suggestion.sourceItemIds.length === 1 ? "item" : "items"}.</>
                          )}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          <DialogFooter className="border-t border-board-border px-6 py-4">
            <button
              type="button"
              onClick={() => setGeneratorOpen(false)}
              className="min-h-11 rounded-lg border border-board-border px-4 py-2 text-sm font-medium text-board-muted hover:text-board-text"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleApplyDraft()}
              disabled={!canWrite || generating || !!draftRead.error || draftRead.refreshing || selectedSuggestionIds.size === 0}
              className="min-h-11 inline-flex items-center justify-center gap-2 rounded-lg bg-gradient-to-br from-amber-400 to-amber-600 px-4 py-2 text-sm font-semibold text-black disabled:opacity-50"
            >
              {applyingDraft && <Loader2 className="h-4 w-4 animate-spin" />}
              Add {selectedSuggestionIds.size || "selected"} checks
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
