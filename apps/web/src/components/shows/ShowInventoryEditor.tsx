import { useState } from "react";
import { useShowInventory } from "@/hooks/useShowInventory";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type {
  SavedRundownSource,
  ShowInventorySummary,
} from "@/lib/show-inventory";

const button =
  "min-h-11 min-w-11 rounded-lg border border-board-border px-3 py-2 text-sm text-board-text whitespace-normal break-words disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2";
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
}: {
  orgId: string;
  userId: string;
  inventory: ShowInventorySummary[];
  archivedInventory: ShowInventorySummary[];
  savedTemplates: SavedRundownSource[];
  canManage: boolean;
  onUse: (item: ShowInventorySummary) => void;
  onChanged: (signal: AbortSignal) => Promise<void>;
}) {
  const work = useShowInventory({ orgId, userId }, onChanged);
  const [confirmation, setConfirmation] = useState<ShowInventorySummary | null>(
    null,
  );
  const { draft, attempt } = work;
  const missingSource =
    !!draft.sourceTemplateId &&
    !savedTemplates.some((source) => source.id === draft.sourceTemplateId);
  return (
    <div className="space-y-5 text-sm [overflow-wrap:anywhere]">
      <p className="text-board-muted">
        Reusable show definitions for future dates. Each is a snapshot: changing
        a scheduled show does not change inventory.
      </p>
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
                ? "Saving…"
                : "Reviewing original request…"}{" "}
              You can close this dialog and return to check the result.
            </p>
          )}
          {attempt.kind === "unconfirmed" && (
            <>
              <p role="alert">{attempt.message}</p>
              <p>
                The result is unconfirmed. Retry the same request, or review it
                before editing. Review cancels a request that has not reached
                the server.
              </p>
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
                  ? "Change confirmed. Refresh inventory to see the latest list."
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
              {attempt.message && <p role="alert">{attempt.message}</p>}
              <button
                type="button"
                className={button}
                disabled={attempt.refresh === "pending"}
                onClick={work.refresh}
              >
                {attempt.refresh === "pending"
                  ? "Refreshing inventory…"
                  : "Refresh inventory"}
              </button>
            </>
          )}
        </section>
      )}
      <div className="space-y-2" aria-label="Reusable shows">
        {inventory.length ? (
          inventory.map((item) => (
            <div
              key={item.id}
              className="flex flex-wrap items-center gap-2 rounded-xl border border-board-border bg-board-bg p-3"
            >
              <div className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
                <p className="font-medium text-board-text">{item.name}</p>
                <p className="text-board-muted">
                  {item.itemCount} rundown items
                  {item.defaultStartTime ? ` · ${item.defaultStartTime}` : ""}
                  {item.location ? ` · ${item.location}` : ""}
                </p>
              </div>
              <button
                type="button"
                className={button}
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
              {canManage && (
                <button
                  type="button"
                  className={button}
                  aria-label={`Archive ${item.name}`}
                  disabled={work.locked}
                  onClick={() => setConfirmation(item)}
                >
                  Archive
                </button>
              )}
            </div>
          ))
        ) : (
          <p className="rounded-xl border border-dashed border-board-border p-4 text-board-muted">
            No reusable shows yet.
          </p>
        )}
      </div>
      {!!archivedInventory.length && (
        <details className="rounded-xl border border-board-border p-3">
          <summary className="min-h-11 cursor-pointer py-3 text-board-muted">
            Archived ({archivedInventory.length})
          </summary>
          <div className="space-y-2">
            {archivedInventory.map((item) => (
              <div
                key={item.id}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-board-border p-3"
              >
                <p className="min-w-0 flex-1 text-board-muted">{item.name}</p>
                {canManage && (
                  <button
                    type="button"
                    className={button}
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
      {canManage && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!missingSource) work.create();
          }}
          className="space-y-3 border-t border-board-border pt-4"
        >
          <h3 className="font-semibold text-board-text">Add reusable show</h3>
          <fieldset disabled={work.locked} className="min-w-0 space-y-3">
            <label className="block text-board-muted">
              Show name
              <input
                className={input}
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
              <label className="block min-w-0 text-board-muted">
                Default start
                <input
                  type="time"
                  className={input}
                  value={draft.defaultStartTime}
                  onChange={(event) =>
                    work.setDraft((value) => ({
                      ...value,
                      defaultStartTime: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="block min-w-0 text-board-muted">
                Location
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
            <label className="block text-board-muted">
              Rundown source (optional)
              <select
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
            </label>
            {missingSource && (
              <p role="alert" className="text-red-300">
                The selected saved rundown is unavailable. Choose another source
                or explicitly select an empty rundown.
              </p>
            )}
            <label className="block text-board-muted">
              Description
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
            <button
              className={`${button} w-full bg-fire-500 font-semibold text-black`}
              disabled={work.locked || !draft.name.trim() || missingSource}
            >
              Add to inventory
            </button>
          </fieldset>
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
