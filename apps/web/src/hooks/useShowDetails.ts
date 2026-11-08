import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { hashKey, useQuery, useQueryClient } from "@tanstack/react-query";
import { runRouteLoad } from "@/lib/route-load-deadlines";
import {
  showDetailsCommandSchema,
  showDetailsResultSchema,
  type ShowDetailsCommand,
  type ShowDetailsResult,
  type ShowDetailsSnapshot,
} from "@/lib/show-details-contract";
import { formatTimeInput } from "@/lib/utils";

export type ShowDetailsDraft = Omit<
  ShowDetailsCommand,
  "orgId" | "userId" | "requestId" | "showId"
>;
type Attempt =
  | { kind: "saving" | "reviewing"; command: ShowDetailsCommand }
  | { kind: "unconfirmed"; command: ShowDetailsCommand; message: string }
  | {
      kind: "settled";
      command: ShowDetailsCommand;
      result: ShowDetailsResult;
      refresh: "idle" | "pending" | "failed";
      message?: string;
    };
type Work = {
  draft: ShowDetailsDraft;
  attempt: Attempt | null;
  notice: string | null;
};
export function draftFromSnapshot(
  snapshot: ShowDetailsSnapshot,
  timeZone: string,
): ShowDetailsDraft {
  return {
    serviceDate: snapshot.serviceDate,
    expectedUpdatedAt: snapshot.updatedAt,
    name: snapshot.name,
    location: snapshot.location,
    startTime: formatTimeInput(snapshot.scheduledStartTime, timeZone),
    callTime: formatTimeInput(snapshot.scheduledCallTime, timeZone),
    timeZone,
  };
}
export function useShowDetails(
  scope: { orgId: string; userId: string; showId: string },
  initialDraft: ShowDetailsDraft,
  options: {
    refresh: (signal: AbortSignal) => Promise<void>;
    onRefreshed: () => void;
  },
) {
  const client = useQueryClient(),
    key = ["show-details", scope.userId, scope.orgId, scope.showId],
    hash = hashKey(key);
  // Refreshed props never erase an unsaved draft or replace its original version.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initial = useMemo<Work>(
    () => ({ draft: initialDraft, attempt: null, notice: null }),
    [hash],
  );
  useQuery({
    queryKey: key,
    queryFn: () => initial,
    initialData: initial,
    enabled: false,
    gcTime: Infinity,
  });
  const read = () => client.getQueryData<Work>(key);
  const work = useSyncExternalStore(
    useCallback(
      (notify) =>
        client.getQueryCache().subscribe((event) => {
          if (event.query.queryHash === hash) notify();
        }),
      [client, hash],
    ),
    () => read() ?? initial,
    () => initial,
  );
  const owner = useMemo(
    () => ({ mounted: false, refresh: null as AbortController | null }),
    [hash],
  );
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const active = () => owner.mounted && currentOwner.current === owner;
  useEffect(() => {
    owner.mounted = true;
    return () => {
      owner.mounted = false;
      owner.refresh?.abort();
    };
  }, [owner]);
  function changeDraft(update: Partial<ShowDetailsDraft>) {
    const current = read();
    if (current && !current.attempt)
      client.setQueryData(key, {
        ...current,
        draft: { ...current.draft, ...update },
        notice: null,
      });
  }
  async function refreshSaved() {
    const current = read();
    if (
      !current ||
      current.attempt?.kind !== "settled" ||
      current.attempt.refresh === "pending" ||
      !["applied", "superseded"].includes(current.attempt.result.outcome) ||
      !current.attempt.result.snapshot
    )
      return;
    const pending: Work = {
      ...current,
      attempt: { ...current.attempt, refresh: "pending", message: undefined },
    };
    const claim = client.setQueryData<Work>(key, pending);
    const controller = new AbortController();
    owner.refresh = controller;
    try {
      await runRouteLoad(
        (child) => options.refresh(child.signal),
        controller.signal,
        12_000,
      );
      if (read() !== claim) return;
      client.setQueryData<Work>(key, {
        draft: draftFromSnapshot(
          current.attempt.result.snapshot,
          current.draft.timeZone ?? "UTC",
        ),
        attempt: null,
        notice: null,
      });
      if (active() && !controller.signal.aborted) options.onRefreshed();
    } catch (error) {
      if (read() === claim)
        client.setQueryData<Work>(key, {
          ...current,
          attempt: {
            ...current.attempt,
            refresh: "failed",
            message:
              error instanceof Error
                ? error.message === "Page loading timed out."
                  ? "Refreshing the saved show timed out."
                  : error.message
                : "Could not refresh the saved show.",
          },
        });
    } finally {
      if (owner.refresh === controller) owner.refresh = null;
    }
  }
  async function execute(
    command: ShowDetailsCommand,
    mode: "save" | "review",
    source: Work,
  ) {
    if (read() !== source) return;
    const pending: Work = {
      ...source,
      attempt: { kind: mode === "save" ? "saving" : "reviewing", command },
      notice: null,
    };
    const claim = client.setQueryData<Work>(key, pending);
    let issued = false;
    try {
      const result = showDetailsResultSchema.parse(
        await runRouteLoad(
          async (controller) => {
            const signal = controller.signal;
            const api = await import("@/lib/schedule");
            if (signal.aborted) throw signal.reason;
            issued = true;
            return mode === "save"
              ? api.saveServiceDetails({ data: command, signal })
              : api.reviewServiceDetails({ data: command, signal });
          },
          undefined,
          15_000,
        ),
      );
      if (
        result.requestId !== command.requestId ||
        result.showId !== command.showId
      )
        throw new Error(
          "The result belongs to a different show. Review the original request.",
        );
      if (read() !== claim) return;
      if (
        result.outcome === "cancelled" &&
        result.snapshot?.updatedAt === source.draft.expectedUpdatedAt
      ) {
        client.setQueryData<Work>(key, {
          ...source,
          attempt: null,
          notice:
            "The original save was cancelled. Your draft is ready to edit.",
        });
        return;
      }
      client.setQueryData<Work>(key, {
        ...source,
        attempt: { kind: "settled", command, result, refresh: "idle" },
        notice: null,
      });
      if (result.outcome === "applied" && mode === "save" && active())
        await refreshSaved();
    } catch (error) {
      if (read() !== claim) return;
      const message =
        error instanceof Error
          ? error.message === "Page loading timed out."
            ? mode === "save"
              ? "The save response timed out."
              : "Review of the original save timed out."
            : error.message
          : "Could not confirm this save. Retry it or review the request before editing.";
      client.setQueryData<Work>(
        key,
        !issued && !source.attempt
          ? { ...source, attempt: null, notice: message }
          : { ...source, attempt: { kind: "unconfirmed", command, message } },
      );
    }
  }
  function save() {
    const current = read();
    if (!current || current.attempt) return;
    const parsed = showDetailsCommandSchema.safeParse({
      ...current.draft,
      ...scope,
      requestId: crypto.randomUUID(),
    });
    if (!parsed.success) {
      client.setQueryData(key, {
        ...current,
        notice: parsed.error.issues[0]?.message ?? "Check the show details.",
      });
      return;
    }
    return execute(parsed.data, "save", current);
  }
  function retry() {
    const current = read();
    if (current?.attempt?.kind === "unconfirmed")
      return execute(current.attempt.command, "save", current);
  }
  function review() {
    const current = read();
    if (current?.attempt?.kind === "unconfirmed")
      return execute(current.attempt.command, "review", current);
  }
  function editCurrent(keepDraft: boolean) {
    const current = read();
    if (
      !current ||
      current.attempt?.kind !== "settled" ||
      current.attempt.refresh === "pending" ||
      !current.attempt.result.snapshot
    )
      return;
    const snapshot = current.attempt.result.snapshot;
    client.setQueryData<Work>(key, {
      draft: keepDraft
        ? {
            ...current.draft,
            expectedUpdatedAt: snapshot.updatedAt,
            serviceDate: snapshot.serviceDate,
          }
        : draftFromSnapshot(snapshot, current.draft.timeZone ?? "UTC"),
      attempt: null,
      notice: keepDraft
        ? "Your edits are retained against the reviewed version. Save to apply them."
        : "Current show details loaded. Your next save will be a new request.",
    });
  }
  return {
    ...work,
    changeDraft,
    save,
    retry,
    review,
    refreshSaved,
    editCurrent,
  };
}
