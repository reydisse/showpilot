import { createFileRoute } from "@tanstack/react-router";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, CheckCircle2, Circle, ListChecks, Plus, Trash2 } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import {
  getChecklistEntries,
  addChecklistTemplate,
  addChecklistEntry,
  toggleChecklistEntry,
  deleteChecklistTemplate,
  updateChecklistTemplate,
} from "@/lib/data";
import {
  DEPARTMENT_LABELS,
  DEPARTMENT_ORDER,
  normalizeCategory,
  type DepartmentKey,
} from "@/lib/departments";
import { hasPermission } from "@/lib/app-permissions";
import { getOrgSettings } from "@/lib/settings";
import { getTodayDateString } from "@/lib/utils";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { useServiceDateRollover } from "@/hooks/useServiceDateRollover";

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

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
    const entries = await getChecklistEntries({ data: { orgId: context.orgId, serviceDate: today } });
    return {
      entries,
      orgId: context.orgId,
      role: context.role,
      orgTimezone: settings["org-timezone"],
    };
  },
  component: ChecklistPage,
});

function ChecklistPage() {
  const { entries: initialEntries, orgId, role, orgTimezone } = Route.useLoaderData();
  const [serviceDate, setServiceDate] = useState(() => getTodayDateString(orgTimezone));
  const [entries, setEntries] = useState(initialEntries as Array<{
    id: string;
    templateId: string;
    checked: boolean;
    checkedBy: string | null;
    template?: { label: string; category: string } | null;
  }>);
  const [loadingEntries, setLoadingEntries] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newCategory, setNewCategory] = useState<DepartmentKey>("general");
  const [adding, setAdding] = useState(false);

  const loadEntries = useCallback(async (date: string) => {
    setLoadingEntries(true);
    try {
      const latest = await getChecklistEntries({ data: { orgId, serviceDate: date } });
      setEntries(latest as typeof entries);
    } finally {
      setLoadingEntries(false);
    }
  }, [orgId]);

  useEffect(() => {
    setEntries(initialEntries as typeof entries);
  }, [initialEntries]);

  useEffect(() => {
    void loadEntries(serviceDate);
  }, [loadEntries, serviceDate]);

  useServiceDateRollover({
    serviceDate,
    timeZone: orgTimezone,
    onTodayChanged: (nextToday) => {
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
  const canManageChecklist = hasPermission(role, "checklist:access");

  const handleToggle = async (entryId: string, checked: boolean) => {
    if (!canManageChecklist) return;
    await toggleChecklistEntry({ data: { orgId, id: entryId, checked: !checked, checkedBy: checked ? null : "user" } });
    await loadEntries(serviceDate);
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
        await addChecklistEntry({ data: { orgId, templateId: tpl.id, serviceDate } });
      }
      setNewLabel("");
      // The department is deliberately sticky. Checks are written in
      // runs — five audio items, then four camera items — and resetting
      // to General after each one is how a list ends up uncategorised.
      await loadEntries(serviceDate);
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
    await loadEntries(serviceDate);
  };

  const handleDateChange = (days: number) => {
    setServiceDate((d) => shiftDate(d, days));
  };

  return (
    <div className="h-full overflow-auto">
      <div className="sticky top-0 z-10 bg-board-bg/80 backdrop-blur-xl border-b border-board-border px-6 py-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-board-text">Pre-Show Checklist</h1>
          <div className="flex items-center gap-2">
            <button onClick={() => handleDateChange(-1)} className="p-1.5 rounded-lg hover:bg-board-border text-board-muted hover:text-board-text transition-colors">
              <ChevronLeft className="w-4 h-4" />
            </button>
              <button
                onClick={() => setServiceDate(getTodayDateString(orgTimezone))}
                className="px-3 py-1.5 rounded-lg text-xs font-medium text-board-text bg-board-card border border-board-border hover:border-fire-500/50 transition-colors min-w-[160px] text-center"
              >
                {formatDisplayDate(serviceDate)}
              </button>
            <button onClick={() => handleDateChange(1)} className="p-1.5 rounded-lg hover:bg-board-border text-board-muted hover:text-board-text transition-colors">
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
                    <button onClick={() => handleToggle(entry.id, entry.checked)} className="shrink-0" disabled={!canManageChecklist}>
                      {entry.checked ? (
                        <CheckCircle2 className="w-5 h-5 text-green-500" />
                      ) : (
                        <Circle className="w-5 h-5 text-board-muted" />
                      )}
                    </button>
                    <span className={`flex-1 text-sm ${entry.checked ? "text-board-muted line-through" : "text-board-text"}`}>
                      {entry.template?.label || "Untitled"}
                    </span>
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
                        <button onClick={() => handleDeleteTemplate(entry.templateId)} className="opacity-0 group-hover:opacity-100 p-1 rounded-lg hover:bg-red-500/20 text-board-muted hover:text-red-400 transition-all">
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
            >
              <Plus className="w-4 h-4" />
            </button>
          </form>
        ) : (
          <p className="text-xs text-board-muted text-center">View only</p>
        )}
      </div>
      {ConfirmDialogEl}
    </div>
  );
}
