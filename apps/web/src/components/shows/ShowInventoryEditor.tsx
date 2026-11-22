import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DateTimePicker } from "@/components/ui/date-time-picker";
import { plainFailure } from "@showpilot/shared/ui-feedback";
import { QuietActivity } from "@/components/ui/QuietActivity";
import { useEffect, useState } from "react";
import { MoreHorizontal, Plus } from "lucide-react";
import { modalCancel, modalFooter, modalHint, modalPrimary } from "@/components/schedule/modal-a";
import { useShowInventory } from "@/hooks/useShowInventory";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type {
  SavedRundownSource,
  ShowInventorySummary,
} from "@/lib/show-inventory";

const button =
  "min-h-11 min-w-11 rounded-lg border border-board-border px-3 py-2 text-sm text-board-text whitespace-normal break-words disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2";
const secondary =
  "inline-flex h-7 shrink-0 items-center rounded-md border border-[var(--sa-border-strong)] bg-[var(--sa-surface-2)] px-2.5 text-xs font-medium text-board-text hover:bg-[var(--sa-surface-3)] disabled:opacity-40";
const input =
  "mt-1 block min-h-11 w-full min-w-0 rounded-lg border border-board-border bg-board-bg px-3 py-2 text-base text-board-text disabled:opacity-60";

export function ShowInventoryEditor({
  orgId,
  userId,
  inventory,
  archivedInventory,
  savedTemplates,
  canManage,
  onUse,
  onChanged,
  onCreatingChange,
}: {
  orgId: string;
  userId: string;
  inventory: ShowInventorySummary[];
  archivedInventory: ShowInventorySummary[];
  savedTemplates: SavedRundownSource[];
  canManage: boolean;
  onUse: (item: ShowInventorySummary) => void;
  onChanged: (signal: AbortSignal) => Promise<void>;
  /** Lets the modal swap its title between "Saved shows" and "New saved show". */
  onCreatingChange?: (creating: boolean) => void;
}) {
  const [creating, setCreating] = useState(false);
  useEffect(() => { onCreatingChange?.(creating); }, [creating, onCreatingChange]);
  const work = useShowInventory({ orgId, userId }, onChanged);
  const [confirmation, setConfirmation] = useState<ShowInventorySummary | null>(
    null,
  );
  const { draft, attempt } = work;
  const missingSource =
    !!draft.sourceTemplateId &&
    !savedTemplates.some((source) => source.id === draft.sourceTemplateId);
  return (
    <div className="space-y-4 text-sm [overflow-wrap:anywhere]">
      {work.notice && (
        <p
          role="status"
          className="rounded-lg border border-board-border p-3 text-board-text"
        >
          {work.notice}
        </p>
      )}
      {attempt && (
        <section
          aria-label="Inventory change progress"
          aria-live="polite"
          className="space-y-2 rounded-lg border border-board-border p-3 text-board-text"
        >
          <p className="font-semibold">{attempt.label}</p>
          {(attempt.kind === "saving" || attempt.kind === "reviewing") && (
            <p>
              {attempt.kind === "saving"
                ? <QuietActivity label="Saving…" />
                : "Reviewing original request…"}{" "}
              You can close this dialog and return to check the result.
            </p>
          )}
          {attempt.kind === "unconfirmed" && (
            <>
              <p role="alert">{plainFailure((attempt.message) ?? "")}</p>
              <p>
                This change needs attention.</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={button} onClick={work.retry}>
                  Retry change
                </button>
                <button type="button" className={button} onClick={work.review}>
                  Review original request
                </button>
              </div>
            </>
          )}
          {attempt.kind === "settled" && (
            <>
              <p>
                {attempt.result.outcome === "applied"
                  ? ""
                  : attempt.result.outcome === "superseded"
                    ? "The original change succeeded. This item was changed again afterward; those later changes are preserved."
                    : attempt.result.outcome === "removed"
                      ? "This item was removed. Retrying this request will not recreate it."
                      : "The item or its source changed before this request could apply. Refresh and review the current details."}
              </p>
              {attempt.result.item && (
                <p>
                  Current item: {attempt.result.item.name} ·{" "}
                  {attempt.result.item.archivedAt ? "Archived" : "Active"}
                </p>
              )}
              {attempt.message && <p role="alert">{plainFailure((attempt.message) ?? "")}</p>}
              <button
                type="button"
                className={button}
                disabled={attempt.refresh === "pending"}
                onClick={work.refresh}
               aria-label={attempt.refresh === "pending"
                  ? "Refreshing inventory…"
                  : "Refresh inventory"}>
                {attempt.refresh === "pending"
                  ? <QuietActivity label="Refreshing inventory…" />
                  : "Refresh inventory"}
              </button>
            </>
          )}
        </section>
      )}
      {!creating && <>
      <div className="-mx-5 -mt-4 border-t border-[var(--sa-border)]" aria-label="Reusable shows">
        {inventory.length ? (
          inventory.map((item) => (
            <div
              key={item.id}
              className="flex min-h-14 items-center gap-2 py-2 pl-5 pr-3 shadow-[inset_0_-1px_0_var(--sa-border)] hover:bg-[var(--sa-surface-2)]"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <p className="truncate text-[13px] font-medium text-board-text">{item.name}</p>
                <p className="truncate text-xs text-[var(--sa-ink-3)]">
                  {item.itemCount} rundown {item.itemCount === 1 ? "item" : "items"}
                  {item.defaultStartTime ? ` · ${item.defaultStartTime}` : ""}
                  {item.location ? ` · ${item.location}` : ""}
                </p>
              </div>
              <button
                type="button"
                className={secondary}
                aria-label={`Use ${item.name}`}
                disabled={
                  !!attempt &&
                  attempt.command.operation.kind === "archive" &&
                  attempt.command.operation.id === item.id
                }
                onClick={() => onUse(item)}
              >
                Use
              </button>
              {canManage ? (
                <DropdownMenu>
                  <DropdownMenuTrigger className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--sa-ink-3)] hover:bg-[var(--sa-surface-3)] hover:text-board-text data-[state=open]:bg-[var(--sa-surface-3)] disabled:opacity-40" aria-label={`Actions for ${item.name}`} disabled={work.locked}><MoreHorizontal className="h-4 w-4" /></DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="schedule-a min-w-40 rounded-lg border-[var(--sa-border-strong)] bg-[var(--sa-surface)] p-1 text-board-text">
                    <DropdownMenuItem onSelect={() => setConfirmation(item)} className="rounded-md px-2.5 py-2 text-[13px]">Archive</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : <span className="w-7" />}
            </div>
          ))
        ) : (
          <p className="px-5 py-6 text-[13px] text-[var(--sa-ink-3)]">
            No saved shows yet. Save a show you run often and start new dates from it.
          </p>
        )}
      </div>
      {!!archivedInventory.length && (
        <details className="text-[13px]">
          <summary className="flex min-h-9 cursor-pointer items-center text-xs text-[var(--sa-ink-3)] hover:text-board-text">
            Archived ({archivedInventory.length})
          </summary>
          <div className="space-y-2">
            {archivedInventory.map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-2 py-1.5"
              >
                <p className="min-w-0 flex-1 text-[var(--sa-ink-2)]">{item.name}</p>
                {canManage && (
                  <button
                    type="button"
                    className={secondary}
                    aria-label={`Restore ${item.name}`}
                    disabled={work.locked}
                    onClick={() => work.archive(item, false)}
                  >
                    Restore
                  </button>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
      </>}
      {!creating && <div className={`${modalFooter} justify-between`}>
        <span className="text-xs text-[var(--sa-ink-3)]">{inventory.length} saved {inventory.length === 1 ? "show" : "shows"}</span>
        {canManage ? <button type="button" className={modalPrimary} onClick={() => setCreating(true)}><Plus className="h-3.5 w-3.5" strokeWidth={2} />New saved show</button> : null}
      </div>}
      {canManage && creating && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!missingSource) work.create();
          }}
          className="space-y-4"
        >
          <fieldset disabled={work.locked} className="min-w-0 space-y-4">
            <label className="block">
              Name
              <input
                className={input}
                placeholder="Evening show, rehearsal, conference session…"
                required
                maxLength={120}
                value={draft.name}
                onChange={(event) =>
                  work.setDraft((value) => ({
                    ...value,
                    name: event.target.value,
                  }))
                }
              />
            </label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block min-w-0">
                Default start time
                <DateTimePicker
                  kind="time"
                  className={input}
                  value={draft.defaultStartTime}
                  onValueChange={(time) =>
                    work.setDraft((value) => ({
                      ...value,
                      defaultStartTime: time,
                    }))
                  }
                />
              </label>
              <label className="block min-w-0">
                Venue
                <input
                  className={input}
                  maxLength={240}
                  value={draft.location}
                  onChange={(event) =>
                    work.setDraft((value) => ({
                      ...value,
                      location: event.target.value,
                    }))
                  }
                />
              </label>
            </div>
            <label className="block">
              Rundown source
              <select
                aria-label="Rundown source"
                className={input}
                value={draft.sourceTemplateId ?? ""}
                onChange={(event) =>
                  work.setDraft((value) => ({
                    ...value,
                    sourceTemplateId: event.target.value || null,
                  }))
                }
              >
                <option value="">Start with an empty rundown</option>
                {missingSource && (
                  <option value={draft.sourceTemplateId!} disabled>
                    Unavailable saved rundown
                  </option>
                )}
                {savedTemplates.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name} · {source.itemCount} items
                  </option>
                ))}
              </select>
              <span className={modalHint}>{draft.sourceTemplateId ? "Copies that rundown as the starting point." : "New dates start with an empty rundown."}</span>
            </label>
            {missingSource && (
              <p role="alert" className="text-red-300">
                The selected saved rundown is unavailable. Choose another source
                or explicitly select an empty rundown.
              </p>
            )}
            <label className="block">
              Description (optional)
              <textarea
                className={`${input} min-h-20 resize-y`}
                maxLength={500}
                value={draft.description}
                onChange={(event) =>
                  work.setDraft((value) => ({
                    ...value,
                    description: event.target.value,
                  }))
                }
              />
            </label>
          </fieldset>
          <div className={modalFooter}>
            <button type="button" className={modalCancel} onClick={() => setCreating(false)}>Back</button>
            <button
              className={modalPrimary}
              disabled={work.locked || !draft.name.trim() || missingSource}
            >
              Save show
            </button>
          </div>
        </form>
      )}
      <ConfirmDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
        title="Archive reusable show?"
        description={`Archive “${confirmation?.name ?? ""}” from inventory? Scheduled shows are unchanged. You can restore this definition from Archived.`}
        confirmLabel="Archive show"
        variant="warning"
        confirmDisabled={work.locked || !canManage}
        onConfirm={() => {
          if (confirmation) work.archive(confirmation, true);
          setConfirmation(null);
        }}
      />
    </div>
  );
}
