import { createFileRoute } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, CheckCircle2, Circle, ListChecks, Loader2, Plus, Sparkles, Trash2 } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import {
  getChecklistEntries,
  addChecklistTemplate,
  addChecklistEntry,
  toggleChecklistEntry,
  deleteChecklistTemplate,
  updateChecklistTemplate,
  getSmartChecklistDraft,
  applySmartChecklistDraft,
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
import { formatServicePickerLabel } from "@/lib/service-picker";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { useServiceDateRollover } from "@/hooks/useServiceDateRollover";
import { getRundownOpeningDate, getRundownState } from "@/lib/rundown";
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
  loader: async ({ context }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, ["checklist:view", "checklist:access"], context.slug, context.orgId);
    const settings = await getOrgSettings({ data: { orgId: context.orgId } });
    const today = getTodayDateString(settings["org-timezone"]);
    const opening = await getRundownOpeningDate({ data: { orgId: context.orgId, today } });
    const entries = await getChecklistEntries({ data: { orgId: context.orgId, serviceDate: opening.serviceDate, showId: opening.showId } });
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
  const { entries: initialEntries, serviceDate: initialServiceDate, showId: initialShowId, shows, orgId, role, grantedPermissions, orgTimezone } = Route.useLoaderData();
  const [serviceDate, setServiceDate] = useState(initialServiceDate);
  const [showId, setShowId] = useState<string | undefined>(initialShowId);
  const [entries, setEntries] = useState(initialEntries as Array<{
    id: string;
    templateId: string;
    checked: boolean;
    checkedBy: string | null;
    checkedAt: string | Date | null;
    template?: { label: string; category: string } | null;
  }>);
  const [loadingEntries, setLoadingEntries] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newCategory, setNewCategory] = useState<DepartmentKey>("general");
  const [adding, setAdding] = useState(false);
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [applyingDraft, setApplyingDraft] = useState(false);
  const [draft, setDraft] = useState<SmartChecklistDraft[]>([]);
  const [selectedSuggestionIds, setSelectedSuggestionIds] = useState<Set<string>>(new Set());
  const [generatorError, setGeneratorError] = useState("");

  const loadEntries = useCallback(async (date: string, requestedShowId?: string) => {
    setLoadingEntries(true);
    try {
      const rundown = await getRundownState({ data: { orgId, serviceDate: date, showId: requestedShowId } });
      const resolvedShowId = rundown.meta?.showId;
      const latest = await getChecklistEntries({ data: { orgId, serviceDate: date, showId: resolvedShowId } });
      setShowId(resolvedShowId);
      setEntries(latest as typeof entries);
    } finally {
      setLoadingEntries(false);
    }
  }, [orgId]);

  useEffect(() => {
    setEntries(initialEntries as typeof entries);
  }, [initialEntries]);

  useEffect(() => {
    void loadEntries(serviceDate, showId);
  }, [loadEntries, serviceDate, showId]);

  useServiceDateRollover({
    serviceDate,
    timeZone: orgTimezone,
    onTodayChanged: (nextToday) => {
      setShowId(undefined);
      setServiceDate(nextToday);
    },
  });

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
  const canManageChecklist =
    hasEffectivePermission(role, grantedPermissions, "checklist:access") && Boolean(showId);

  const handleToggle = async (entryId: string, checked: boolean) => {
    if (!canManageChecklist) return;
    await toggleChecklistEntry({ data: { orgId, id: entryId, checked: !checked } });
    await loadEntries(serviceDate, showId);
  };

  const handleAddTemplate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canManageChecklist) return;
    if (!newLabel.trim()) return;
    setAdding(true);
    try {
      const tpl = await addChecklistTemplate({
        data: { orgId, label: newLabel.trim(), category: newCategory },
      });
      if (tpl) {
        await addChecklistEntry({ data: { orgId, templateId: tpl.id, serviceDate, showId } });
      }
      setNewLabel("");
      // The department is deliberately sticky. Checks are written in
      // runs — five audio items, then four camera items — and resetting
      // to General after each one is how a list ends up uncategorised.
      await loadEntries(serviceDate, showId);
    } finally {
      setAdding(false);
    }
  };

  /**
   * Retag an item. Categories exist for the dashboard's benefit: a
   * department card can only report "2 checks outstanding" if the checks
   * know which department they belong to.
   */
  const handleCategoryChange = async (templateId: string, category: DepartmentKey) => {
    if (!canManageChecklist) return;
    setEntries((prev) =>
      prev.map((e) =>
        e.templateId === templateId && e.template
          ? { ...e, template: { ...e.template, category } }
          : e,
      ),
    );
    await updateChecklistTemplate({ data: { orgId, id: templateId, updates: { category } } });
  };

  const { confirm, ConfirmDialogEl } = useConfirmDialog();

  const handleDeleteTemplate = async (id: string) => {
    if (!canManageChecklist) return;
    const ok = await confirm({
      title: "Delete checklist item",
      description: "Delete this checklist item? This action cannot be undone.",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    await deleteChecklistTemplate({ data: { orgId, id } });
    await loadEntries(serviceDate, showId);
  };

  const handleDateChange = (direction: number) => {
    const index = shows.findIndex((show) => show.id === showId);
    const next = shows[index + direction];
    if (!next) return;
    setShowId(next.id);
    setServiceDate(next.serviceDate);
  };

  const handleGenerateDraft = async () => {
    if (!canManageChecklist) return;
    setGeneratorOpen(true);
    setGenerating(true);
    setGeneratorError("");
    try {
      const suggestions = await getSmartChecklistDraft({ data: { orgId, serviceDate, showId } });
      setDraft(suggestions);
      setSelectedSuggestionIds(new Set(suggestions.map((suggestion) => suggestion.id)));
    } catch (error) {
      setDraft([]);
      setGeneratorError(error instanceof Error ? error.message : "Could not analyze this rundown.");
    } finally {
      setGenerating(false);
    }
  };

  const handleApplyDraft = async () => {
    if (selectedSuggestionIds.size === 0) return;
    setApplyingDraft(true);
    setGeneratorError("");
    try {
      await applySmartChecklistDraft({
        data: { orgId, serviceDate, showId, suggestionIds: Array.from(selectedSuggestionIds) },
      });
      await loadEntries(serviceDate, showId);
      setGeneratorOpen(false);
    } catch (error) {
      setGeneratorError(error instanceof Error ? error.message : "Could not add the selected checks.");
    } finally {
      setApplyingDraft(false);
    }
  };

  return (
    <div className="h-full overflow-auto">
      <div className="sticky top-0 z-10 bg-board-bg/80 backdrop-blur-xl border-b border-board-border px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-board-text">Pre-Show Checklist</h1>
            {canManageChecklist && (
              <button
                type="button"
                onClick={() => void handleGenerateDraft()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-fire-500/30 bg-fire-500/10 px-2.5 py-1.5 text-xs font-semibold text-fire-400 transition-colors hover:bg-fire-500/20"
              >
                <Sparkles className="h-3.5 w-3.5" />
                Generate from rundown
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => handleDateChange(-1)} className="p-1.5 rounded-lg hover:bg-board-border text-board-muted hover:text-board-text transition-colors" aria-label="Previous service date">
              <ChevronLeft className="w-4 h-4" />
            </button>
              <select
                value={showId ?? ""}
                onChange={(event) => {
                  const selected = shows.find((show) => show.id === event.target.value);
                  if (!selected) return;
                  setShowId(selected.id);
                  setServiceDate(selected.serviceDate);
                }}
                aria-label="Select show"
                className="min-w-[210px] rounded-lg border border-board-border bg-board-card px-3 py-1.5 text-xs font-medium text-board-text"
              >
                {!showId && <option value="">No planned show</option>}
                {shows.map((show) => (
                  <option key={show.id} value={show.id}>
                    {formatServicePickerLabel(show, { timeZone: orgTimezone })}
                  </option>
                ))}
              </select>
            <button onClick={() => handleDateChange(1)} className="p-1.5 rounded-lg hover:bg-board-border text-board-muted hover:text-board-text transition-colors" aria-label="Next service date">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      <div className="p-6 max-w-xl mx-auto">
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

        {/* Entries, grouped by department. Under pressure an operator
            works one department at a time — the audio tech does not care
            what lighting still has open. Groups with nothing in them are
            not rendered. */}
        <div className="space-y-5 mb-6">
          {grouped.map(({ key, items }) => (
            <div key={key}>
              {showGroupHeadings && (
                <div className="flex items-baseline justify-between mb-2 px-1">
                  <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-board-muted">
                    {DEPARTMENT_LABELS[key]}
                  </h2>
                  <span className="text-[11px] text-board-muted tabular-nums">
                    {items.filter((e) => e.checked).length}/{items.length}
                  </span>
                </div>
              )}
              <div className="space-y-2">
                {items.map((entry) => (
                  <div key={entry.id} className="group flex items-center gap-3 p-3 rounded-xl bg-board-card border border-board-border hover:border-fire-500/20 transition-all">
                    <button onClick={() => handleToggle(entry.id, entry.checked)} className="shrink-0" disabled={!canManageChecklist} aria-label={`${entry.checked ? "Mark incomplete" : "Mark complete"}: ${entry.template?.label || "Untitled"}`}>
                      {entry.checked ? (
                        <CheckCircle2 className="w-5 h-5 text-green-500" />
                      ) : (
                        <Circle className="w-5 h-5 text-board-muted" />
                      )}
                    </button>
                    <div className="min-w-0 flex-1">
                      <span className={`block text-sm ${entry.checked ? "text-board-muted line-through" : "text-board-text"}`}>
                        {entry.template?.label || "Untitled"}
                      </span>
                      {entry.checked && entry.checkedBy && (
                        <span className="mt-0.5 block truncate text-[10px] text-board-muted">
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
                          value={normalizeCategory(entry.template?.category ?? "")}
                          onChange={(e) =>
                            void handleCategoryChange(entry.templateId, e.target.value as DepartmentKey)
                          }
                          className="shrink-0 text-[11px] bg-transparent border border-board-border rounded-lg px-2 py-1 text-board-muted hover:text-board-text hover:border-fire-500/30 outline-none focus:border-fire-500/50 transition-colors"
                        >
                          {DEPARTMENT_ORDER.map((key) => (
                            <option key={key} value={key}>
                              {DEPARTMENT_LABELS[key]}
                            </option>
                          ))}
                        </select>
                        <button onClick={() => handleDeleteTemplate(entry.templateId)} className="rounded-lg p-2 text-board-muted opacity-100 transition-all hover:bg-red-500/20 hover:text-red-400 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus-visible:opacity-100" aria-label={`Delete ${entry.template?.label || "checklist item"}`}>
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
          ) : totalCount === 0 && (
            <EmptyState
              icon={ListChecks}
              title="No checklist items for this date"
              description={
                canManageChecklist
                  ? "Build your pre-show checklist — camera checks, audio line check, stream key verified. Add the first item below."
                  : "Nothing to check off yet. A producer can add checklist items for this service."
              }
            />
          )}
        </div>

        {/* Add new */}
        {canManageChecklist ? (
          <form onSubmit={handleAddTemplate} className="flex gap-2">
            <input
              type="text"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="Add checklist item..."
              className="flex-1 min-w-0 px-4 py-2.5 rounded-xl bg-board-card border border-board-border text-sm text-board-text placeholder:text-board-muted/50 outline-none focus:border-fire-500/50 focus:ring-1 focus:ring-fire-500/20 transition-all"
            />
            <label className="sr-only" htmlFor="new-category">
              Department
            </label>
            <select
              id="new-category"
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value as DepartmentKey)}
              className="shrink-0 px-3 py-2.5 rounded-xl bg-board-card border border-board-border text-sm text-board-text outline-none focus:border-fire-500/50 transition-all"
            >
              {DEPARTMENT_ORDER.map((key) => (
                <option key={key} value={key}>
                  {DEPARTMENT_LABELS[key]}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={adding || !newLabel.trim()}
              className="px-4 py-2.5 rounded-xl font-semibold text-sm text-black disabled:opacity-50 transition-all hover:shadow-lg hover:shadow-fire-500/20 active:scale-[0.98]"
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
            {generating ? (
              <div className="flex items-center justify-center gap-2 py-12 text-sm text-board-muted">
                <Loader2 className="h-4 w-4 animate-spin" /> Analyzing rundown cues…
              </div>
            ) : generatorError ? (
              <div className="rounded-xl border border-red-500/25 bg-red-500/10 p-4 text-sm text-red-300">
                {generatorError}
              </div>
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
                    onClick={() => setSelectedSuggestionIds(
                      selectedSuggestionIds.size === draft.length
                        ? new Set()
                        : new Set(draft.map((suggestion) => suggestion.id)),
                    )}
                    className="font-medium text-fire-400 hover:text-fire-300"
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
                        checked={selected}
                        onChange={() => setSelectedSuggestionIds((current) => {
                          const next = new Set(current);
                          if (next.has(suggestion.id)) next.delete(suggestion.id);
                          else next.add(suggestion.id);
                          return next;
                        })}
                        className="mt-1 h-4 w-4 accent-amber-500"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium text-board-text">{suggestion.label}</span>
                          <span className="rounded-full border border-board-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-board-muted">
                            {DEPARTMENT_LABELS[suggestion.category]}
                          </span>
                          {suggestion.existingTemplateId && (
                            <span className="text-[10px] font-medium text-emerald-400">Existing template</span>
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
              className="rounded-lg border border-board-border px-4 py-2 text-sm font-medium text-board-muted hover:text-board-text"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleApplyDraft()}
              disabled={generating || applyingDraft || selectedSuggestionIds.size === 0}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-gradient-to-br from-amber-400 to-amber-600 px-4 py-2 text-sm font-semibold text-black disabled:opacity-50"
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
