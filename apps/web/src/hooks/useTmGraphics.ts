import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { getTmGraphicsState, writeTmGraphicsClear } from "@/lib/tm-graphics";
import {
  graphicsClearCommandSchema,
  graphicsClearResultSchema,
  graphicsClearSnapshotSchema,
  type GraphicsClearCommand,
  type GraphicsClearSnapshot,
} from "@/lib/graphics-clear-contract";
import { withOperationTimeout } from "@/lib/operation-timeout";
export function useTmGraphics(orgId: string, userId: string) {
  const client = useQueryClient(),
    queryKey = ["tm-graphics-state", orgId, userId],
    mutationKey = ["tm-graphics-clear", orgId, userId];
  const read = useQuery<GraphicsClearSnapshot>({
    queryKey,
    retry: false,
    networkMode: "always",
    refetchIntervalInBackground: false,
    refetchInterval: (query) =>
      query.state.status === "error" ? false : 2_000,
    queryFn: async ({ signal }) => {
      const controller = new AbortController(),
        abort = () => controller.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      try {
        return graphicsClearSnapshotSchema.parse(
          await withOperationTimeout(
            getTmGraphicsState({ data: { orgId }, signal: controller.signal }),
            8_000,
            "Graphics feedback could not be confirmed. The last confirmed state is retained.",
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
      const command = graphicsClearCommandSchema.safeParse(
          mutation.state.variables,
        ),
        result = graphicsClearResultSchema.safeParse(mutation.state.data);
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
    mutationFn: async (command: GraphicsClearCommand) => {
      const controller = new AbortController();
      try {
        return graphicsClearResultSchema.parse(
          await withOperationTimeout(
            writeTmGraphicsClear({ data: command, signal: controller.signal }),
            10_000,
            "Clear was not confirmed on every output. Retry the original request to recover its result without clearing newer graphics.",
          ),
        );
      } finally {
        controller.abort();
      }
    },
    onMutate: () => {
      for (const old of client
        .getMutationCache()
        .findAll({ mutationKey, exact: true }))
        if (old.state.status !== "pending")
          client.getMutationCache().remove(old);
    },
    onSettled: () => {
      void client
        .cancelQueries({ queryKey })
        .then(() => client.invalidateQueries({ queryKey }));
    },
  });
  const busy = () =>
    client
      .getMutationCache()
      .findAll({ mutationKey, exact: true })
      .some((mutation) => mutation.state.status === "pending");
  return {
    read,
    latest,
    pending,
    unfinished,
    send: (command: GraphicsClearCommand) => {
      if (!busy() && !unfinished && !read.isError) mutation.mutate(command);
    },
    retry: () => {
      if (unfinished && !busy()) mutation.mutate(unfinished);
    },
  };
}
