import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  hashKey,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { runRouteLoad } from "@/lib/route-load-deadlines";
import {
  deleteShowResultSchema,
  type DeleteShowInput,
} from "@/lib/show-deletion-contract";

type Scope = { orgId: string; userId: string };
export type DeletionTarget = {
  showId: string;
  name: string;
  expectedUpdatedAt: string;
};
type Base = { target: DeletionTarget; command: DeleteShowInput };
export type ShowDeletionWork = Base &
  (
    | { kind: "confirming" }
    | { kind: "deleting" }
    | { kind: "unconfirmed"; message: string }
    | {
        kind: "rejected";
        message: string;
        refresh: "idle" | "pending" | "failed";
      }
    | {
        kind: "deleted";
        refresh: "idle" | "pending" | "failed" | "done";
        message?: string;
      }
  );
type State = Record<string, ShowDeletionWork | undefined>;
const empty: State = {};
const keyFor = (scope: Scope) => ["show-deletions", scope.userId, scope.orgId];
export function showDeletionLocksEdits(
  client: QueryClient,
  scope: Scope & { showId: string },
) {
  const work = client.getQueryData<State>(keyFor(scope))?.[scope.showId];
  return !!work && work.kind !== "rejected";
}

/** Schedule owns progress independently of a show row or its details modal. */
export function useShowDeletions(
  scope: Scope,
  options: {
    refresh: (signal: AbortSignal) => Promise<void>;
    onConfirmed: (showId: string) => void;
  },
) {
  const client = useQueryClient(),
    key = keyFor(scope),
    hash = hashKey(key);
  useQuery({
    queryKey: key,
    queryFn: () => empty,
    initialData: empty,
    enabled: false,
    gcTime: Infinity,
  });
  const read = () => client.getQueryData<State>(key);
  const work = useSyncExternalStore(
    useCallback(
      (notify) =>
        client.getQueryCache().subscribe((event) => {
          if (event.query.queryHash === hash) notify();
        }),
      [client, hash],
    ),
    () => read() ?? empty,
    () => empty,
  );
  const owner = useMemo(
    () => ({
      mounted: false,
      confirmations: new Map<string, ShowDeletionWork>(),
      refreshes: new Set<AbortController>(),
    }),
    [hash],
  );
  const current = useRef(owner),
    callbacks = useRef(options);
  current.current = owner;
  callbacks.current = options;
  const active = () => owner.mounted && current.current === owner;
  function replace(
    id: string,
    expected: ShowDeletionWork | undefined,
    next: ShowDeletionWork | undefined,
  ) {
    client.setQueryData<State>(key, (state) => {
      if (!state || state[id] !== expected) return state;
      const updated = { ...state };
      if (next) updated[id] = next;
      else delete updated[id];
      return updated;
    });
    // QueryClient may structurally share values. Own the actual stored entry.
    return read()?.[id];
  }
  useEffect(() => {
    owner.mounted = true;
    return () => {
      owner.mounted = false;
      for (const [id, claim] of owner.confirmations)
        replace(id, claim, undefined);
      for (const controller of owner.refreshes) controller.abort();
    };
    // The scope owns its confirmations and refreshes for this mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner]);

  async function refresh(id: string) {
    if (!active()) return;
    const source = read()?.[id];
    if (
      !source ||
      source.kind === "confirming" ||
      source.kind === "deleting" ||
      source.kind === "unconfirmed"
    )
      return;
    if (source.refresh === "pending") return;
    // A rejected deletion only needs the current page refreshed before a new
    // confirmation. Never reinterpret a transport timeout as a rejected delete.
    const controller = new AbortController();
    owner.refreshes.add(controller);
    const claim = replace(id, source, { ...source, refresh: "pending" });
    try {
      await runRouteLoad(
        (child) => callbacks.current.refresh(child.signal),
        controller.signal,
        12_000,
      );
      if (read()?.[id] !== claim) return;
      if (source.kind === "deleted")
        replace(id, claim, { ...source, refresh: "done", message: undefined });
      else replace(id, claim, undefined);
    } catch (error) {
      if (read()?.[id] !== claim) return;
      const message =
        error instanceof Error && error.message !== "Page loading timed out."
          ? error.message
          : "Refreshing Schedule timed out.";
      replace(id, claim, { ...source, refresh: "failed", message });
    } finally {
      owner.refreshes.delete(controller);
    }
  }
  async function execute(source: ShowDeletionWork) {
    const id = source.target.showId;
    if (read()?.[id] !== source) return;
    const claim = replace(id, source, {
      target: source.target,
      command: source.command,
      kind: "deleting",
    });
    try {
      const result = deleteShowResultSchema.parse(
        await runRouteLoad(
          async (controller) => {
            const { deleteService } = await import("@/lib/schedule");
            controller.signal.throwIfAborted();
            return deleteService({
              data: source.command,
              signal: controller.signal,
            });
          },
          undefined,
          15_000,
        ),
      );
      if (read()?.[id] !== claim) return;
      replace(
        id,
        claim,
        result.ok
          ? { ...source, kind: "deleted", refresh: "idle" }
          : {
              ...source,
              kind: "rejected",
              refresh: "idle",
              message: result.message,
            },
      );
      if (result.ok && active()) await refresh(id);
    } catch (error) {
      if (read()?.[id] !== claim) return;
      const message =
        error instanceof Error
          ? error.message === "Page loading timed out."
            ? "The deletion response timed out."
            : error.message
          : "Could not confirm deletion.";
      replace(id, claim, { ...source, kind: "unconfirmed", message });
    }
  }
  async function confirmDeletion(
    target: DeletionTarget,
    confirm: () => Promise<boolean>,
  ) {
    if (!active()) return;
    const id = target.showId,
      previous = read()?.[id];
    if (
      previous &&
      (previous.kind !== "rejected" || previous.refresh === "pending")
    )
      return;
    const details = client.getQueryData<{ attempt: unknown }>([
      "show-details",
      scope.userId,
      scope.orgId,
      id,
    ]);
    if (details?.attempt) return;
    const claim = replace(id, previous, {
      kind: "confirming",
      target,
      command: {
        ...scope,
        showId: id,
        expectedUpdatedAt: target.expectedUpdatedAt,
      },
    });
    if (!claim) return;
    owner.confirmations.set(id, claim);
    try {
      const approved = await confirm();
      if (read()?.[id] !== claim) return;
      if (!approved || !active()) {
        replace(id, claim, previous);
        return;
      }
      callbacks.current.onConfirmed(id);
      await execute(claim);
    } catch (error) {
      replace(id, claim, {
        ...claim,
        kind: "rejected",
        refresh: "idle",
        message:
          error instanceof Error
            ? error.message
            : "Could not confirm deletion. Try again.",
      });
    } finally {
      owner.confirmations.delete(id);
    }
  }
  function retry(id: string) {
    const source = read()?.[id];
    if (source?.kind === "unconfirmed" && active()) return execute(source);
  }
  function dismiss(id: string) {
    const source = read()?.[id];
    if (
      (source?.kind === "rejected" && source.refresh !== "pending") ||
      (source?.kind === "deleted" && source.refresh === "done")
    )
      replace(id, source, undefined);
  }
  return { work, confirmDeletion, retry, refresh, dismiss };
}
