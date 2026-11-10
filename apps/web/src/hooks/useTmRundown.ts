import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { getTmRundownState, writeTmRundown } from "@/lib/tm-rundown";
import {
  tmRundownCommandSchema,
  tmRundownResultSchema,
  tmRundownSnapshotSchema,
  type TmRundownCommand,
  type TmRundownSnapshot,
} from "@/lib/tm-rundown-contract";
import { withOperationTimeout } from "@/lib/operation-timeout";
export function useTmRundown(orgId: string, userId: string) {
  const client = useQueryClient(),
    queryKey = ["tm-rundown-state", orgId, userId],
    mutationKey = ["tm-rundown-command", orgId, userId];
  const read = useQuery<TmRundownSnapshot>({
    queryKey,
    retry: false,
    networkMode: "always",
    refetchInterval: (query) =>
      query.state.status === "error" ? false : 2_000,
    queryFn: async ({ signal }) => {
      const controller = new AbortController(),
        abort = () => controller.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      try {
        return tmRundownSnapshotSchema.parse(
          await withOperationTimeout(
            getTmRundownState({ data: { orgId }, signal: controller.signal }),
            8_000,
            "Current rundown feedback could not be confirmed. The last confirmed state is retained.",
          ),
        );
      } finally {
        signal.removeEventListener("abort", abort);
        controller.abort();
      }
    },
  });
  const history = useMutationState({
    filters: { mutationKey, exact: true },
    select: (mutation) => {
      const command = tmRundownCommandSchema.safeParse(
          mutation.state.variables,
        ),
        result = tmRundownResultSchema.safeParse(mutation.state.data);
      return {
        command: command.success ? command.data : null,
        result: result.success ? result.data : null,
        status: mutation.state.status,
        error: mutation.state.error,
        at: mutation.state.submittedAt,
      };
    },
  });
  const latest = history.at(-1),
    pending = latest?.status === "pending",
    unfinished =
      latest?.command && (pending || latest.status === "error")
        ? latest.command
        : null;
  const mutation = useMutation({
    mutationKey,
    retry: false,
    networkMode: "always",
    gcTime: Infinity,
    mutationFn: async (command: TmRundownCommand) => {
      const controller = new AbortController();
      try {
        return tmRundownResultSchema.parse(
          await withOperationTimeout(
            writeTmRundown({ data: command, signal: controller.signal }),
            10_000,
            "Rundown command was not confirmed. Retry the same request to recover its result.",
          ),
        );
      } finally {
        controller.abort();
      }
    },
    onSuccess: () => {
      void client
        .cancelQueries({ queryKey })
        .then(() => client.invalidateQueries({ queryKey }));
    },
    onSettled: () => {
      for (const old of client
        .getMutationCache()
        .findAll({ mutationKey, exact: true }))
        if (old.state.status !== "pending")
          client.getMutationCache().remove(old);
    },
  });
  const busy = () =>
    client
      .getMutationCache()
      .findAll({ mutationKey, exact: true })
      .some((m) => m.state.status === "pending");
  return {
    read,
    latest,
    pending,
    unfinished,
    send: (command: TmRundownCommand) => {
      if (!busy() && !unfinished && !read.isError) mutation.mutate(command);
    },
    retry: () => {
      if (unfinished && !busy()) mutation.mutate(unfinished);
    },
  };
}
