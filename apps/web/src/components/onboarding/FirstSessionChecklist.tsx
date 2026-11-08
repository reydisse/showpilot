import { useWorkspace } from "@/components/workspace/WorkspaceProvider";
import { moduleForSurface } from "@showpilot/shared";
import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { withOperationTimeout } from "@/lib/operation-timeout";
import {
  firstSessionResultSchema,
  firstSessionStateSchema,
  firstSessionWriteSchema,
  type FirstSessionWrite,
} from "@/lib/first-session-checklist";
import { Link } from "@tanstack/react-router";
import { Check, ChevronRight, ListChecks, X } from "lucide-react";
import { track } from "@/lib/analytics";
import {
  getFirstSessionChecklist,
  updateFirstSessionChecklist,
} from "@/lib/onboarding";

// Personal checklist. Reads and commands are bounded; exact failed requests
// survive navigation in the account/org-scoped query cache.

const ITEMS = [
  { id: "rename-item", label: "Rename a rundown item", to: "/$slug/rundown" },
  {
    id: "connect-device",
    label: "Connect a device",
    to: "/$slug/dashboard/devices",
  },
  { id: "invite-teammate", label: "Invite a teammate", to: "/$slug/team" },
  {
    id: "open-board",
    label: "Open the kiosk / board view",
    to: "/$slug/board",
  },
] as const;

export function FirstSessionChecklist({
  orgId,
  slug,
  userId,
}: {
  orgId: string;
  slug: string;
  userId: string;
}) {
  const workspace = useWorkspace();
  const items = ITEMS.filter((item) => {
    const module = moduleForSurface("web", item.to.replace("/$slug/", ""));
    return !module || workspace.modules.includes(module);
  }).map((item) => ({
    ...item,
    label:
      item.id === "rename-item"
        ? `Rename a rundown ${workspace.terms.item.toLowerCase()}`
        : item.label,
  }));
  const client = useQueryClient();
  const queryKey = ["first-session-checklist", orgId, userId];
  const mutationKey = ["first-session-checklist-write", orgId, userId];
  const state = useQuery({
    queryKey,
    retry: false,
    networkMode: "always",
    queryFn: async ({ signal }) => {
      const controller = new AbortController();
      const cancel = () => controller.abort(signal.reason);
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      try {
        return firstSessionStateSchema.parse(
          await withOperationTimeout(
            getFirstSessionChecklist({
              data: { orgId },
              signal: controller.signal,
            }),
            8_000,
            "The checklist could not be loaded. Retry to check saved progress.",
          ),
        );
      } finally {
        signal.removeEventListener("abort", cancel);
        controller.abort();
      }
    },
  });
  const history = useMutationState({
    filters: { mutationKey, exact: true },
    select: (mutation) => {
      const command = firstSessionWriteSchema.safeParse(
        mutation.state.variables,
      );
      const result = firstSessionResultSchema.safeParse(mutation.state.data);
      return {
        status: mutation.state.status,
        command: command.success ? command.data : null,
        result: result.success ? result.data : null,
        at: mutation.state.submittedAt,
      };
    },
  });
  const latest = history.at(-1);
  const pending = latest?.status === "pending";
  const unfinished =
    latest?.command && (pending || latest.status === "error")
      ? latest.command
      : null;
  const conflict = latest?.result?.outcome === "conflict";
  const clearHistory = () => {
    for (const entry of client
      .getMutationCache()
      .findAll({ mutationKey, exact: true }))
      if (entry.state.status !== "pending")
        client.getMutationCache().remove(entry);
  };
  const mutation = useMutation({
    mutationKey,
    retry: false,
    networkMode: "always",
    gcTime: Infinity,
    onMutate: async () => {
      await client.cancelQueries({ queryKey, exact: true });
      return { readAt: client.getQueryState(queryKey)?.dataUpdatedAt };
    },
    mutationFn: async (command: FirstSessionWrite) => {
      const controller = new AbortController();
      try {
        const result = firstSessionResultSchema.parse(
          await withOperationTimeout(
            updateFirstSessionChecklist({
              data: command,
              signal: controller.signal,
            }),
            10_000,
            "Checklist change was not confirmed. Retry the same change.",
          ),
        );
        if (result.requestId !== command.requestId)
          throw new Error(
            "Checklist acknowledgement did not match the change.",
          );
        return result;
      } finally {
        controller.abort();
      }
    },
    onSuccess: async (result, _command, context) => {
      await client.cancelQueries({ queryKey, exact: true });
      if (client.getQueryState(queryKey)?.dataUpdatedAt === context?.readAt)
        client.setQueryData(queryKey, result.state);
      else void client.invalidateQueries({ queryKey, exact: true });
      if (
        result.outcome === "applied" &&
        items.length > 0 &&
        items.every((item) => result.state.completed.includes(item.id))
      )
        track("first_session_checklist_completed", {});
    },
    onSettled: clearHistory,
  });
  const readFailure =
    state.isError ||
    (state.isFetching && state.errorUpdatedAt > state.dataUpdatedAt);
  const locked = !state.data || readFailure || !!unfinished || conflict;
  const change = (action: FirstSessionWrite["action"]) => {
    if (locked || !state.data?.show) return;
    mutation.mutate({
      orgId,
      requestId: crypto.randomUUID(),
      expectedSnapshot: state.data.snapshot,
      action,
    });
  };
  if (!state.data?.show && !readFailure && !unfinished && !conflict)
    return null;
  const completed = state.data?.completed ?? [];
  const actionClass =
    "min-h-11 min-w-11 rounded-lg border border-board-border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-fire-500 disabled:opacity-40";
  return (
    <section
      aria-label="First session checklist"
      className="fixed bottom-4 right-4 z-40 max-h-[80dvh] w-[calc(100vw-2rem)] max-w-sm space-y-3 overflow-y-auto rounded-2xl border border-board-border bg-board-card p-4 shadow-2xl"
    >
      <header className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-board-text">
          <ListChecks className="h-4 w-4 shrink-0 text-fire-500" />
          First session checklist
        </h2>
        {state.data?.show && (
          <button
            type="button"
            disabled={locked}
            onClick={() => change({ kind: "dismiss" })}
            aria-label="Dismiss checklist"
            className={`${actionClass} grid shrink-0 place-items-center p-2`}
          >
            <X className="size-4" />
          </button>
        )}
      </header>
      {readFailure && (
        <div role="alert" className="space-y-2 text-sm text-amber-200">
          <p>The checklist could not be loaded. Saved progress is unchanged.</p>
          <p>
            Last failed read{" "}
            <time dateTime={new Date(state.errorUpdatedAt).toISOString()}>
              {new Date(state.errorUpdatedAt).toLocaleTimeString()}
            </time>
          </p>
          <button
            className={actionClass}
            disabled={state.isFetching}
            onClick={() => void state.refetch()}
          >
            {state.isFetching ? "Retrying…" : "Retry checklist"}
          </button>
        </div>
      )}
      {pending && (
        <p role="status" className="text-sm text-board-muted">
          Confirming checklist change…
        </p>
      )}
      {unfinished && !pending && (
        <div role="alert" className="space-y-2 text-sm text-amber-200">
          <p>
            Your checklist change was not confirmed and may have saved. Retry
            checks that same change without undoing newer progress.
          </p>
          <p>
            Last failed change{" "}
            <time dateTime={new Date(latest!.at).toISOString()}>
              {new Date(latest!.at).toLocaleTimeString()}
            </time>
          </p>
          <button
            className={actionClass}
            onClick={() => mutation.mutate(unfinished)}
          >
            Retry checklist change
          </button>
        </div>
      )}
      {conflict && (
        <div role="alert" className="space-y-2 text-sm text-amber-200">
          <p>
            The checklist changed elsewhere. Your change was not applied. Review
            the saved progress before making another change.
          </p>
          <button className={actionClass} onClick={clearHistory}>
            Use saved checklist
          </button>
        </div>
      )}
      {state.data?.show && (
        <ul className="space-y-1">
          {items.map((item) => {
            const done = completed.includes(item.id);
            return (
              <li key={item.id} className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={locked}
                  aria-pressed={done}
                  onClick={() =>
                    change({ kind: "item", item: item.id, completed: !done })
                  }
                  aria-label={
                    done
                      ? `Mark "${item.label}" not done`
                      : `Mark "${item.label}" done`
                  }
                  className={`flex size-11 shrink-0 items-center justify-center rounded-lg border focus-visible:outline-2 focus-visible:outline-fire-500 disabled:opacity-40 ${done ? "border-green-500/40 bg-green-500/15 text-green-400" : "border-board-border text-transparent hover:border-board-muted"}`}
                >
                  <Check className="size-4" />
                </button>
                <Link
                  to={item.to}
                  params={{ slug }}
                  className={`flex min-h-11 min-w-0 flex-1 items-center justify-between gap-1 rounded px-1 py-2 text-sm focus-visible:outline-2 focus-visible:outline-fire-500 ${done ? "text-board-muted line-through" : "text-board-text hover:text-fire-400"}`}
                >
                  {item.label}
                  <ChevronRight className="size-4 shrink-0" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
