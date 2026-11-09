import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { z } from "zod";
import {
  commandTmManagement,
  getTmManagementState,
  retryTmNotifications,
  reviewTmManagement,
} from "@/lib/tm-management";
import {
  tmManagementCommandSchema,
  tmManagementResultSchema,
  tmManagementStateSchema,
  type TmManagementCommand,
  type TmManagementResult,
  type TmManagementState,
} from "@/lib/tm-management-contract";
import { withOperationTimeout } from "@/lib/operation-timeout";
const attemptSchema = z.object({
  command: tmManagementCommandSchema,
  label: z.string(),
  mode: z.enum(["write", "review"]),
});
type Attempt = z.infer<typeof attemptSchema>;
type Lane = "layout" | "incident";
const laneOf = (attempt: Attempt): Lane =>
  attempt.command.operation.kind === "layout" ? "layout" : "incident";
async function bounded<T>(
  run: (signal: AbortSignal) => Promise<T>,
  message: string,
  signal?: AbortSignal,
  ms = 10_000,
) {
  const controller = new AbortController(),
    abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    return await withOperationTimeout(run(controller.signal), ms, message);
  } finally {
    signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}
export function useTmManagement(
  initial: TmManagementState,
  onIncident: (id: string) => void,
) {
  const client = useQueryClient(),
    scope = { orgId: initial.orgId, userId: initial.userId };
  const queryKey = ["tm-management-state", scope.orgId, scope.userId],
    mutationKey = ["tm-management-change", scope.orgId, scope.userId];
  const read = useQuery({
    queryKey,
    initialData: initial,
    retry: false,
    networkMode: "always",
    refetchIntervalInBackground: false,
    refetchInterval: (query) =>
      query.state.status === "error" ? false : 10_000,
    queryFn: ({ signal }) =>
      bounded(
        async (signal) =>
          tmManagementStateSchema.parse(
            await getTmManagementState({ data: scope, signal }),
          ),
        "Dashboard controls could not refresh. Last confirmed values are retained.",
        signal,
        8_000,
      ),
  });
  const cache = client.getMutationCache();
  const records = () => cache.findAll({ mutationKey, exact: true });
  const unresolved = (lane: Lane) =>
    records().some((item) => {
      const parsed = attemptSchema.safeParse(item.state.variables);
      if (!parsed.success || laneOf(parsed.data) !== lane) return false;
      const result = tmManagementResultSchema.safeParse(item.state.data);
      return (
        item.state.status === "pending" ||
        item.state.status === "error" ||
        (result.success && result.data.outcome !== "applied")
      );
    });
  const history = useMutationState({
    filters: { mutationKey, exact: true },
    select: (item) => {
      const attempt = attemptSchema.safeParse(item.state.variables),
        result = tmManagementResultSchema.safeParse(item.state.data);
      return {
        attempt: attempt.success ? attempt.data : null,
        result: result.success ? result.data : null,
        status: item.state.status,
        error: item.state.error,
      };
    },
  });
  const accept = (snapshot: TmManagementState) => {
    client.setQueryData<TmManagementState>(queryKey, (previous) =>
      previous && previous.layoutRevision > snapshot.layoutRevision
        ? previous
        : snapshot,
    );
    void client
      .cancelQueries({ queryKey })
      .then(() => client.invalidateQueries({ queryKey }));
  };
  const mutation = useMutation({
    mutationKey,
    retry: false,
    networkMode: "always",
    gcTime: Infinity,
    mutationFn: (attempt: Attempt): Promise<TmManagementResult> =>
      bounded(
        async (signal) =>
          tmManagementResultSchema.parse(
            await (
              attempt.mode === "review"
                ? reviewTmManagement
                : commandTmManagement
            )({ data: attempt.command, signal }),
          ),
        "The change was not confirmed. Retry to recover its result, or review it before continuing.",
      ),
    onMutate: (attempt) => {
      for (const old of records()) {
        const parsed = attemptSchema.safeParse(old.state.variables);
        if (
          parsed.success &&
          laneOf(parsed.data) === laneOf(attempt) &&
          old.state.status !== "pending"
        )
          cache.remove(old);
      }
    },
    onSuccess: (result, attempt) => {
      accept(result.snapshot);
      if (attempt.command.operation.kind !== "layout")
        onIncident(attempt.command.operation.id);
    },
  });
  const notifications = useMutation({
    retry: false,
    networkMode: "always",
    mutationFn: () =>
      bounded(
        async (signal) =>
          tmManagementStateSchema.parse(
            await retryTmNotifications({ data: scope, signal }),
          ),
        "Notification delivery could not be confirmed. Retry notifications.",
      ),
    onSuccess: accept,
  });
  const pending = (lane: Lane) =>
    records().some((item) => {
      const parsed = attemptSchema.safeParse(item.state.variables);
      return (
        parsed.success &&
        laneOf(parsed.data) === lane &&
        item.state.status === "pending"
      );
    });
  const latest = (lane: Lane) =>
    history
      .filter((item) => item.attempt && laneOf(item.attempt) === lane)
      .at(-1);
  const dismiss = (lane: Lane) => {
    for (const item of records()) {
      const parsed = attemptSchema.safeParse(item.state.variables);
      if (
        parsed.success &&
        laneOf(parsed.data) === lane &&
        item.state.status === "success"
      )
        cache.remove(item);
    }
  };
  const send = (
    operation: TmManagementCommand["operation"],
    label: string,
    replaceReviewed = false,
  ) => {
    const lane = operation.kind === "layout" ? "layout" : "incident",
      current = client.getQueryState(queryKey);
    if (
      pending(lane) ||
      (unresolved(lane) &&
        !(replaceReviewed && latest(lane)?.status === "success")) ||
      current?.status !== "success" ||
      current.fetchStatus === "fetching"
    )
      return false;
    mutation.mutate({
      command: {
        ...scope,
        requestId: crypto.randomUUID(),
        expiresAt:
          read.data.serverTime +
          Math.max(0, Date.now() - (current.dataUpdatedAt ?? Date.now())) +
          25_000,
        operation,
      },
      label,
      mode: "write",
    });
    return true;
  };
  const recover = (lane: Lane, mode?: "review") => {
    const item = latest(lane);
    if (!item?.attempt || pending(lane)) return;
    mutation.mutate({ ...item.attempt, mode: mode ?? item.attempt.mode });
  };
  const layoutAttempt = latest("layout");
  const retained = layoutAttempt?.attempt?.command.operation;
  const layout =
    retained?.kind === "layout" &&
    (layoutAttempt?.status !== "success" ||
      layoutAttempt?.result?.outcome !== "applied")
      ? retained.layout
      : read.data.layout;
  return {
    read,
    layout,
    latest,
    send,
    recover,
    dismiss,
    unresolved,
    notifications,
    unavailable: read.isError || read.isFetching,
  };
}
export type TmManagementController = ReturnType<typeof useTmManagement>;
